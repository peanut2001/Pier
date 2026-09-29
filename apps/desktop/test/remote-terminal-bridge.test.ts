import type { ClientState } from "@pier/client";
import type { EventFrame } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	chunkText,
	decodeBase64,
	remoteTerminalBridge,
	type TerminalClient,
} from "../src/lib/remote-terminal-bridge.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

/** A connection whose host answers `terminal.*` and lets the test push events. */
function fakeClient() {
	const events = new Set<(frame: EventFrame) => void>();
	const states = new Set<(state: ClientState) => void>();
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	let opened = 0;
	const client = {
		request: async (method: string, params: Record<string, unknown>) => {
			requests.push({ method, params });
			if (method === "terminal.open") {
				opened++;
				return { terminalId: `term-${opened}`, shell: "bash", cwd: (params.cwd as string) ?? "/home/u" };
			}
			return {};
		},
		onEvent: (listener: (frame: EventFrame) => void) => {
			events.add(listener);
			return () => events.delete(listener);
		},
		onState: (listener: (state: ClientState) => void) => {
			states.add(listener);
			return () => states.delete(listener);
		},
	} as unknown as TerminalClient;
	return {
		client,
		requests,
		emit: (event: Record<string, unknown>) => {
			for (const listener of events) listener({ type: "evt", event: event as EventFrame["event"] });
		},
		setState: (state: ClientState) => {
			for (const listener of states) listener(state);
		},
	};
}

function recorder() {
	const output: string[] = [];
	const exits: Array<[number | null, string | undefined]> = [];
	return {
		output,
		exits,
		handlers: {
			output: (data: Uint8Array) => output.push(new TextDecoder().decode(data)),
			exit: (code: number | null, error?: string) => exits.push([code, error]),
		},
	};
}

describe("remote terminal helpers", () => {
	it("decodes base64 to bytes", () => {
		expect(new TextDecoder().decode(decodeBase64(b64("héllo 世界")))).toBe("héllo 世界");
		expect(decodeBase64("")).toEqual(new Uint8Array());
	});

	it("chunks text without splitting surrogate pairs", () => {
		expect(chunkText("abc", 10)).toEqual(["abc"]);
		expect(chunkText("abcdef", 4)).toEqual(["abcd", "ef"]);
		const emoji = "ab😀cd";
		const chunks = chunkText(emoji, 3);
		expect(chunks.join("")).toBe(emoji);
		for (const chunk of chunks) expect(chunk).not.toMatch(/[\ud800-\udbff]$/);
	});
});

describe("remoteTerminalBridge", () => {
	it("opens a terminal on the host and routes its events", async () => {
		const fake = fakeClient();
		const bridge = remoteTerminalBridge(fake.client, () => "Ubuntu");
		const a = recorder();
		const b = recorder();
		const first = await bridge.spawn({ cwd: "/srv/app", cols: 80, rows: 24 }, a.handlers);
		const second = await bridge.spawn({ cols: 0.4, rows: 5000 }, b.handlers);
		expect(first).toEqual({ id: 1, shell: "bash", cwd: "/srv/app" });
		expect(fake.requests[1]?.params).toEqual({ cols: 2, rows: 1000 });

		fake.emit({ type: "terminal.output", terminalId: "term-1", data: b64("one") });
		fake.emit({ type: "terminal.output", terminalId: "term-2", data: b64("two") });
		fake.emit({ type: "terminal.output", terminalId: "other", data: b64("nobody") });
		expect(a.output).toEqual(["one"]);
		expect(b.output).toEqual(["two"]);

		await bridge.write(first.id, "ls\r", false);
		await bridge.write(first.id, "\x1b[M", true);
		await bridge.resize(first.id, 100, 30);
		await bridge.kill(second.id);
		expect(fake.requests.slice(2)).toEqual([
			{ method: "terminal.write", params: { terminalId: "term-1", data: "ls\r" } },
			{ method: "terminal.write", params: { terminalId: "term-1", data: "\x1b[M", binary: true } },
			{ method: "terminal.resize", params: { terminalId: "term-1", cols: 100, rows: 30 } },
			{ method: "terminal.close", params: { terminalId: "term-2" } },
		]);

		fake.emit({ type: "terminal.exit", terminalId: "term-2", code: null });
		fake.emit({ type: "terminal.exit", terminalId: "term-1", code: 0 });
		expect(a.exits).toEqual([[0, undefined]]);
		expect(b.exits).toEqual([[null, undefined]]);
		await expect(bridge.write(first.id, "x", false)).rejects.toThrow("终端已关闭");
	});

	it("splits large pastes into several writes", async () => {
		const fake = fakeClient();
		const bridge = remoteTerminalBridge(fake.client, () => "Ubuntu");
		const { id } = await bridge.spawn({ cols: 80, rows: 24 }, recorder().handlers);
		const paste = "x".repeat(150 * 1024);
		await bridge.write(id, paste, false);
		const writes = fake.requests.filter((r) => r.method === "terminal.write").map((r) => r.params.data as string);
		expect(writes.length).toBe(3);
		expect(writes.join("")).toBe(paste);
	});

	it("ends its terminals when the connection drops, and explains lost ones", async () => {
		const fake = fakeClient();
		const bridge = remoteTerminalBridge(fake.client, () => "Ubuntu");
		const a = recorder();
		const b = recorder();
		await bridge.spawn({ cols: 80, rows: 24 }, a.handlers);
		await bridge.spawn({ cols: 80, rows: 24 }, b.handlers);
		fake.emit({ type: "terminal.exit", terminalId: "term-1", code: null, error: "The desktop app is not reachable" });
		expect(a.exits).toEqual([[null, "Ubuntu 上的终端已丢失：The desktop app is not reachable"]]);

		fake.setState("open");
		expect(b.exits).toEqual([]);
		fake.setState("reconnecting");
		expect(b.exits).toEqual([[null, "与 Ubuntu 的连接已断开，终端已关闭"]]);
		fake.setState("closed");
		expect(b.exits.length).toBe(1);
	});
});
