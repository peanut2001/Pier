/**
 * Pier Relay: forwards end-to-end encrypted channel frames between devices and Pier hosts
 * that cannot reach each other directly, and answers STUN so they can try a peer-to-peer
 * path first. See `packages/crypto/src/relay.ts` for the wire format.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
	createRelayChallenge,
	equalBytes,
	fromBase64Url,
	type IceServer,
	RELAY_CLOSE,
	RELAY_PROTOCOL_VERSION,
	type RelayErrorCode,
	type RelayMode,
	type RelayRegisterMessage,
	type RelayServerMessage,
	toBase64Url,
	utf8Encode,
} from "@pier/crypto";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { type StunServer, startStunServer } from "./stun.ts";

export const RELAY_VERSION = "0.2.22";

export interface RelayServerOptions {
	/** TCP port for HTTP / WebSocket (default 7480; 0 picks a free port). */
	port?: number;
	/** Interface to bind (default: all). */
	host?: string;
	/** `private` (hosts need a token) or `open` (any host may register). */
	mode: RelayMode;
	/** Access tokens accepted from hosts in private mode. */
	tokens?: string[];
	/** UDP port of the built-in STUN server (default 3478; `false` turns it off). */
	stunPort?: number | false;
	/**
	 * Name or IP clients reach this server at, for the STUN URL announced to hosts. By default
	 * the `Host` header of each host's connection is used.
	 */
	publicHost?: string;
	/** More STUN / TURN servers to announce to hosts (e.g. a public STUN server). */
	iceServers?: IceServer[];
	/** Registered hosts at most (default 10 000 in private mode, 1000 in open mode). */
	maxHosts?: number;
	/** Concurrent device connections per host (default 32). */
	maxStreamsPerHost?: number;
	/** Connection attempts per client IP per minute (default 120). */
	connectsPerMinute?: number;
	/** Bytes per second per connection and direction, 0 for no limit (default: 0 private, 2 MiB/s open). */
	bytesPerSecond?: number;
	/** Take the client address from `X-Forwarded-For` / `X-Real-IP` (behind a reverse proxy). */
	trustProxy?: boolean;
	/** How long a host has to pick up a device connection (default 10 s). */
	acceptTimeoutMs?: number;
	/** Ping interval for dead-connection detection (default 30 s). */
	heartbeatMs?: number;
	log?: (message: string) => void;
}

export interface RelayServer {
	/** `ws://host:port` of the listener. */
	url: string;
	port: number;
	/** UDP port of the STUN server, if running. */
	stunPort: number | undefined;
	stats(): { hosts: number; streams: number };
	close(): Promise<void>;
}

/** Frames up to the Pier limit (64 MiB) plus base64 and JSON overhead. */
const MAX_PAYLOAD = 96 * 1024 * 1024;
/** Control messages on `/v1/host` are tiny. */
const MAX_CONTROL_PAYLOAD = 16 * 1024;
/** What a device may send before its host picked up the connection (the handshake hello). */
const MAX_EARLY_BYTES = 256 * 1024;
/** Pause the sending side while the other side has this much queued. */
const HIGH_WATER = 8 * 1024 * 1024;
const REGISTER_TIMEOUT_MS = 10_000;

interface HostEntry {
	key: string;
	socket: WebSocket;
	address: string;
	host: string | undefined;
	streams: Set<Stream>;
}

interface Stream {
	id: string;
	host: HostEntry;
	device: WebSocket;
	hostSocket?: WebSocket;
	early: Array<{ data: RawData; isBinary: boolean }>;
	earlyBytes: number;
	timer: ReturnType<typeof setTimeout>;
	closed: boolean;
}

function constantTimeEqual(a: string, b: string): boolean {
	return equalBytes(utf8Encode(a), utf8Encode(b));
}

