/**
 * An established secure channel that may move between network paths.
 *
 * A connection starts on one path (a LAN WebSocket, or a WebSocket through a Pier Relay).
 * When both sides support it, the device can open a peer-to-peer path (a WebRTC data
 * channel) and move the connection onto it without a new handshake: the same Noise
 * transport keeps sealing frames, so the session key, the nonce counters and the protocol
 * connection on top (subscriptions, pending requests) are all unchanged.
 *
 * Frames may arrive on several paths during the move, so the receiver delivers them in
 * nonce order, holding back frames that arrive early. A sealed `fin` control frame on the
 * old path tells the other side that nothing more will be sent there, so it can close it.
 *
 * Control frames travel inside the encryption, as plaintext that starts with
 * {@link CONTROL_PREFIX} (Pier protocol frames are JSON objects, which never do). They are
 * only sent to a side that announced the `ctl` capability in the handshake.
 */
import { ChannelError, type ChannelFrame, parseChannelFrame, type SecureTransport } from "./channel.ts";

/** First character of a control frame's plaintext. */
export const CONTROL_PREFIX = "\u0000";
/** Handshake capability: the side understands control frames. */
export const CAP_CONTROL = "ctl";

export type ControlMessage = { c: string } & Record<string, unknown>;

/** One network path a session can send on (a socket or a data channel). */
export interface SessionPath {
	send(frame: string): void;
	close(code?: number, reason?: string): void;
	/** Bytes queued but not yet sent, when the path can report it. */
	readonly bufferedAmount?: number;
}

export interface SecureSessionHandlers {
	/** A decrypted Pier frame, in order. */
	message(text: string): void;
	/** A decrypted control frame, in order, with the path it arrived on. */
	control(message: ControlMessage, path: SessionPath | undefined): void;
	/** The channel is broken (bad frame, lost frame); close the connection. */
	fail(error: ChannelError): void;
}

export interface SecureSessionOptions {
	/** Frames held back while waiting for an earlier nonce (default 4096). */
	maxPending?: number;
	/** How long a missing frame may be waited for (default 15 s). */
	gapTimeoutMs?: number;
}

export class SecureSession {
	private active: SessionPath;
	private readonly pending = new Map<number, { frame: ChannelFrame & { t: "enc" }; path: SessionPath | undefined }>();
	private gapTimer: ReturnType<typeof setTimeout> | undefined;
	private failed = false;

	constructor(
		readonly transport: SecureTransport,
		path: SessionPath,
		private readonly handlers: SecureSessionHandlers,
		private readonly options: SecureSessionOptions = {},
	) {
		this.active = path;
	}

	/** The path frames are sent on. */
	get path(): SessionPath {
		return this.active;
	}

	get bufferedAmount(): number {
		return this.active.bufferedAmount ?? 0;
	}

	/** Seal and send a Pier frame on the active path. */
	send(text: string): void {
		this.active.send(this.transport.seal(text));
	}

	/** Seal and send a control frame on the active path (or `path`). */
	sendControl(message: ControlMessage, path: SessionPath = this.active): void {
		path.send(this.transport.seal(CONTROL_PREFIX + JSON.stringify(message)));
	}

	/**
	 * Send on `next` from now on. A `fin` control frame goes out on the old path first, so
	 * the other side knows it can close it once it got there. Returns the old path.
	 */
	switchPath(next: SessionPath): SessionPath {
		const old = this.active;
		if (old === next) return old;
		try {
			this.sendControl({ c: "fin" }, old);
		} catch {
			// The old path is already gone; frames are ordered by nonce anyway.
		}
		this.active = next;
		return old;
	}

	/** Feed a raw frame that arrived on `path`. Delivers it (and any held-back frames) in nonce order. */
	receive(raw: string, path?: SessionPath): void {
		if (this.failed) return;
		const frame = parseChannelFrame(raw);
		if (frame?.t !== "enc") {
			this.fail(
				frame?.t === "error"
					? new ChannelError(frame.code, frame.message)
					: new ChannelError("BAD_HANDSHAKE", frame ? `Unexpected ${frame.t} frame` : "Invalid channel frame"),
			);
			return;
		}
		const problem = this.misplaced(frame.n);
		if (problem) {
			this.fail(new ChannelError("BAD_HANDSHAKE", problem));
			return;
		}
		if (frame.n > this.transport.receiveNonce) {
			this.pending.set(frame.n, { frame, path });
			this.armGapTimer();
			return;
		}
		this.deliver(frame, path);
		for (;;) {
			if (this.failed) return;
			const next = this.pending.get(this.transport.receiveNonce);
			if (!next) break;
			this.pending.delete(next.frame.n);
			this.deliver(next.frame, next.path);
		}
		if (!this.pending.size && this.gapTimer) {
			clearTimeout(this.gapTimer);
			this.gapTimer = undefined;
		} else if (this.pending.size) {
			this.armGapTimer(true);
		}
	}

	/** Why a frame with nonce `n` cannot be accepted (or held back), if it cannot. */
	private misplaced(n: number): string | undefined {
		const expected = this.transport.receiveNonce;
		if (n < expected) return "Replayed frame";
		if (n === expected) return undefined;
		if (this.pending.has(n)) return "Duplicate frame";
		if (this.pending.size >= (this.options.maxPending ?? 4096)) return "Too many frames out of order";
		return undefined;
	}

	private armGapTimer(restart = false): void {
		if (this.gapTimer && !restart) return;
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = setTimeout(() => {
			this.gapTimer = undefined;
			if (this.pending.size) this.fail(new ChannelError("BAD_HANDSHAKE", "A frame was lost while switching paths"));
		}, this.options.gapTimeoutMs ?? 15_000);
		(this.gapTimer as { unref?: () => void }).unref?.();
	}

	private deliver(frame: ChannelFrame, path: SessionPath | undefined): void {
		let text: string;
		try {
			text = this.transport.openFrame(frame);
		} catch (error) {
			this.fail(error instanceof ChannelError ? error : new ChannelError("BAD_HANDSHAKE", "Invalid encrypted frame"));
			return;
		}
		if (text.startsWith(CONTROL_PREFIX)) {
			let message: unknown;
			try {
				message = JSON.parse(text.slice(CONTROL_PREFIX.length));
			} catch {
				return;
			}
			if (message && typeof message === "object" && typeof (message as { c?: unknown }).c === "string") {
				this.handlers.control(message as ControlMessage, path);
			}
			return;
		}
		this.handlers.message(text);
	}

	private fail(error: ChannelError): void {
		if (this.failed) return;
		this.failed = true;
		this.dispose();
		this.handlers.fail(error);
	}

	/** Stop timers (the connection is closing). */
	dispose(): void {
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = undefined;
		this.pending.clear();
	}
}
