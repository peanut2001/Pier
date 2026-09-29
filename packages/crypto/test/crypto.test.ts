import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ChannelError,
	ChannelResponder,
	CipherState,
	ConnectInitiator,
	chachaNonce,
	formatPairingUri,
	fromBase64,
	fromHex,
	generateKeyPair,
	Handshake,
	type HandshakePatternName,
	keyFingerprint,
	keyPairFromSecret,
	PairInitiator,
	PairingUriError,
	parsePairingUri,
	runChannelBenchmark,
	type SecureTransport,
	toBase64,
	toHex,
	utf8Decode,
	utf8DecodeJs,
	utf8Encode,
	utf8EncodeJs,
} from "../src/index.ts";

interface Vector {
	protocol_name: string;
	init_prologue: string;
	init_static: string;
	init_ephemeral: string;
	init_remote_static?: string;
	resp_prologue: string;
	resp_static: string;
	resp_ephemeral: string;
	handshake_hash: string;
	messages: Array<{ payload: string; ciphertext: string }>;
}

const vectors = (
	JSON.parse(readFileSync(new URL("./fixtures/noise-vectors.json", import.meta.url), "utf8")) as {
		vectors: Vector[];
	}
).vectors;

describe("Noise test vectors (cacophony)", () => {
	for (const vector of vectors) {
		it(vector.protocol_name, () => {
			const pattern = vector.protocol_name.split("_")[1] as HandshakePatternName;
			const initStatic = keyPairFromSecret(fromHex(vector.init_static));
			const respStatic = keyPairFromSecret(fromHex(vector.resp_static));
			const initiator = new Handshake({
				pattern,
				initiator: true,
				prologue: fromHex(vector.init_prologue),
				staticKeyPair: initStatic,
				ephemeralKeyPair: keyPairFromSecret(fromHex(vector.init_ephemeral)),
				...(vector.init_remote_static ? { remoteStaticKey: fromHex(vector.init_remote_static) } : {}),
			});
			const responder = new Handshake({
				pattern,
				initiator: false,
				prologue: fromHex(vector.resp_prologue),
				staticKeyPair: respStatic,
				ephemeralKeyPair: keyPairFromSecret(fromHex(vector.resp_ephemeral)),
			});
			const handshakeLength = pattern === "XX" ? 3 : 2;
			let i = 0;
			for (; i < handshakeLength; i++) {
				const message = vector.messages[i];
				if (!message) throw new Error("vector too short");
				const [writer, reader] = i % 2 === 0 ? [initiator, responder] : [responder, initiator];
				const ciphertext = writer.writeMessage(fromHex(message.payload));
				expect(toHex(ciphertext)).toBe(message.ciphertext);
				expect(toHex(reader.readMessage(ciphertext))).toBe(message.payload);
			}
			const a = initiator.finish();
			const b = responder.finish();
			expect(toHex(a.handshakeHash)).toBe(vector.handshake_hash);
			expect(toHex(b.handshakeHash)).toBe(vector.handshake_hash);
			expect(toHex(a.remoteStaticKey)).toBe(toHex(respStatic.publicKey));
			expect(toHex(b.remoteStaticKey)).toBe(toHex(initStatic.publicKey));
			// Transport messages alternate direction, starting with the initiator.
			for (; i < vector.messages.length; i++) {
				const message = vector.messages[i];
				if (!message) break;
				const [sender, receiver] = i % 2 === 0 ? [a.send, b.receive] : [b.send, a.receive];
				const ciphertext = sender.encryptWithAd(new Uint8Array(0), fromHex(message.payload));
				expect(toHex(ciphertext)).toBe(message.ciphertext);
				expect(toHex(receiver.decryptWithAd(new Uint8Array(0), ciphertext))).toBe(message.payload);
			}
		});
	}
});

