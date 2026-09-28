import {
	addressToUrl,
	ChannelError,
	CLOSE_CODES,
	ConnectInitiator,
	type DeviceDescription,
	type KeyPair,
	PairInitiator,
	type PairingInfo,
	type PairResult,
	type SecureTransport,
} from "@pier/crypto";
import type { WebSocketFactory, WebSocketLike } from "./client.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function defaultFactory(): WebSocketFactory {
	const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
	if (!Ctor) throw new Error("No global WebSocket; pass createWebSocket");
	return (url) => new Ctor(url);
}

interface Attempt {
	socket: WebSocketLike;
	/** Resolves with the open socket, rejects when it fails to open in time. */
	opened: Promise<void>;
}

/** Open a raw socket, failing after `timeoutMs` (unreachable LAN addresses can hang for a long time). */
function openSocket(factory: WebSocketFactory, url: string, timeoutMs: number): Attempt {
	const socket = factory(url);
	const opened = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			fail(new Error(`Timed out connecting to ${url}`));
			try {
				socket.close();
			} catch {
				// Ignore.
			}
		}, timeoutMs);
		const fail = (error: Error) => {
			clearTimeout(timer);
			socket.onopen = null;
			socket.onerror = null;
			socket.onclose = null;
			reject(error);
		};
		socket.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		socket.onerror = () => fail(new Error(`Could not connect to ${url}`));
		socket.onclose = (event) =>
			fail(new Error(`Could not connect to ${url}${event.reason ? `: ${event.reason}` : ""}`));
	});
	return { socket, opened };
}

export interface SecureSocketOptions {
	/** Candidate `host:port` addresses (from pairing), tried in order. */
	addresses: string[];
	hostPublicKey: Uint8Array;
	deviceKeyPair: KeyPair;
	createWebSocket?: WebSocketFactory;
	/** Per-address TCP/WebSocket open timeout (default 4 s). */
	openTimeoutMs?: number;
	/** Handshake timeout after the socket opened (default 10 s). */
	handshakeTimeoutMs?: number;
	/** Called with the address that worked, so it can be tried first next time. */
	onConnected?: (address: string) => void;
}

/**
 * A {@link WebSocketLike} that tries the host's addresses in order, runs the Noise IK
 * handshake, and then encrypts every frame. `onopen` fires only after the handshake, so
 * `PierClient` works unchanged on top of it (pass `createSecureSocketFactory(...)` as
 * its `createWebSocket`).
 *
 * If the host does not know this device (never paired or revoked), the socket closes
 * with code 4403 and reason `UNKNOWN_DEVICE`.
 */
export class SecureWebSocket implements WebSocketLike {
	readyState = CONNECTING;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	/** Address of the established connection. */
	address: string | undefined;
	private socket: WebSocketLike | undefined;
	private transport: SecureTransport | undefined;
	private closedByUser = false;

	constructor(private readonly options: SecureSocketOptions) {
		void this.run();
	}

