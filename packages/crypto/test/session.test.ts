import { describe, expect, it, vi } from "vitest";
import {
	CAP_CONTROL,
	type ChannelError,
	ChannelResponder,
	type ConnectHello,
	ConnectInitiator,
	type ControlMessage,
	createRelayChallenge,
	formatPairingUri,
	generateKeyPair,
	normalizeRelayUrl,
	parsePairingUri,
	RelayUrlError,
	relayConnectUrl,
	relayRegisterProof,
	SecureSession,
	type SecureTransport,
	type SessionPath,
	toBase64Url,
} from "../src/index.ts";

function connect(
	deviceHello?: ConnectHello,
	hostHello?: (device: ConnectHello) => ConnectHello | undefined,
): { device: SecureTransport; host: SecureTransport; seenByHost: ConnectHello; seenByDevice: ConnectHello } {
	const hostKeys = generateKeyPair();
	const initiator = new ConnectInitiator({
		deviceKeyPair: generateKeyPair(),
		hostPublicKey: hostKeys.publicKey,
		...(deviceHello ? { hello: deviceHello } : {}),
	});
	const responder = new ChannelResponder({
		hostKeyPair: hostKeys,
		hostHello: { hostId: "h", hostName: "Host" },
		isKnownDevice: () => true,
		pairingOpen: () => false,
		...(hostHello ? { connectHello: hostHello } : {}),
	});
	const step = responder.receive(initiator.start());
	if (step.kind !== "connected") throw new Error(step.kind);
	const device = initiator.receive(step.frame);
	return { device, host: step.transport, seenByHost: step.deviceHello, seenByDevice: initiator.hostHello };
}

describe("handshake capabilities", () => {
	it("exchanges hellos inside the IK handshake", () => {
		const { seenByHost, seenByDevice } = connect({ caps: [CAP_CONTROL] }, (device) =>
			device.caps?.includes(CAP_CONTROL)
				? { caps: [CAP_CONTROL], p2p: { iceServers: [{ urls: "stun:relay.example.com:3478" }] } }
				: undefined,
		);
		expect(seenByHost).toEqual({ caps: [CAP_CONTROL] });
		expect(seenByDevice).toEqual({
			caps: [CAP_CONTROL],
			p2p: { iceServers: [{ urls: ["stun:relay.example.com:3478"] }] },
		});
	});

	it("stays compatible with peers that send no hello", () => {
		const { seenByHost, seenByDevice } = connect(undefined, () => undefined);
		expect(seenByHost).toEqual({});
		expect(seenByDevice).toEqual({});
	});

	it("drops ICE servers that are not STUN or TURN", () => {
		const { seenByDevice } = connect({ caps: [CAP_CONTROL] }, () => ({
			caps: [CAP_CONTROL],
			p2p: { iceServers: [{ urls: ["http://evil", "stun:ok:3478"] }, { urls: "javascript:x" }] },
		}));
		expect(seenByDevice.p2p?.iceServers).toEqual([{ urls: ["stun:ok:3478"] }]);
	});
});

/** A path that records what was sent on it. */
function recordingPath(): SessionPath & { frames: string[]; closed: boolean } {
	const path = {
		frames: [] as string[],
		closed: false,
		send(frame: string) {
			path.frames.push(frame);
		},
		close() {
			path.closed = true;
		},
		bufferedAmount: 0,
	};
	return path;
}

function sessions() {
	const { device, host } = connect();
	const devicePath = recordingPath();
	const hostPath = recordingPath();
	const got: { device: string[]; host: string[]; deviceControl: ControlMessage[]; hostControl: ControlMessage[] } = {
		device: [],
		host: [],
		deviceControl: [],
		hostControl: [],
	};
	const failures: ChannelError[] = [];
	const deviceSession = new SecureSession(device, devicePath, {
		message: (text) => got.device.push(text),
		control: (message) => got.deviceControl.push(message),
		fail: (error) => failures.push(error),
	});
	const hostSession = new SecureSession(
		host,
		hostPath,
		{
			message: (text) => got.host.push(text),
			control: (message) => got.hostControl.push(message),
			fail: (error) => failures.push(error),
		},
		{ gapTimeoutMs: 50 },
	);
	return { deviceSession, hostSession, devicePath, hostPath, got, failures };
}

