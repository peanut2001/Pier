import type { RtcPeerConnectionFactory, RtcPeerConnectionLike } from "@pier/client";
import { Platform } from "react-native";

/**
 * WebRTC for moving a relayed connection onto a peer-to-peer path: the browser's own
 * implementation on the web, `react-native-webrtc` on iOS / Android. `undefined` when it is
 * not available (e.g. Expo Go); connections then simply stay on the relay.
 */
declare const require: (name: string) => unknown;

type PeerConnectionCtor = new (config: { iceServers: unknown[] }) => RtcPeerConnectionLike;

let cached: RtcPeerConnectionFactory | null | undefined;

export function peerConnectionFactory(): RtcPeerConnectionFactory | undefined {
	if (cached !== undefined) return cached ?? undefined;
	let Ctor: PeerConnectionCtor | undefined;
	try {
		if (Platform.OS === "web") {
			Ctor = (globalThis as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection;
		} else {
			// Loaded lazily: the module talks to native code as soon as it is evaluated.
			Ctor = (require("react-native-webrtc") as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection;
		}
	} catch {
		Ctor = undefined;
	}
	cached = Ctor ? (config) => new (Ctor as PeerConnectionCtor)({ iceServers: config.iceServers }) : null;
	return cached ?? undefined;
}
