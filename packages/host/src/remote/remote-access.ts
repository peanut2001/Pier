import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
	ChannelError,
	ChannelResponder,
	CLOSE_CODES,
	equalBytes,
	errorFrame,
	formatPairingUri,
	type KeyPair,
	keyFingerprint,
	type PairRequest,
	type PairResult,
	randomBytes,
	type SecureTransport,
	toBase64Url,
	utf8Encode,
} from "@pier/crypto";
import {
	type DeviceInfo,
	type PairingRequest,
	type PairingResolution,
	type PierHostEvent,
	PierProtocolError,
	PROTOCOL_VERSION,
	type RemoteAccessStatus,
} from "@pier/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { ConfigStore } from "../config.ts";
import type { Connection, RemoteDevice, Transport } from "../connection.ts";
import { auditLogPath, devicesPath, identityPath } from "../paths.ts";
import { advertiseMdns, listLanAddresses, type MdnsAdvertisement } from "./network.ts";
import { type AuditEntry, AuditLog, DeviceStore, loadOrCreateIdentity, toDeviceInfo } from "./store.ts";

export interface RemoteAccessOptions {
	/** Force remote access on/off for this run without touching the saved setting. */
	enabled?: boolean;
	/** Override the configured port for this run (0 picks a free port). */
	port?: number;
	/** Interface to bind (default: all interfaces, IPv4 and IPv6). */
	bindHost?: string;
	/** Addresses to put into pairing codes instead of the detected LAN addresses. */
	advertiseAddresses?: string[];
	/** Advertise `_pier._tcp` over mDNS while listening (default true). */
	mdns?: boolean;
	/** How long a pairing code stays valid (default 5 minutes). */
	pairingTtlMs?: number;
	/** How long a pairing request waits for the desktop user (default 2 minutes). */
	approvalTimeoutMs?: number;
	/** Handshake must complete within this time (default 10 s). */
	handshakeTimeoutMs?: number;
	/** Ping interval used to detect dead remote connections (default 30 s). */
	heartbeatMs?: number;
	/** Wrong pairing codes tolerated before the active code is invalidated (default 5). */
	maxPairingFailures?: number;
}

export interface RemoteHostHooks {
	hostId(): string;
	hostName(): string;
	/** Create a protocol connection for an authenticated device. */
	connect(transport: Transport, device: RemoteDevice): Connection;
	broadcastLocal(event: PierHostEvent): void;
	remoteConnections(): Connection[];
	log(message: string): void;
}

/** Concurrent unauthenticated handshakes allowed before new sockets are refused. */
const MAX_PENDING_HANDSHAKES = 32;
const MAX_REMOTE_PAYLOAD = 64 * 1024 * 1024;

interface ActivePairing {
	code: string;
	expiresAt: number;
	failures: number;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
	request: PairingRequest;
	resolve(resolution: PairingResolution): void;
}

interface Listener {
	wss: WebSocketServer;
	port: number;
	heartbeat: ReturnType<typeof setInterval>;
	mdns?: MdnsAdvertisement;
}

function constantTimeEqual(a: string, b: string): boolean {
	return equalBytes(utf8Encode(a), utf8Encode(b));
}

/**
 * Remote access: the encrypted LAN listener, pairing, the device registry and the
 * audit log. Local connections manage it through the `remote.*`, `pairing.*` and
 * `device.*` methods; remote devices only ever see an authenticated protocol connection.
 */
export class RemoteAccess {
	readonly identity: KeyPair;
	readonly devices: DeviceStore;
	readonly audit: AuditLog;
	private listener: Listener | undefined;
	private lastError: string | undefined;
	private pairing: ActivePairing | undefined;
	private readonly approvals = new Map<string, PendingApproval>();
	private pendingHandshakes = 0;
	private enabledOverride: boolean | undefined;
	private portOverride: number | undefined;
	private transition: Promise<void> = Promise.resolve();
	private stopped = false;

	constructor(
		pierDir: string,
		private readonly config: ConfigStore,
		private readonly hooks: RemoteHostHooks,
		private readonly options: RemoteAccessOptions = {},
	) {
		this.identity = loadOrCreateIdentity(identityPath(pierDir));
		this.devices = new DeviceStore(devicesPath(pierDir));
		this.audit = new AuditLog(auditLogPath(pierDir));
		this.enabledOverride = options.enabled;
		this.portOverride = options.port;
	}