	private async run(): Promise<void> {
		const factory = this.options.createWebSocket ?? defaultFactory();
		let lastError = "No address to connect to";
		for (const address of this.options.addresses) {
			if (this.closedByUser) return;
			const attempt = openSocket(factory, addressToUrl(address), this.options.openTimeoutMs ?? 4000);
			try {
				await attempt.opened;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				continue;
			}
			if (this.closedByUser) {
				attempt.socket.close(1000, "Closed");
				return;
			}
			try {
				await this.handshake(attempt.socket, address);
				return;
			} catch (error) {
				try {
					attempt.socket.close();
				} catch {
					// Ignore.
				}
				if (error instanceof ChannelError) {
					// The host answered: trying other addresses cannot help.
					this.finish(
						error.code === "UNKNOWN_DEVICE" ? CLOSE_CODES.deviceRevoked : CLOSE_CODES.handshakeFailed,
						error.code === "UNKNOWN_DEVICE" ? "UNKNOWN_DEVICE" : error.message,
					);
					return;
				}
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
		this.finish(1006, lastError);
	}

	private handshake(socket: WebSocketLike, address: string): Promise<void> {
		const initiator = new ConnectInitiator({
			deviceKeyPair: this.options.deviceKeyPair,
			hostPublicKey: this.options.hostPublicKey,
		});
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Secure handshake timed out")),
				this.options.handshakeTimeoutMs ?? 10_000,
			);
			socket.onmessage = (event) => {
				if (this.transport) {
					this.deliver(event.data);
					return;
				}
				clearTimeout(timer);
				try {
					this.transport = initiator.receive(String(event.data));
				} catch (error) {
					reject(error);
					return;
				}
				this.socket = socket;
				this.address = address;
				socket.onerror = (e) => this.onerror?.(e);
				socket.onclose = (e) => this.finish(e.code ?? 1006, e.reason ?? "");
				this.readyState = OPEN;
				this.options.onConnected?.(address);
				resolve();
				this.onopen?.({});
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error(`Connection to ${address} failed`));
			};
			socket.onclose = (event) => {
				clearTimeout(timer);
				reject(new Error(`Connection to ${address} closed${event.reason ? `: ${event.reason}` : ""}`));
			};
			try {
				socket.send(initiator.start());
			} catch (error) {
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	private deliver(data: unknown): void {
		if (!this.transport) return;
		let text: string;
		try {
			text = this.transport.open(String(data));
		} catch {
			this.close(CLOSE_CODES.handshakeFailed, "Invalid encrypted frame");
			return;
		}
		this.onmessage?.({ data: text });
	}

	private finish(code: number, reason: string): void {
		if (this.readyState === CLOSED) return;
		const wasOpen = this.readyState === OPEN;
		this.readyState = CLOSED;
		if (!wasOpen && !this.closedByUser) this.onerror?.({ message: reason });
		this.onclose?.({ code, reason });
	}

	send(data: string): void {
		if (this.readyState !== OPEN || !this.socket || !this.transport) throw new Error("Socket is not open");
		this.socket.send(this.transport.seal(data));
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === CLOSED || this.readyState === CLOSING) return;
		this.closedByUser = true;
		if (this.socket) {
			this.readyState = CLOSING;
			try {
				this.socket.close(code, reason);
			} catch {
				this.finish(code, reason);
			}
		} else {
			this.finish(code, reason);
		}
	}
}

/**
 * `createWebSocket` factory for `PierClient` that connects through the secure channel.
 * The `url` passed by the client is ignored; the factory remembers which address
 * worked last and tries it first on reconnect.
 */
export function createSecureSocketFactory(options: SecureSocketOptions): WebSocketFactory {
	let preferred: string | undefined;
	return () => {
		const addresses = preferred
			? [preferred, ...options.addresses.filter((a) => a !== preferred)]
			: [...options.addresses];
		return new SecureWebSocket({
			...options,
			addresses,
			onConnected: (address) => {
				preferred = address;
				options.onConnected?.(address);
			},
		});
	};
}

// ---- pairing --------------------------------------------------------------------------

export interface PairingOutcome {
	deviceId: string;
	hostId: string;
	hostName: string;
	hostPublicKey: Uint8Array;
	addresses: string[];
	/** The address pairing succeeded on (try it first). */
	address: string;
}

export type PairingPhase = "connecting" | "waitingForApproval";

export interface PairOptions {
	info: PairingInfo;
	deviceKeyPair: KeyPair;
	device: DeviceDescription;
	createWebSocket?: WebSocketFactory;
	openTimeoutMs?: number;
	/** Overall limit including waiting for the desktop user (default 3 minutes). */
	timeoutMs?: number;
	onPhase?: (phase: PairingPhase) => void;
}

/**
 * Pair with a host from a scanned pairing code: connect, run Noise XX (verifying the
 * host key from the QR code), send the one-time code, and wait for the desktop user.
 * Rejects with a {@link ChannelError} (`PAIRING_INVALID`, `PAIRING_REJECTED`, ...) or a
 * network error.
 */
export async function pairWithHost(options: PairOptions): Promise<PairingOutcome> {
	const factory = options.createWebSocket ?? defaultFactory();
	let lastError: unknown = new Error("No address to connect to");
	options.onPhase?.("connecting");
	for (const address of options.info.addresses) {
		const attempt = openSocket(factory, addressToUrl(address), options.openTimeoutMs ?? 4000);
		try {
			await attempt.opened;
		} catch (error) {
			lastError = error;
			continue;
		}
		const result = await runPairing(attempt.socket, options);
		if (!result.ok) throw new ChannelError(result.code, result.message);
		return {
			deviceId: result.deviceId,
			hostId: result.hostId,
			hostName: result.hostName,
			hostPublicKey: options.info.hostPublicKey,
			addresses: [address, ...options.info.addresses.filter((a) => a !== address)],
			address,
		};
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function runPairing(socket: WebSocketLike, options: PairOptions): Promise<PairResult> {
	const initiator = new PairInitiator({
		deviceKeyPair: options.deviceKeyPair,
		expectedHostKey: options.info.hostPublicKey,
		code: options.info.code,
		device: options.device,
	});
	return new Promise<PairResult>((resolve, reject) => {
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
			try {
				socket.close(1000, "Pairing finished");
			} catch {
				// Ignore.
			}
		};
		const timer = setTimeout(
			() => done(() => reject(new ChannelError("PAIRING_TIMEOUT", "Pairing timed out"))),
			options.timeoutMs ?? 3 * 60_000,
		);
		socket.onmessage = (event) => {
			try {
				const step = initiator.receive(String(event.data));
				if ("send" in step) {
					socket.send(step.send);
					options.onPhase?.("waitingForApproval");
				} else {
					done(() => resolve(step.result));
				}
			} catch (error) {
				done(() => reject(error));
			}
		};
		socket.onerror = () => done(() => reject(new Error("Connection lost while pairing")));
		socket.onclose = (event) =>
			done(() => reject(new Error(`Connection closed while pairing${event.reason ? `: ${event.reason}` : ""}`)));
		try {
			socket.send(initiator.start());
		} catch (error) {
			done(() => reject(error));
		}
	});
}

export { CLOSED as SOCKET_CLOSED, OPEN as SOCKET_OPEN };