describe("primitives", () => {
	it("encodes ChaChaPoly nonces as little-endian 64-bit counters", () => {
		expect(toHex(chachaNonce(1))).toBe("000000000100000000000000");
		expect(toHex(chachaNonce(2 ** 32 + 2))).toBe("000000000200000001000000");
	});

	it("does not advance the nonce on failed decryption", () => {
		const key = new Uint8Array(32).fill(7);
		const sender = new CipherState(key);
		const receiver = new CipherState(key);
		const good = sender.encryptWithAd(new Uint8Array(0), utf8Encode("hi"));
		const bad = good.slice();
		bad[0] = (bad[0] as number) ^ 1;
		expect(() => receiver.decryptWithAd(new Uint8Array(0), bad)).toThrow();
		expect(receiver.nonce).toBe(0);
		expect(utf8Decode(receiver.decryptWithAd(new Uint8Array(0), good))).toBe("hi");
	});

	it("round-trips UTF-8 (native and pure JS) including astral characters and invalid input", () => {
		const text = "hello 你好 🚀 ü";
		for (const [encode, decode] of [
			[utf8Encode, utf8Decode],
			[utf8EncodeJs, utf8DecodeJs],
		] as const) {
			expect(decode(encode(text))).toBe(text);
			expect(Buffer.from(encode(text)).toString("utf8")).toBe(text);
			expect(decode(Uint8Array.of(0xff, 0x41))).toBe("\ufffdA");
			expect(decode(encode("x".repeat(20_000)))).toHaveLength(20_000);
		}
		expect(utf8EncodeJs("\ud800x")).toEqual(utf8Encode("\ud800x"));
	});

	it("decodes base64 strictly enough", () => {
		expect(toHex(fromBase64(toBase64(Uint8Array.of(1, 2, 3, 250))))).toBe("010203fa");
		expect(() => fromBase64("abc")).toThrow();
		expect(() => fromBase64("ab$d")).toThrow();
	});

	it("formats key fingerprints in groups of four", () => {
		const fp = keyFingerprint(generateKeyPair().publicKey);
		expect(fp).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
	});
});

function connectPair(
	hostKeys = generateKeyPair(),
	deviceKeys = generateKeyPair(),
	known = true,
): { device: SecureTransport; host: SecureTransport } {
	const initiator = new ConnectInitiator({ deviceKeyPair: deviceKeys, hostPublicKey: hostKeys.publicKey });
	const responder = new ChannelResponder({
		hostKeyPair: hostKeys,
		hostHello: { hostId: "h", hostName: "Host" },
		isKnownDevice: () => known,
		pairingOpen: () => false,
	});
	const step = responder.receive(initiator.start());
	if (step.kind !== "connected") throw new Error(step.kind);
	return { device: initiator.receive(step.frame), host: step.transport };
}

describe("secure channel", () => {
	it("connects with IK and exchanges frames in both directions", () => {
		const { device, host } = connectPair();
		expect(host.open(device.seal('{"type":"req"}'))).toBe('{"type":"req"}');
		expect(device.open(host.seal("你好"))).toBe("你好");
		expect(toHex(device.handshakeHash)).toBe(toHex(host.handshakeHash));
		const big = "x".repeat(300_000);
		expect(host.open(device.seal(big))).toBe(big);
	});

	it("rejects unknown devices before answering", () => {
		expect(() => connectPair(undefined, undefined, false)).toThrowError(
			expect.objectContaining({ code: "UNKNOWN_DEVICE" }),
		);
	});

	it("fails the handshake when the device targets the wrong host key", () => {
		const hostKeys = generateKeyPair();
		const initiator = new ConnectInitiator({
			deviceKeyPair: generateKeyPair(),
			hostPublicKey: generateKeyPair().publicKey,
		});
		const responder = new ChannelResponder({
			hostKeyPair: hostKeys,
			hostHello: { hostId: "h", hostName: "Host" },
			isKnownDevice: () => true,
			pairingOpen: () => false,
		});
		expect(() => responder.receive(initiator.start())).toThrowError(ChannelError);
	});

	it("detects tampering, replay and reordering", () => {
		const { device, host } = connectPair();
		const first = device.seal("one");
		const second = device.seal("two");
		const tampered = JSON.parse(first) as { c: string };
		// Change the first character (to a different one: the ciphertext may already start with "A").
		tampered.c = `${tampered.c.startsWith("A") ? "B" : "A"}${tampered.c.slice(1)}`;
		expect(() => host.open(JSON.stringify({ ...JSON.parse(first), c: tampered.c }))).toThrow();
		expect(() => host.open(second)).toThrow(/nonce/);
		expect(host.open(first)).toBe("one");
		expect(() => host.open(first)).toThrow(/nonce/);
		expect(host.open(second)).toBe("two");
	});

	it("does not leak plaintext into sealed frames", () => {
		const { device } = connectPair();
		const frame = device.seal('{"method":"session.prompt","text":"rm -rf secret-project"}');
		expect(frame).not.toContain("secret");
		expect(frame).not.toContain("session.prompt");
	});
});