/** Close codes that may be sent in a close frame; others are replaced. */
function sendableCode(code: number): number {
	if (code === 1000 || code === 1001 || (code >= 1002 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
	if (code >= 3000 && code <= 4999) return code;
	return 1001;
}

function closeQuietly(socket: WebSocket | undefined, code: number, reason: string): void {
	if (!socket) return;
	try {
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
			socket.close(sendableCode(code), reason.slice(0, 120));
		}
	} catch {
		socket.terminate();
	}
}

function refuseUpgrade(socket: Socket, status: number, message: string): void {
	try {
		socket.write(
			`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
		);
	} catch {
		// Ignore.
	}
	socket.destroy();
}

/** Per-key event counter over a sliding minute. */
class RateLimiter {
	private readonly hits = new Map<string, number[]>();
	private readonly sweep: ReturnType<typeof setInterval>;

	constructor(private readonly perMinute: number) {
		this.sweep = setInterval(() => {
			const cutoff = Date.now() - 60_000;
			for (const [key, times] of this.hits) {
				const kept = times.filter((t) => t > cutoff);
				if (kept.length) this.hits.set(key, kept);
				else this.hits.delete(key);
			}
		}, 60_000);
		this.sweep.unref?.();
	}

	allow(key: string): boolean {
		if (this.perMinute <= 0) return true;
		const now = Date.now();
		const times = (this.hits.get(key) ?? []).filter((t) => t > now - 60_000);
		if (times.length >= this.perMinute) {
			this.hits.set(key, times);
			return false;
		}
		times.push(now);
		this.hits.set(key, times);
		return true;
	}

	stop(): void {
		clearInterval(this.sweep);
	}
}

/** Pipe messages from `from` to `to` with backpressure and an optional rate limit. */
function pipe(from: WebSocket, to: WebSocket, bytesPerSecond: number): void {
	let windowStart = Date.now();
	let windowBytes = 0;
	let paused = false;
	let throttle: ReturnType<typeof setTimeout> | undefined;
	const resume = () => {
		if (!paused) return;
		if (to.bufferedAmount > HIGH_WATER / 2) return;
		if (throttle) return;
		paused = false;
		from.resume();
	};
	from.on("message", (data, isBinary) => {
		if (to.readyState !== WebSocket.OPEN) return;
		const size = Array.isArray(data)
			? data.reduce((n, b) => n + b.length, 0)
			: (data as Buffer | ArrayBuffer).byteLength;
		to.send(data, { binary: isBinary }, () => resume());
		if (bytesPerSecond > 0) {
			const now = Date.now();
			if (now - windowStart >= 1000) {
				windowStart = now;
				windowBytes = 0;
			}
			windowBytes += size;
			if (windowBytes > bytesPerSecond && !throttle) {
				paused = true;
				from.pause();
				throttle = setTimeout(
					() => {
						throttle = undefined;
						windowStart = Date.now();
						windowBytes = 0;
						resume();
					},
					Math.max(10, 1000 - (now - windowStart)),
				);
			}
		}
		if (to.bufferedAmount > HIGH_WATER && !paused) {
			paused = true;
			from.pause();
		}
	});
	from.on("close", () => {
		if (throttle) clearTimeout(throttle);
	});
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
	const log = options.log ?? (() => {});
	const mode = options.mode;
	const tokens = (options.tokens ?? []).map((t) => t.trim()).filter(Boolean);
	if (mode === "private" && !tokens.length) throw new Error("Private mode needs at least one access token");
	const maxHosts = options.maxHosts ?? (mode === "open" ? 1000 : 10_000);
	const maxStreams = options.maxStreamsPerHost ?? 32;
	const bytesPerSecond = options.bytesPerSecond ?? (mode === "open" ? 2 * 1024 * 1024 : 0);
	const acceptTimeoutMs = options.acceptTimeoutMs ?? 10_000;
	const limiter = new RateLimiter(options.connectsPerMinute ?? 120);
	const hosts = new Map<string, HostEntry>();
	const pending = new Map<string, Stream>();
	let streamCount = 0;

	const stun: StunServer | undefined =
		options.stunPort === false ? undefined : await startStunServer({ port: options.stunPort ?? 3478 });

	const clientAddress = (req: IncomingMessage): string => {
		if (options.trustProxy) {
			const forwarded = String(req.headers["x-forwarded-for"] ?? "")
				.split(",")[0]
				?.trim();
			const real = String(req.headers["x-real-ip"] ?? "").trim();
			if (forwarded) return forwarded;
			if (real) return real;
		}
		return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
	};

	/** STUN URL for a host that reached us at `hostHeader`. */
	const iceServersFor = (hostHeader: string | undefined): IceServer[] => {
		const servers: IceServer[] = [];
		if (stun) {
			const name = options.publicHost ?? hostHeader?.replace(/:\d+$/, "");
			if (name) servers.push({ urls: `stun:${name}:${stun.port}` });
		}
		return [...servers, ...(options.iceServers ?? [])];
	};

	const server: Server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		if (path.endsWith("/health")) {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify({ ok: true, service: "pier-relay", version: RELAY_VERSION, mode }));
			return;
		}
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(`Pier Relay ${RELAY_VERSION} (${mode} mode)\n`);
	});
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
	const controlWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_CONTROL_PAYLOAD });

	// ---- heartbeat ---------------------------------------------------------------------------
	const alive = new WeakSet<WebSocket>();
	const heartbeat = setInterval(() => {
		for (const socket of [...wss.clients, ...controlWss.clients]) {
			if (!alive.has(socket)) {
				socket.terminate();
				continue;
			}
			alive.delete(socket);
			try {
				socket.ping();
			} catch {
				// Closing.
			}
		}
	}, options.heartbeatMs ?? 30_000);
	heartbeat.unref?.();
	const track = (socket: WebSocket) => {
		alive.add(socket);
		socket.on("pong", () => alive.add(socket));
	};

	// ---- hosts ----------------------------------------------------------------------------
	const sendControl = (socket: WebSocket, message: RelayServerMessage) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	};
	const refuseHost = (socket: WebSocket, code: RelayErrorCode, message: string, closeCode: number) => {
		sendControl(socket, { t: "error", code, message });
		closeQuietly(socket, closeCode, code);
	};

	const onHost = (socket: WebSocket, req: IncomingMessage) => {
		track(socket);
		const address = clientAddress(req);
		const challenge = createRelayChallenge();
		let entry: HostEntry | undefined;
		const timer = setTimeout(() => {
			if (!entry) refuseHost(socket, "BAD_REQUEST", "Registration timed out", RELAY_CLOSE.badRequest);
		}, REGISTER_TIMEOUT_MS);
		timer.unref?.();
		sendControl(socket, {
			t: "challenge",
			v: RELAY_PROTOCOL_VERSION,
			mode,
			nonce: challenge.nonce,
			ek: challenge.ek,
		});
		socket.on("message", (data, isBinary) => {
			if (entry || isBinary) return;
			let message: Partial<RelayRegisterMessage>;
			try {
				message = JSON.parse(data.toString()) as Partial<RelayRegisterMessage>;
			} catch {
				refuseHost(socket, "BAD_REQUEST", "Malformed message", RELAY_CLOSE.badRequest);
				return;
			}
			if (message.t !== "register" || typeof message.pk !== "string" || typeof message.proof !== "string") {
				refuseHost(socket, "BAD_REQUEST", "Expected register", RELAY_CLOSE.badRequest);
				return;
			}
			if (message.v !== RELAY_PROTOCOL_VERSION) {
				refuseHost(socket, "UNSUPPORTED_VERSION", "Unsupported relay protocol version", RELAY_CLOSE.badRequest);
				return;
			}
			if (mode === "private") {
				const token = typeof message.token === "string" ? message.token : "";
				if (!token || !tokens.some((t) => constantTimeEqual(t, token))) {
					log(`host from ${address}: wrong access token`);
					refuseHost(socket, "UNAUTHORIZED", "Wrong or missing access token", RELAY_CLOSE.unauthorized);
					return;
				}
			}
			const key = challenge.verify(message.pk, message.proof);
			if (!key) {
				refuseHost(socket, "UNAUTHORIZED", "Key proof failed", RELAY_CLOSE.unauthorized);
				return;
			}
			const id = toBase64Url(key);
			const previous = hosts.get(id);
			if (!previous && hosts.size >= maxHosts) {
				refuseHost(socket, "LIMIT", "Too many hosts on this relay", RELAY_CLOSE.limit);
				return;
			}
			clearTimeout(timer);
			if (previous) {
				hosts.delete(id);
				closeQuietly(previous.socket, RELAY_CLOSE.replaced, "Replaced by a newer connection");
			}
			entry = {
				key: id,
				socket,
				address,
				host: req.headers.host,
				streams: previous?.streams ?? new Set(),
			};
			for (const stream of entry.streams) stream.host = entry;
			hosts.set(id, entry);
			sendControl(socket, { t: "registered", mode, iceServers: iceServersFor(req.headers.host) });
			log(`host ${id.slice(0, 8)}… registered from ${address} (${hosts.size} online)`);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			if (entry && hosts.get(entry.key) === entry) {
				hosts.delete(entry.key);
				// Device connections waiting for this host cannot be picked up any more.
				for (const stream of [...entry.streams]) {
					if (!stream.hostSocket) endStream(stream, RELAY_CLOSE.hostOffline, "HOST_OFFLINE");
				}
				log(`host ${entry.key.slice(0, 8)}… went offline (${hosts.size} online)`);
			}
		});
		socket.on("error", () => {});
	};

	// ---- device streams -------------------------------------------------------------------
	const endStream = (stream: Stream, code: number, reason: string) => {
		if (stream.closed) return;
		stream.closed = true;
		clearTimeout(stream.timer);
		pending.delete(stream.id);
		stream.host.streams.delete(stream);
		streamCount -= 1;
		closeQuietly(stream.device, code, reason);
		closeQuietly(stream.hostSocket, code, reason);
	};

	const onDevice = (socket: WebSocket, req: IncomingMessage, host: HostEntry) => {
		track(socket);
		const id = toBase64Url(randomBytes(18));
		const stream: Stream = {
			id,
			host,
			device: socket,
			early: [],
			earlyBytes: 0,
			closed: false,
			timer: setTimeout(() => endStream(stream, RELAY_CLOSE.acceptTimeout, "ACCEPT_TIMEOUT"), acceptTimeoutMs),
		};
		stream.timer.unref?.();
		streamCount += 1;
		host.streams.add(stream);
		pending.set(id, stream);
		const early = (data: RawData, isBinary: boolean) => {
			if (stream.hostSocket) return;
			const size = (data as Buffer).byteLength ?? 0;
			stream.earlyBytes += size;
			if (stream.earlyBytes > MAX_EARLY_BYTES) {
				endStream(stream, RELAY_CLOSE.limit, "Too much data before the host answered");
				return;
			}
			stream.early.push({ data, isBinary });
		};
		socket.on("message", early);
		socket.on("close", (code, reason) => {
			if (stream.closed) return;
			stream.closed = true;
			clearTimeout(stream.timer);
			pending.delete(id);
			stream.host.streams.delete(stream);
			streamCount -= 1;
			closeQuietly(stream.hostSocket, code, reason.toString());
		});
		socket.on("error", () => {});
		sendControl(host.socket, { t: "incoming", id, addr: clientAddress(req) });
	};

	const onAccept = (socket: WebSocket, stream: Stream) => {
		track(socket);
		pending.delete(stream.id);
		clearTimeout(stream.timer);
		stream.hostSocket = socket;
		for (const { data, isBinary } of stream.early.splice(0)) socket.send(data, { binary: isBinary });
		stream.earlyBytes = 0;
		pipe(stream.device, socket, bytesPerSecond);
		pipe(socket, stream.device, bytesPerSecond);
		socket.on("close", (code, reason) => {
			if (stream.closed) return;
			stream.closed = true;
			stream.host.streams.delete(stream);
			streamCount -= 1;
			closeQuietly(stream.device, code, reason.toString());
		});
		socket.on("error", () => {});
	};

	server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
		socket.on("error", () => {});
		const [rawPath = "/", query = ""] = (req.url ?? "/").split("?");
		const path = rawPath.replace(/\/+$/, "");
		const params = new URLSearchParams(query);
		const address = clientAddress(req);
		if (path.endsWith("/v1/host")) {
			if (!limiter.allow(`h:${address}`)) return refuseUpgrade(socket, 429, "Too Many Requests");
			controlWss.handleUpgrade(req, socket, head, (ws) => onHost(ws, req));
			return;
		}
		if (path.endsWith("/v1/connect")) {
			if (!limiter.allow(`d:${address}`)) return refuseUpgrade(socket, 429, "Too Many Requests");
			const key = params.get("host") ?? "";
			let valid = false;
			try {
				valid = fromBase64Url(key).length === 32;
			} catch {
				valid = false;
			}
			if (!valid) return refuseUpgrade(socket, 400, "Bad Request");
			const host = hosts.get(key);
			if (!host) return refuseUpgrade(socket, 404, "Host Offline");
			if (host.streams.size >= maxStreams) return refuseUpgrade(socket, 503, "Too Many Connections");
			wss.handleUpgrade(req, socket, head, (ws) => onDevice(ws, req, host));
			return;
		}
		if (path.endsWith("/v1/accept")) {
			const stream = pending.get(params.get("id") ?? "");
			if (!stream || stream.closed) return refuseUpgrade(socket, 404, "Not Found");
			// Only the host that was told about the connection can pick it up: the id is secret,
			// random and only sent over its authenticated control socket.
			pending.delete(stream.id);
			wss.handleUpgrade(req, socket, head, (ws) => {
				if (stream.closed) {
					closeQuietly(ws, 1001, "Device went away");
					return;
				}
				onAccept(ws, stream);
			});
			return;
		}
		refuseUpgrade(socket, 404, "Not Found");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 7480, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	let closing: Promise<void> | undefined;
	const shown = options.host && options.host !== "::" && options.host !== "0.0.0.0" ? options.host : "127.0.0.1";
	log(
		`listening on port ${port} (${mode} mode${stun ? `, STUN on udp ${stun.port}` : ""}${bytesPerSecond ? `, ${bytesPerSecond} B/s per connection` : ""})`,
	);

	return {
		url: `ws://${shown.includes(":") ? `[${shown}]` : shown}:${port}`,
		port,
		stunPort: stun?.port,
		stats: () => ({ hosts: hosts.size, streams: streamCount }),
		close: async () => {
			if (closing) return closing;
			closing = shutdown();
			return closing;
		},
	};

	async function shutdown(): Promise<void> {
		clearInterval(heartbeat);
		limiter.stop();
		for (const socket of [...wss.clients, ...controlWss.clients]) socket.terminate();
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
		await stun?.close();
	}
}
