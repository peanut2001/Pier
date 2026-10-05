/**
 * Peer-to-peer paths over WebRTC data channels.
 *
 * A device connected through a Pier Relay tries to move the connection onto a direct path:
 * it creates a WebRTC data channel, sends the offer to the host inside the encrypted channel
 * (`rtc.offer` control frame), applies the host's answer (`rtc.answer`), and once the data
 * channel opens switches the session onto it (see `SecureSession` in `@pier/crypto`). ICE
 * punches through NAT with the help of STUN; when that fails the connection simply stays on
 * the relay.
 *
 * The session's Noise transport keeps sealing every frame on the data channel too: DTLS
 * underneath is a second layer, not the one Pier relies on.
 *
 * Only a minimal structural subset of the W3C WebRTC API is used, so browsers,
 * `react-native-webrtc` and `werift` (the host, in Node / Bun) all fit.
 */
import type { IceServer, SessionPath } from "@pier/crypto";

export interface RtcDataChannelLike {
	readonly readyState: string;
	readonly bufferedAmount: number;
	send(data: string): void;
	close(): void;
	onopen: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RtcSessionDescriptionLike {
	type: string;
	sdp?: string;
}

export interface RtcPeerConnectionLike {
	readonly iceGatheringState: string;
	readonly localDescription: RtcSessionDescriptionLike | null;
	createDataChannel(label: string, options?: { ordered?: boolean }): RtcDataChannelLike;
	createOffer(): Promise<RtcSessionDescriptionLike>;
	setLocalDescription(description: RtcSessionDescriptionLike): Promise<void>;
	setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void>;
	close(): void;
}

export type RtcPeerConnectionFactory = (config: {
	iceServers: IceServer[];
}) => RtcPeerConnectionLike | Promise<RtcPeerConnectionLike>;

export interface P2POptions {
	/** Creates an `RTCPeerConnection` (the platform's WebRTC implementation). */
	createPeerConnection: RtcPeerConnectionFactory;
	/** ICE servers to use in addition to the ones the host announced. */
	iceServers?: IceServer[];
	/** Delay before the first attempt after connecting through a relay (default 500 ms). */
	delayMs?: number;
	/** Give up on an attempt after this long (default 20 s). */
	timeoutMs?: number;
	log?: (message: string) => void;
}

/**
 * Largest data channel message Pier sends. Below every implementation's limit (werift
 * accepts 64 KiB, libwebrtc 256 KiB) and large enough to keep the message count low.
 */
export const DATA_CHANNEL_CHUNK = 60 * 1024;
/** Largest frame accepted from a data channel. */
const MAX_DATA_CHANNEL_FRAME = 128 * 1024 * 1024;

/**
 * A {@link SessionPath} over an open data channel.
 *
 * The (ordered, reliable) channel carries a stream of records `<length>:<frame>`, cut into
 * messages of at most {@link DATA_CHANNEL_CHUNK} characters regardless of record bounds.
 * Frames sent in the same tick, or while earlier messages are still queued, share messages:
 * streaming produces many small frames, and some implementations (werift) slow down badly
 * with many small messages. Frames are
 * sealed channel frames (ASCII), so lengths in UTF-16 units equal bytes on the wire.
 */
export function dataChannelPath(
	channel: RtcDataChannelLike,
	handlers: { frame(text: string): void; close(reason: string): void },
): SessionPath {
	let closed = false;
	// Receive state: text received but not yet parsed, and the frame being assembled.
	let pending = "";
	let need = -1;
	let parts: string[] = [];
	let partsLength = 0;
	// Send state: frames waiting for the end of the tick.
	let outbox: string[] = [];
	let outboxLength = 0;
	let scheduled = false;

	const close = (reason: string) => {
		if (closed) return;
		closed = true;
		pending = "";
		parts = [];
		outbox = [];
		handlers.close(reason);
	};
	const fail = (reason: string) => {
		close(reason);
		try {
			channel.close();
		} catch {
			// Ignore.
		}
	};

	const parse = (text: string) => {
		let data = pending + text;
		pending = "";
		while (data.length && !closed) {
			if (need < 0) {
				const colon = data.indexOf(":");
				if (colon < 0) {
					if (data.length > 12) return fail("Malformed data channel stream");
					pending = data;
					return;
				}
				const length = Number(data.slice(0, colon));
				if (!Number.isSafeInteger(length) || length < 0 || colon === 0 || length > MAX_DATA_CHANNEL_FRAME) {
					return fail("Malformed data channel stream");
				}
				need = length;
				data = data.slice(colon + 1);
			}
			const take = Math.min(need - partsLength, data.length);
			if (take > 0) {
				parts.push(data.slice(0, take));
				partsLength += take;
				data = data.slice(take);
			}
			if (partsLength === need) {
				const frame = parts.length === 1 ? (parts[0] as string) : parts.join("");
				parts = [];
				partsLength = 0;
				need = -1;
				handlers.frame(frame);
			}
		}
	};

	const flush = (force = false) => {
		scheduled = false;
		if (closed || !outbox.length) return;
		// While earlier messages are still queued in the channel, keep collecting frames: fewer,
		// larger messages (the channel is slower than the frames are produced).
		if (!force && (channel.bufferedAmount ?? 0) > DATA_CHANNEL_CHUNK) {
			scheduled = true;
			setTimeout(flush, 5);
			return;
		}
		const stream = outbox.join("");
		outbox = [];
		outboxLength = 0;
		try {
			for (let i = 0; i < stream.length; i += DATA_CHANNEL_CHUNK) channel.send(stream.slice(i, i + DATA_CHANNEL_CHUNK));
		} catch {
			fail("Data channel send failed");
		}
	};

	channel.onmessage = (event) => {
		if (closed) return;
		if (typeof event.data !== "string") return fail("Unexpected binary data channel message");
		parse(event.data);
	};
	channel.onclose = () => close("Data channel closed");
	channel.onerror = () => {};
	return {
		send(frame: string) {
			if (closed || channel.readyState !== "open") throw new Error("Data channel is not open");
			outbox.push(`${frame.length}:`, frame);
			outboxLength += frame.length + 12;
			if (!scheduled) {
				scheduled = true;
				queueMicrotask(() => flush());
			}
		},
		close() {
			if (!closed) flush(true);
			closed = true;
			try {
				channel.close();
			} catch {
				// Ignore.
			}
		},
		get bufferedAmount() {
			return (channel.bufferedAmount ?? 0) + outboxLength;
		},
	};
}

/** Resolve once ICE gathering finished, or after `timeoutMs` with whatever was gathered. */
export function waitForIceGathering(pc: RtcPeerConnectionLike, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		if (pc.iceGatheringState === "complete") {
			resolve();
			return;
		}
		const started = Date.now();
		const timer = setInterval(() => {
			if (pc.iceGatheringState === "complete" || Date.now() - started >= timeoutMs) {
				clearInterval(timer);
				resolve();
			}
		}, 50);
	});
}

/** Resolve when the data channel opens; reject when it closes first or after `timeoutMs`. */
export function waitForDataChannel(channel: RtcDataChannelLike, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		if (channel.readyState === "open") {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			channel.onopen = null;
			channel.onclose = null;
			reject(new Error("Peer-to-peer connection timed out"));
		}, timeoutMs);
		channel.onopen = () => {
			clearTimeout(timer);
			channel.onopen = null;
			channel.onclose = null;
			resolve();
		};
		channel.onclose = () => {
			clearTimeout(timer);
			channel.onopen = null;
			channel.onclose = null;
			reject(new Error("Peer-to-peer connection failed"));
		};
	});
}

/** Merge ICE server lists, dropping duplicate URLs. */
export function mergeIceServers(...lists: Array<IceServer[] | undefined>): IceServer[] {
	const seen = new Set<string>();
	const out: IceServer[] = [];
	for (const list of lists) {
		for (const server of list ?? []) {
			const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => !seen.has(u));
			if (!urls.length) continue;
			for (const u of urls) seen.add(u);
			out.push({ ...server, urls });
		}
	}
	return out;
}