describe("pairing handshake", () => {
	function setup(options: { expectedHostKey?: Uint8Array; pairingOpen?: boolean } = {}) {
		const hostKeys = generateKeyPair();
		const deviceKeys = generateKeyPair();
		const initiator = new PairInitiator({
			deviceKeyPair: deviceKeys,
			expectedHostKey: options.expectedHostKey ?? hostKeys.publicKey,
			code: "secret-code",
			device: { name: "Pixel", platform: "android" },
		});
		const responder = new ChannelResponder({
			hostKeyPair: hostKeys,
			hostHello: { hostId: "host-1", hostName: "Workstation" },
			isKnownDevice: () => false,
			pairingOpen: () => options.pairingOpen ?? true,
		});
		return { hostKeys, deviceKeys, initiator, responder };
	}

	it("runs XX, delivers the code and device name, and returns the result", () => {
		const { deviceKeys, initiator, responder } = setup();
		const step1 = responder.receive(initiator.start());
		expect(step1.kind).toBe("continue");
		if (step1.kind !== "continue") return;
		const reply = initiator.receive(step1.frame);
		expect(initiator.hostHello).toEqual({ hostId: "host-1", hostName: "Workstation" });
		if (!("send" in reply)) throw new Error("expected message 3");
		const step2 = responder.receive(reply.send);
		if (step2.kind !== "pairRequest") throw new Error(step2.kind);
		expect(step2.request).toMatchObject({ code: "secret-code", device: { name: "Pixel", platform: "android" } });
		expect(toHex(step2.remoteStaticKey)).toBe(toHex(deviceKeys.publicKey));
		const done = initiator.receive(
			step2.transport.seal(JSON.stringify({ ok: true, deviceId: "d1", hostId: "host-1", hostName: "Workstation" })),
		);
		expect(done).toEqual({ result: { ok: true, deviceId: "d1", hostId: "host-1", hostName: "Workstation" } });
	});

	it("aborts when the host key differs from the QR code (interception)", () => {
		const { initiator, responder } = setup({ expectedHostKey: generateKeyPair().publicKey });
		const step = responder.receive(initiator.start());
		if (step.kind !== "continue") throw new Error(step.kind);
		expect(() => initiator.receive(step.frame)).toThrow(/does not match/);
	});

	it("refuses pairing when no pairing code is active", () => {
		const { initiator, responder } = setup({ pairingOpen: false });
		expect(() => responder.receive(initiator.start())).toThrowError(
			expect.objectContaining({ code: "PAIRING_INVALID" }),
		);
	});

	it("surfaces host error frames on the device", () => {
		const { initiator } = setup();
		initiator.start();
		expect(() => initiator.receive('{"t":"error","code":"PAIRING_REJECTED","message":"no"}')).toThrowError(
			expect.objectContaining({ code: "PAIRING_REJECTED" }),
		);
	});
});

describe("pairing URI", () => {
	const info = {
		hostId: "0b7f0e8e-1111-2222-3333-444455556666",
		hostName: "Xiaohui 的工作站 & more",
		hostPublicKey: generateKeyPair().publicKey,
		addresses: ["192.168.1.20:7433", "[fd7a:115c:a1e0::1]:7433", "100.64.0.3:7433"],
		code: "Zm9vYmFyYmF6cXV4",
	};

	it("round-trips", () => {
		const uri = formatPairingUri(info);
		expect(uri.startsWith("pier://pair?v=1&")).toBe(true);
		const parsed = parsePairingUri(uri);
		expect(parsed.hostName).toBe(info.hostName);
		expect(parsed.addresses).toEqual(info.addresses);
		expect(toHex(parsed.hostPublicKey)).toBe(toHex(info.hostPublicKey));
		expect(parsed.code).toBe(info.code);
	});

	it("rejects invalid codes with readable errors", () => {
		expect(() => parsePairingUri("https://example.com")).toThrow(PairingUriError);
		expect(() => parsePairingUri(formatPairingUri({ ...info, addresses: [] }))).toThrow(/address/);
		expect(() => parsePairingUri(formatPairingUri(info).replace("v=1", "v=9"))).toThrow(/version/);
		expect(() => parsePairingUri(formatPairingUri({ ...info, hostPublicKey: new Uint8Array(5) }))).toThrow(/key/);
	});
});

describe("benchmark", () => {
	it("runs quickly with a tiny budget", async () => {
		const results = await runChannelBenchmark({ budgetMs: 5, frameSizes: [1024] });
		expect(results.map((r) => r.name)).toEqual([
			"X25519 key pair",
			"Noise IK handshake (both sides)",
			"seal + open 1 KiB frame",
		]);
		expect(results.every((r) => r.meanMs > 0)).toBe(true);
	});
});
