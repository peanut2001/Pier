import { describe, expect, it } from "vitest";
import { DATA_CHANNEL_CHUNK, dataChannelPath, mergeIceServers, type RtcDataChannelLike } from "../src/p2p.ts";

/** Two fake data channels wired to each other (ordered, reliable, async like the real thing). */
function channelPair(): [RtcDataChannelLike & { sent: string[] }, RtcDataChannelLike & { sent: string[] }] {
	const make = () => {
		const channel = {
			readyState: "open",
			bufferedAmount: 0,
			sent: [] as string[],
			peer: undefined as unknown as { onmessage: ((e: { data: unknown }) => void) | null },
			onopen: null,
			onclose: null as ((e: unknown) => void) | null,
			onerror: null,
			onmessage: null as ((e: { data: unknown }) => void) | null,
			send(data: string) {
				channel.sent.push(data);
				setTimeout(() => channel.peer.onmessage?.({ data }), 0);
			},
			close() {
				channel.readyState = "closed";
				channel.onclose?.({});
			},
		};
		return channel;
	};
	const a = make();
	const b = make();
	a.peer = b;
	b.peer = a;
	return [a, b];
}

describe("data channel path", () => {
	it("batches small frames and splits large ones, delivering every frame intact and in order", async () => {
		const [a, b] = channelPair();
		const received: string[] = [];
		const sender = dataChannelPath(a, { frame: () => {}, close: () => {} });
		dataChannelPath(b, { frame: (text) => received.push(text), close: () => {} });
		const small = Array.from({ length: 100 }, (_, i) => `{"t":"enc","n":${i},"c":"abc"}`);
		for (const frame of small) sender.send(frame);
		const big = `{"t":"enc","n":100,"c":"${"A".repeat(3 * DATA_CHANNEL_CHUNK + 17)}"}`;
		sender.send(big);
		sender.send("");
		await new Promise((r) => setTimeout(r, 50));
		expect(received).toEqual([...small, big, ""]);
		// Frames sent in the same tick share messages; none exceeds the chunk size.
		expect(a.sent.length).toBe(4);
		expect(Math.max(...a.sent.map((m) => m.length))).toBeLessThanOrEqual(DATA_CHANNEL_CHUNK);
	});

	it("closes on a malformed stream", async () => {
		const [a, b] = channelPair();
		let reason: string | undefined;
		dataChannelPath(b, { frame: () => {}, close: (r) => (reason = r) });
		a.send("not-a-length:x");
		await new Promise((r) => setTimeout(r, 10));
		expect(reason).toMatch(/Malformed/);
		expect(b.readyState).toBe("closed");
	});

	it("merges ICE server lists without duplicates", () => {
		expect(
			mergeIceServers(
				[{ urls: "stun:a:3478" }],
				[{ urls: ["stun:a:3478", "stun:b:3478"] }, { urls: "turn:t", username: "u", credential: "p" }],
				undefined,
			),
		).toEqual([
			{ urls: ["stun:a:3478"] },
			{ urls: ["stun:b:3478"] },
			{ urls: ["turn:t"], username: "u", credential: "p" },
		]);
	});
});
