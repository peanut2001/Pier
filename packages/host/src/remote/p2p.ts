import type { RtcDataChannelLike, RtcPeerConnectionLike } from "@pier/client";
import type { IceServer } from "@pier/crypto";

/**
 * WebRTC for the host, through `werift` (pure TypeScript, so the single-file sidecar needs no
 * native module). The host answers offers from devices (`rtc.offer` inside an encrypted
 * relayed connection) and, when it connects to another computer through a relay, makes them.
 */

type Werift = typeof import("werift");

let loading: Promise<Werift> | undefined;

function loadWerift(): Promise<Werift> {
	// werift's certificate code (tsyringe, through @peculiar/x509) needs the Reflect metadata
	// polyfill loaded first; the bundled sidecar does not keep that import order by itself.
	loading ??= import("reflect-metadata").then(() => import("werift"));
	return loading;
}

/** werift takes one STUN and one TURN server; keep the first of each. */
function weriftIceServers(servers: IceServer[]): Array<{ urls: string; username?: string; credential?: string }> {
	const out: Array<{ urls: string; username?: string; credential?: string }> = [];
	let stun = false;
	let turn = false;
	for (const server of servers) {
		for (const url of Array.isArray(server.urls) ? server.urls : [server.urls]) {
			if (!stun && /^stun:/i.test(url)) {
				stun = true;
				out.push({ urls: url });
			} else if (!turn && /^turns?:/i.test(url) && server.username && server.credential) {
				turn = true;
				out.push({ urls: url, username: server.username, credential: server.credential });
			}
		}
	}
	return out;
}

/** Peer connection with the host's defaults (IPv4 and IPv6, no link-local addresses). */
export async function createHostPeerConnection(iceServers: IceServer[]): Promise<RtcPeerConnectionLike & WatchablePc> {
	const { RTCPeerConnection } = await loadWerift();
	const pc = new RTCPeerConnection({ iceServers: weriftIceServers(iceServers) });
	return pc as unknown as RtcPeerConnectionLike & WatchablePc;
}

interface WatchablePc {
	readonly connectionState: string;
	connectionStateChange: { subscribe(fn: (state: string) => void): unknown };
}

/** Call `onDead` once the peer connection failed or closed (ICE consent lost, peer gone). */
export function watchPeerConnection(pc: RtcPeerConnectionLike, onDead: () => void): void {
	const watchable = pc as unknown as Partial<WatchablePc>;
	let fired = false;
	watchable.connectionStateChange?.subscribe((state) => {
		if (fired || (state !== "failed" && state !== "closed")) return;
		fired = true;
		onDead();
	});
}

export interface P2PAnswer {
	sdp: string;
	pc: RtcPeerConnectionLike;
	/** The device's data channel, as soon as it is announced (it may still be connecting). */
	channel: Promise<RtcDataChannelLike>;
}

/** Answer a device's offer. The data channel promise rejects after `timeoutMs` without one. */
export async function answerOffer(offerSdp: string, iceServers: IceServer[], timeoutMs: number): Promise<P2PAnswer> {
	const pc = await createHostPeerConnection(iceServers);
	const raw = pc as unknown as {
		ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null;
		createAnswer(): Promise<{ type: string; sdp?: string }>;
	};
	const channel = new Promise<RtcDataChannelLike>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("No data channel from the device")), timeoutMs);
		raw.ondatachannel = (event) => {
			clearTimeout(timer);
			resolve(event.channel);
		};
	});
	channel.catch(() => undefined);
	try {
		await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
		const answer = await raw.createAnswer();
		await pc.setLocalDescription(answer);
		const sdp = pc.localDescription?.sdp;
		if (!sdp) throw new Error("No local description");
		return { sdp, pc, channel };
	} catch (error) {
		pc.close();
		throw error;
	}
}

/**
 * Connect two local peer connections and echo a message over a data channel: checks that
 * WebRTC works in this build (the sidecar bundles werift; see `--check-p2p`).
 */
export async function checkP2PSupport(timeoutMs = 30_000): Promise<{ ok: boolean; ms: number; error?: string }> {
	const started = Date.now();
	let offerer: RtcPeerConnectionLike | undefined;
	let answer: P2PAnswer | undefined;
	try {
		offerer = await createHostPeerConnection([]);
		const channel = offerer.createDataChannel("check", { ordered: true });
		await offerer.setLocalDescription(await offerer.createOffer());
		const sdp = offerer.localDescription?.sdp;
		if (!sdp) throw new Error("No offer");
		answer = await answerOffer(sdp, [], timeoutMs);
		await offerer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
		const remote = await answer.channel;
		remote.onmessage = (event) => remote.send(String(event.data));
		const echoed = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("No echo over the data channel")), timeoutMs);
			channel.onmessage = (event) => {
				clearTimeout(timer);
				resolve(String(event.data));
			};
		});
		await new Promise<void>((resolve, reject) => {
			if (channel.readyState === "open") return resolve();
			const timer = setTimeout(() => reject(new Error("The data channel did not open")), timeoutMs);
			channel.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		channel.send("pier-p2p-check");
		if ((await echoed) !== "pier-p2p-check") throw new Error("Wrong echo");
		return { ok: true, ms: Date.now() - started };
	} catch (error) {
		return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
	} finally {
		offerer?.close();
		answer?.pc.close();
	}
}