	get enabled(): boolean {
		return this.enabledOverride ?? this.config.remote.enabled;
	}

	get running(): boolean {
		return this.listener !== undefined;
	}

	private get desiredPort(): number {
		return this.portOverride ?? this.config.remote.port;
	}

	addresses(): string[] {
		if (this.options.advertiseAddresses?.length) return [...this.options.advertiseAddresses];
		const port = this.listener?.port ?? this.desiredPort;
		if (this.options.bindHost && this.options.bindHost !== "0.0.0.0" && this.options.bindHost !== "::") {
			return [
				this.options.bindHost.includes(":") ? `[${this.options.bindHost}]:${port}` : `${this.options.bindHost}:${port}`,
			];
		}
		return listLanAddresses(port);
	}

	status(): RemoteAccessStatus {
		const pairingActive = this.pairing !== undefined && this.pairing.expiresAt > Date.now();
		return {
			enabled: this.enabled,
			port: this.listener?.port ?? this.desiredPort,
			running: this.running,
			addresses: this.running ? this.addresses() : [],
			hostFingerprint: keyFingerprint(this.identity.publicKey),
			mdns: this.listener?.mdns !== undefined,
			...(this.lastError && this.enabled && !this.running ? { error: this.lastError } : {}),
			pairingActive,
		};
	}

	private emitStatus(): void {
		this.hooks.broadcastLocal({ type: "remote.changed", status: this.status() });
	}

	/** Start or stop the listener to match the current setting. Serialized. */
	apply(): Promise<void> {
		const run = this.transition.then(async () => {
			if (this.stopped) return;
			const wantPort = this.desiredPort;
			if (this.enabled) {
				if (this.listener && (wantPort === 0 || this.listener.port === wantPort)) return;
				await this.stopListener("Remote access port changed");
				await this.startListener(wantPort);
			} else {
				await this.stopListener("Remote access was turned off");
			}
		});
		this.transition = run.catch(() => undefined);
		return run.finally(() => this.emitStatus());
	}

	/** Persist new settings (from `remote.configure`) and apply them. */
	async configure(patch: { enabled?: boolean; port?: number }): Promise<RemoteAccessStatus> {
		this.config.setRemote(patch);
		// An explicit choice in the app wins over this run's command-line overrides.
		if (patch.enabled !== undefined) this.enabledOverride = undefined;
		if (patch.port !== undefined) this.portOverride = undefined;
		await this.apply();
		return this.status();
	}