describe("secure session", () => {
	it("separates control frames from protocol frames", () => {
		const { deviceSession, hostSession, devicePath, got } = sessions();
		deviceSession.send('{"type":"req"}');
		deviceSession.sendControl({ c: "rtc.offer", sdp: "v=0" });
		for (const frame of devicePath.frames) hostSession.receive(frame);
		expect(got.host).toEqual(['{"type":"req"}']);
		expect(got.hostControl).toEqual([{ c: "rtc.offer", sdp: "v=0" }]);
	});

	it("delivers frames in nonce order across paths while switching", () => {
		const { deviceSession, hostSession, devicePath, got } = sessions();
		const p2p = recordingPath();
		deviceSession.send("1");
		const old = deviceSession.switchPath(p2p);
		expect(old).toBe(devicePath);
		deviceSession.send("2");
		deviceSession.send("3");
		// `fin` went out on the old path, the rest on the new one.
		expect(devicePath.frames).toHaveLength(2);
		expect(p2p.frames).toHaveLength(2);
		// The new path is faster: its frames arrive first and wait for the old path's.
		for (const frame of p2p.frames) hostSession.receive(frame, p2p);
		expect(got.host).toEqual([]);
		for (const frame of devicePath.frames) hostSession.receive(frame, devicePath);
		expect(got.host).toEqual(["1", "2", "3"]);
		expect(got.hostControl).toEqual([{ c: "fin" }]);
	});

	it("fails on replays and on frames lost while switching", () => {
		vi.useFakeTimers();
		try {
			const { deviceSession, hostSession, devicePath, failures } = sessions();
			deviceSession.send("1");
			deviceSession.send("2");
			const [first, second] = devicePath.frames as [string, string];
			hostSession.receive(second);
			expect(failures).toEqual([]);
			vi.advanceTimersByTime(100);
			expect(failures.map((f) => f.message)).toEqual(["A frame was lost while switching paths"]);
			hostSession.receive(first);
		} finally {
			vi.useRealTimers();
		}
		const { deviceSession, hostSession, devicePath, failures } = sessions();
		deviceSession.send("1");
		const [frame] = devicePath.frames as [string];
		hostSession.receive(frame);
		hostSession.receive(frame);
		expect(failures.map((f) => f.message)).toEqual(["Replayed frame"]);
	});
});

describe("relay", () => {
	it("proves possession of the host key", () => {
		const host = generateKeyPair();
		const challenge = createRelayChallenge();
		const proof = relayRegisterProof(host, challenge);
		const key = challenge.verify(toBase64Url(host.publicKey), proof);
		expect(key && toBase64Url(key)).toBe(toBase64Url(host.publicKey));
		// Someone else's key, or a proof for another challenge, does not verify.
		expect(challenge.verify(toBase64Url(generateKeyPair().publicKey), proof)).toBeUndefined();
		expect(createRelayChallenge().verify(toBase64Url(host.publicKey), proof)).toBeUndefined();
		expect(challenge.verify("not-a-key", proof)).toBeUndefined();
	});

	it("normalizes relay addresses", () => {
		expect(normalizeRelayUrl("relay.example.com")).toBe("wss://relay.example.com");
		expect(normalizeRelayUrl(" https://Relay.Example.com/pier/ ")).toBe("wss://relay.example.com/pier");
		expect(normalizeRelayUrl("http://10.0.0.5:7480")).toBe("ws://10.0.0.5:7480");
		expect(normalizeRelayUrl("ws://[::1]:7480/")).toBe("ws://[::1]:7480");
		expect(normalizeRelayUrl("wss://relay.example.com:443?x=1")).toBe("wss://relay.example.com:443");
		for (const bad of ["", "ftp://x", "wss://user:pw@host", "wss://host:99999", "wss://bad host"]) {
			expect(() => normalizeRelayUrl(bad)).toThrow(RelayUrlError);
		}
		const key = generateKeyPair().publicKey;
		expect(relayConnectUrl("wss://r.example", key)).toBe(`wss://r.example/v1/connect?host=${toBase64Url(key)}`);
	});

	it("carries relays in pairing codes, with or without direct addresses", () => {
		const base = { hostId: "h1", hostName: "Mac", hostPublicKey: generateKeyPair().publicKey, code: "c0de" };
		const both = parsePairingUri(
			formatPairingUri({ ...base, addresses: ["192.168.1.2:7433"], relays: ["wss://relay.example.com"] }),
		);
		expect(both.addresses).toEqual(["192.168.1.2:7433"]);
		expect(both.relays).toEqual(["wss://relay.example.com"]);
		const relayOnly = parsePairingUri(formatPairingUri({ ...base, addresses: [], relays: ["relay.example.com/x"] }));
		expect(relayOnly.addresses).toEqual([]);
		expect(relayOnly.relays).toEqual(["wss://relay.example.com/x"]);
		const plain = parsePairingUri(formatPairingUri({ ...base, addresses: ["10.0.0.2:7433"] }));
		expect(plain.relays).toBeUndefined();
		expect(() => parsePairingUri(formatPairingUri({ ...base, addresses: [], relays: [] }))).toThrow(/address/);
	});
});
