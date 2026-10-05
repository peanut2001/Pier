import {
	type IceServer,
	type KeyPair,
	RELAY_CLOSE,
	RELAY_PROTOCOL_VERSION,
	type RelayMode,
	type RelayRegisterMessage,
	type RelayServerMessage,
	relayRegisterProof,
	toBase64Url,
} from "@pier/crypto";
import { WebSocket } from "ws";

export type RelayState = "off" | "connecting" | "online" | "error";

/** Largest frame through a relay (images travel inline), as on the LAN listener. */
const MAX_RELAY_PAYLOAD = 64 * 1024 * 1024;

export interface RelayClientOptions {
	/** Normalized relay URL (`ws://` / `wss://`). */
	url: string;
	token?: string;
	identity: KeyPair;
	/** A device connected through the relay: its socket to hand to the secure channel. */
	onIncoming(socket: WebSocket, info: { address?: string }): void;
	/** State, mode or ICE servers changed. */
	onChange(): void;
	log(message: string): void;
	/** Keepalive ping interval (default 25 s). */
	heartbeatMs?: number;
	/** Wait this long for the relay's challenge and answer (default 10 s). */
	handshakeTimeoutMs?: number;
}

/** Ping a socket regularly and drop it when two pings go unanswered. */
export function keepAlive(socket: WebSocket, intervalMs: number): void {
	let alive = true;
	socket.on("pong", () => {
		alive = true;
	});
	const timer = setInterval(() => {
		if (socket.readyState !== WebSocket.OPEN) return;
		if (!alive) {
			socket.terminate();
			return;
		}
		alive = false;
		try {
			socket.ping();
		} catch {
			// Closing.
		}
	}, intervalMs);
	timer.unref?.();
	socket.on("close", () => clearInterval(timer));
}

function relayErrorText(code: string, message: string): string {
	switch (code) {
		case "UNAUTHORIZED":
			return "The relay refused the access token";
		case "LIMIT":
			return `The relay is full: ${message}`;
		case "UNSUPPORTED_VERSION":
			return "The relay runs an incompatible version";
		default:
			return message || code;
	}
}

/**
 * The host's registration with a Pier Relay: a control WebSocket at `/v1/host` that proves
 * the host's static key, then announces device connections (`incoming`); each one is picked
 * up with a new socket at `/v1/accept`. Reconnects with backoff until stopped.
 */
export class RelayClient {
	state: RelayState = "connecting";
	error: string | undefined;
	mode: RelayMode | undefined;
	iceServers: IceServer[] = [];
	private socket: WebSocket | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private attempt = 0;
	private stopped = false;
	private readonly accepting = new Set<WebSocket>();

	constructor(private readonly options: RelayClientOptions) {
		this.connect();
	}

	get url(): string {
		return this.options.url;
	}

	private setState(state: RelayState, error?: string): void {
		if (this.state === state && this.error === error) return;
		this.state = state;
		this.error = error;
		this.options.onChange();
	}

	private connect(): void {
		if (this.stopped) return;
		this.setState("connecting", this.error);
		const socket = new WebSocket(`${this.options.url}/v1/host`, { perMessageDeflate: false, maxPayload: 64 * 1024 });
		this.socket = socket;
		let registered = false;
		let fatal: string | undefined;
		const timer = setTimeout(() => {
			if (!registered) {
				fatal = "The relay did not answer";
				socket.terminate();
			}
		}, this.options.handshakeTimeoutMs ?? 10_000);
		timer.unref?.();
		socket.on("message", (data, isBinary) => {
			if (isBinary) return;
			let message: RelayServerMessage;
			try {
				message = JSON.parse(data.toString()) as RelayServerMessage;
			} catch {
				return;
			}
			switch (message.t) {
				case "challenge": {
					if (message.v !== RELAY_PROTOCOL_VERSION) {
						fatal = "The relay runs an incompatible version";
						socket.close(1000);
						return;
					}
					let proof: string;
					try {
						proof = relayRegisterProof(this.options.identity, message);
					} catch {
						fatal = "Invalid relay challenge";
						socket.close(1000);
						return;
					}
					const register: RelayRegisterMessage = {
						t: "register",
						v: RELAY_PROTOCOL_VERSION,
						pk: toBase64Url(this.options.identity.publicKey),
						proof,
						...(this.options.token ? { token: this.options.token } : {}),
					};
					socket.send(JSON.stringify(register));
					return;
				}
				case "registered":
					clearTimeout(timer);
					registered = true;
					this.attempt = 0;
					this.mode = message.mode;
					this.iceServers = Array.isArray(message.iceServers) ? message.iceServers : [];
					keepAlive(socket, this.options.heartbeatMs ?? 25_000);
					this.options.log(`relay ${this.options.url}: online (${message.mode})`);
					this.setState("online");
					return;
				case "incoming":
					if (registered && typeof message.id === "string") {
						this.accept(message.id, typeof message.addr === "string" ? message.addr : undefined);
					}
					return;
				case "error":
					fatal = relayErrorText(String(message.code), String(message.message ?? ""));
					return;
			}
		});
		socket.on("error", (error) => {
			fatal ??= error.message;
		});
		socket.on("close", (code, reasonBuffer) => {
			clearTimeout(timer);
			if (this.socket === socket) this.socket = undefined;
			if (this.stopped) return;
			const reason = reasonBuffer.toString();
			const why =
				fatal ??
				(code === RELAY_CLOSE.replaced
					? "Another Pier with the same key registered at the relay"
					: code === RELAY_CLOSE.unauthorized
						? "The relay refused the access token"
						: registered
							? "Lost the connection to the relay"
							: `Could not reach the relay${reason ? `: ${reason}` : ""}`);
			this.options.log(`relay ${this.options.url}: ${why}`);
			this.setState("error", why);
			this.scheduleRetry(code === RELAY_CLOSE.unauthorized || code === RELAY_CLOSE.replaced);
		});
	}

	private scheduleRetry(slow: boolean): void {
		const delay = slow ? 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(this.attempt, 6));
		this.attempt += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.connect();
		}, delay);
		this.retryTimer.unref?.();
	}

	/** Reconnect now (e.g. the network came back). */
	retryNow(): void {
		if (this.stopped || this.socket) return;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.connect();
	}

	private accept(id: string, address: string | undefined): void {
		const socket = new WebSocket(`${this.options.url}/v1/accept?id=${encodeURIComponent(id)}`, {
			perMessageDeflate: false,
			maxPayload: MAX_RELAY_PAYLOAD,
		});
		this.accepting.add(socket);
		const forget = () => this.accepting.delete(socket);
		socket.once("open", () => {
			forget();
			if (this.stopped) {
				socket.close(1001, "Host shutting down");
				return;
			}
			keepAlive(socket, this.options.heartbeatMs ?? 25_000);
			this.options.onIncoming(socket, address ? { address } : {});
		});
		socket.once("error", (error) => {
			forget();
			this.options.log(`relay: could not pick up a connection: ${error.message}`);
		});
		socket.once("close", forget);
	}

	stop(): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		socket?.close(1000, "Relay turned off");
		for (const pending of this.accepting) pending.terminate();
		this.accepting.clear();
		this.state = "off";
	}
}