	private async startListener(port: number): Promise<void> {
		try {
			const wss = await new Promise<WebSocketServer>((resolve, reject) => {
				const server = new WebSocketServer({
					port,
					...(this.options.bindHost ? { host: this.options.bindHost } : {}),
					maxPayload: MAX_REMOTE_PAYLOAD,
					perMessageDeflate: false,
				});
				server.once("error", reject);
				server.once("listening", () => {
					server.off("error", reject);
					resolve(server);
				});
			});
			wss.on("error", (error) => this.hooks.log(`remote listener error: ${error.message}`));
			wss.on("connection", (socket, req) => this.accept(socket, req));
			const actualPort = (wss.address() as AddressInfo).port;
			const alive = new WeakSet<WebSocket>();
			wss.on("connection", (socket) => {
				alive.add(socket);
				socket.on("pong", () => alive.add(socket));
			});
			const heartbeat = setInterval(() => {
				for (const socket of wss.clients) {
					if (!alive.has(socket)) {
						socket.terminate();
						continue;
					}
					alive.delete(socket);
					socket.ping();
				}
			}, this.options.heartbeatMs ?? 30_000);
			heartbeat.unref?.();
			const listener: Listener = { wss, port: actualPort, heartbeat };
			if (this.options.mdns !== false) {
				try {
					listener.mdns = advertiseMdns({
						name: this.hooks.hostName(),
						port: actualPort,
						hostId: this.hooks.hostId(),
						protocolVersion: PROTOCOL_VERSION,
						onError: (error) => this.hooks.log(`mDNS: ${error.message}`),
					});
				} catch (error) {
					this.hooks.log(`mDNS unavailable: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			this.listener = listener;
			this.lastError = undefined;
			this.hooks.log(
				`remote access listening on port ${actualPort} (${this.addresses().join(", ") || "no LAN address"})`,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			this.lastError =
				code === "EADDRINUSE"
					? `Port ${port} is already in use`
					: code === "EACCES"
						? `No permission to listen on port ${port}`
						: error instanceof Error
							? error.message
							: String(error);
			this.hooks.log(`remote access failed to start: ${this.lastError}`);
		}
	}

	private async stopListener(reason: string): Promise<void> {
		const listener = this.listener;
		if (!listener) return;
		this.listener = undefined;
		this.cancelPairing();
		clearInterval(listener.heartbeat);
		for (const connection of this.hooks.remoteConnections()) {
			connection.close(CLOSE_CODES.remoteDisabled, reason);
		}
		for (const socket of listener.wss.clients) socket.close(CLOSE_CODES.remoteDisabled, reason);
		await listener.mdns?.stop();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				for (const socket of listener.wss.clients) socket.terminate();
			}, 1000);
			listener.wss.close(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.hooks.log(`remote access stopped (${reason})`);
	}

	async shutdown(): Promise<void> {
		for (const approval of [...this.approvals.values()]) approval.resolve("cancelled");
		await this.transition;
		this.stopped = true;
		await this.stopListener("Host shutting down");
	}

	// ---- pairing --------------------------------------------------------------------------

	startPairing(): { uri: string; expiresAt: string; addresses: string[] } {
		if (!this.running) {
			throw new PierProtocolError("CONFLICT", "Turn on remote access before pairing a device");
		}
		const addresses = this.addresses();
		if (!addresses.length) {
			throw new PierProtocolError("CONFLICT", "No network address found; connect to a network first");
		}
		if (this.pairing) clearTimeout(this.pairing.timer);
		const ttl = this.options.pairingTtlMs ?? 5 * 60_000;
		const code = toBase64Url(randomBytes(16));
		const expiresAt = Date.now() + ttl;
		const timer = setTimeout(() => {
			if (this.pairing?.code === code) {
				this.pairing = undefined;
				this.emitStatus();
			}
		}, ttl);
		timer.unref?.();
		this.pairing = { code, expiresAt, failures: 0, timer };
		this.emitStatus();
		return {
			uri: formatPairingUri({
				hostId: this.hooks.hostId(),
				hostName: this.hooks.hostName(),
				hostPublicKey: this.identity.publicKey,
				addresses,
				code,
			}),
			expiresAt: new Date(expiresAt).toISOString(),
			addresses,
		};
	}

	cancelPairing(): boolean {
		const had = this.pairing !== undefined;
		if (this.pairing) clearTimeout(this.pairing.timer);
		this.pairing = undefined;
		if (had) this.emitStatus();
		return had;
	}

	private pairingOpen(): boolean {
		return this.pairing !== undefined && this.pairing.expiresAt > Date.now();
	}

	respondPairing(requestId: string, accept: boolean): boolean {
		const approval = this.approvals.get(requestId);
		if (!approval) return false;
		approval.resolve(accept ? "accepted" : "rejected");
		return true;
	}

	pendingPairingRequests(): PairingRequest[] {
		return [...this.approvals.values()].map((a) => a.request);
	}

	/**
	 * Validate the one-time code, ask the desktop user, and register the device when
	 * accepted. `onAbort` lets the caller cancel the question if the device goes away.
	 */
	private async handlePairRequest(
		request: PairRequest,
		deviceKey: Uint8Array,
		address: string | undefined,
		onAbort: (abort: () => void) => void,
	): Promise<PairResult> {
		const pairing = this.pairing;
		if (!pairing || pairing.expiresAt <= Date.now()) {
			return { ok: false, code: "PAIRING_INVALID", message: "The pairing code has expired; show a new one" };
		}
		if (!constantTimeEqual(request.code, pairing.code)) {
			pairing.failures += 1;
			this.audit.write({ event: "pair.badCode", ...(address ? { address } : {}) });
			if (pairing.failures >= (this.options.maxPairingFailures ?? 5)) this.cancelPairing();
			return { ok: false, code: "PAIRING_INVALID", message: "Invalid pairing code" };
		}
		// One-time: the code is used up whatever the desktop user decides.
		this.cancelPairing();

		const timeoutMs = this.options.approvalTimeoutMs ?? 2 * 60_000;
		const pairingRequest: PairingRequest = {
			id: randomUUID(),
			device: request.device,
			fingerprint: keyFingerprint(deviceKey),
			...(address ? { address } : {}),
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
		};
		const resolution = await new Promise<PairingResolution>((resolve) => {
			const timer = setTimeout(() => finish("expired"), timeoutMs);
			const finish = (value: PairingResolution) => {
				if (!this.approvals.has(pairingRequest.id)) return;
				clearTimeout(timer);
				this.approvals.delete(pairingRequest.id);
				resolve(value);
			};
			this.approvals.set(pairingRequest.id, { request: pairingRequest, resolve: finish });
			onAbort(() => finish("cancelled"));
			this.hooks.broadcastLocal({ type: "pairing.request", request: pairingRequest });
		});

		if (resolution !== "accepted") {
			this.hooks.broadcastLocal({ type: "pairing.resolved", requestId: pairingRequest.id, resolution });
			this.audit.write({
				event: `pair.${resolution}`,
				deviceName: request.device.name,
				...(address ? { address } : {}),
			});
			return resolution === "rejected"
				? { ok: false, code: "PAIRING_REJECTED", message: "Pairing was declined on the desktop" }
				: { ok: false, code: "PAIRING_TIMEOUT", message: "Nobody confirmed the pairing on the desktop in time" };
		}
		const device = this.devices.register({
			publicKey: deviceKey,
			name: request.device.name,
			...(request.device.platform ? { platform: request.device.platform } : {}),
			...(request.device.model ? { model: request.device.model } : {}),
			...(request.device.appVersion ? { appVersion: request.device.appVersion } : {}),
		});
		this.hooks.broadcastLocal({
			type: "pairing.resolved",
			requestId: pairingRequest.id,
			resolution,
			deviceId: device.id,
		});
		this.hooks.broadcastLocal({ type: "device.changed" });
		this.audit.write({
			event: "pair.accepted",
			deviceId: device.id,
			deviceName: device.name,
			...(address ? { address } : {}),
		});
		this.hooks.log(`paired device ${device.name} (${device.id})`);
		return { ok: true, deviceId: device.id, hostId: this.hooks.hostId(), hostName: this.hooks.hostName() };
	}

	// ---- devices --------------------------------------------------------------------------

	listDevices(): DeviceInfo[] {
		const connected = new Set(this.hooks.remoteConnections().map((c) => c.device?.id));
		return this.devices
			.list()
			.sort((a, b) => b.pairedAt.localeCompare(a.pairedAt))
			.map((d) => toDeviceInfo(d, connected.has(d.id)));
	}

	isRegistered(deviceId: string): boolean {
		return this.devices.get(deviceId) !== undefined;
	}

	revoke(deviceId: string): boolean {
		const device = this.devices.get(deviceId);
		if (!this.devices.remove(deviceId)) return false;
		for (const connection of this.hooks.remoteConnections()) {
			if (connection.device?.id === deviceId) connection.close(CLOSE_CODES.deviceRevoked, "Device revoked");
		}
		this.audit.write({ event: "device.revoke", deviceId, ...(device ? { deviceName: device.name } : {}) });
		this.hooks.broadcastLocal({ type: "device.changed" });
		this.hooks.log(`revoked device ${device?.name ?? deviceId}`);
		return true;
	}

	rename(deviceId: string, name: string): DeviceInfo {
		const record = this.devices.rename(deviceId, name);
		if (!record) throw new PierProtocolError("NOT_FOUND", `Device ${deviceId} not found`);
		for (const connection of this.hooks.remoteConnections()) {
			if (connection.device?.id === deviceId) connection.device.name = name;
		}
		this.hooks.broadcastLocal({ type: "device.changed" });
		const connected = this.hooks.remoteConnections().some((c) => c.device?.id === deviceId);
		return toDeviceInfo(record, connected);
	}

	record(entry: AuditEntry): void {
		this.audit.write(entry);
	}

	// ---- sockets --------------------------------------------------------------------------

	private accept(socket: WebSocket, req: IncomingMessage): void {
		const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
		if (this.pendingHandshakes >= MAX_PENDING_HANDSHAKES) {
			socket.send(errorFrame("UNAVAILABLE", "Too many pending connections; try again"));
			socket.close(CLOSE_CODES.handshakeFailed, "Busy");
			return;
		}
		this.pendingHandshakes += 1;
		let handshaking = true;
		const endHandshake = () => {
			if (!handshaking) return;
			handshaking = false;
			this.pendingHandshakes -= 1;
		};

		const responder = new ChannelResponder({
			hostKeyPair: this.identity,
			hostHello: { hostId: this.hooks.hostId(), hostName: this.hooks.hostName() },
			isKnownDevice: (key) => this.devices.findByKey(key) !== undefined,
			pairingOpen: () => this.pairingOpen(),
		});
		let phase: "handshake" | "pairing" | "open" | "closed" = "handshake";
		let transport: SecureTransport | undefined;
		let connection: Connection | undefined;
		let abortPairing: (() => void) | undefined;

		const refuse = (code: ChannelError["code"], message: string) => {
			phase = "closed";
			endHandshake();
			try {
				socket.send(errorFrame(code, message));
			} catch {
				// Socket already gone.
			}
			socket.close(code === "UNKNOWN_DEVICE" ? CLOSE_CODES.deviceRevoked : CLOSE_CODES.handshakeFailed, code);
		};
		const timer = setTimeout(() => {
			if (phase === "handshake") refuse("BAD_HANDSHAKE", "Handshake timed out");
		}, this.options.handshakeTimeoutMs ?? 10_000);
		timer.unref?.();

		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				if (connection) connection.close(1003, "Binary frames are not supported");
				else refuse("BAD_HANDSHAKE", "Binary frames are not supported");
				return;
			}
			const raw = data.toString();
			if (phase === "open" && transport && connection) {
				let text: string;
				try {
					text = transport.open(raw);
				} catch {
					connection.close(CLOSE_CODES.handshakeFailed, "Invalid encrypted frame");
					return;
				}
				const current = connection;
				void current.receive(text).catch(() => current.close(1011, "Internal error"));
				return;
			}
			if (phase !== "handshake") {
				if (phase === "pairing") refuse("BAD_HANDSHAKE", "Unexpected frame while pairing");
				return;
			}
			try {
				const step = responder.receive(raw);
				if (step.kind === "continue") {
					socket.send(step.frame);
				} else if (step.kind === "connected") {
					clearTimeout(timer);
					endHandshake();
					const record = this.devices.findByKey(step.remoteStaticKey);
					if (!record) {
						refuse("UNKNOWN_DEVICE", "This device is not paired with the host (or was revoked)");
						return;
					}
					socket.send(step.frame);
					transport = step.transport;
					const secure = step.transport;
					phase = "open";
					connection = this.hooks.connect(
						{
							send: (text) => socket.send(secure.seal(text)),
							close: (code, reason) => socket.close(code, reason),
							get bufferedAmount() {
								return socket.bufferedAmount;
							},
						},
						{ id: record.id, name: record.name, ...(address ? { address } : {}) },
					);
					this.devices.touch(record.id);
					this.audit.write({
						event: "connect",
						deviceId: record.id,
						deviceName: record.name,
						...(address ? { address } : {}),
					});
					this.hooks.broadcastLocal({ type: "device.changed" });
				} else {
					clearTimeout(timer);
					endHandshake();
					phase = "pairing";
					const secure = step.transport;
					void this.handlePairRequest(step.request, step.remoteStaticKey, address, (abort) => {
						abortPairing = abort;
					}).then((result) => {
						abortPairing = undefined;
						if (socket.readyState !== socket.OPEN) return;
						socket.send(secure.seal(JSON.stringify(result)));
						phase = "closed";
						socket.close(result.ok ? 1000 : CLOSE_CODES.handshakeFailed, result.ok ? "Paired" : result.code);
					});
				}
			} catch (error) {
				if (error instanceof ChannelError) refuse(error.code, error.message);
				else refuse("BAD_HANDSHAKE", "Handshake failed");
			}
		});

		const onGone = () => {
			clearTimeout(timer);
			endHandshake();
			abortPairing?.();
			abortPairing = undefined;
			if (connection) {
				const device = connection.device;
				connection.onTransportClosed();
				connection = undefined;
				if (device) {
					this.devices.touch(device.id);
					this.audit.write({ event: "disconnect", deviceId: device.id, deviceName: device.name });
				}
				this.hooks.broadcastLocal({ type: "device.changed" });
			}
			phase = "closed";
		};
		socket.on("close", onGone);
		socket.on("error", onGone);
	}
}
