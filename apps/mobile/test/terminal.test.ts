import { describe, expect, it, vi } from "vitest";
import { chunkText, controlKey, paletteColor, RemoteTerminal } from "../src/terminal.ts";

function fakeClient() {
	const calls: { method: string; params: unknown }[] = [];
	const request = vi.fn(async (method: string, params: unknown) => {
		calls.push({ method, params });
		if (method === "terminal.open") return { terminalId: "t1", shell: "bash", cwd: "/home/me" };
		return {};
	});
	return { client: { request } as never, calls };
}

const encode = (text: string) => Buffer.from(text).toString("base64");

async function settle(terminal: RemoteTerminal): Promise<void> {
	await new Promise<void>((resolve) => {
		const off = terminal.subscribe(() => {
			off();
			resolve();
		});
	});
}

describe("RemoteTerminal", () => {
	it("opens a shell and renders colored output with the cursor", async () => {
		const { client, calls } = fakeClient();
		const terminal = new RemoteTerminal(1, client, { cols: 40, rows: 10, title: "终端" });
		await terminal.open();
		expect(calls[0]).toEqual({ method: "terminal.open", params: { cols: 40, rows: 10 } });
		expect(terminal.status).toBe("running");
		expect(terminal.cwd).toBe("/home/me");

		const done = settle(terminal);
		terminal.output(encode("hello \x1b[31mred\x1b[0m\r\n$ "));
		await done;
		const lines = terminal.render();
		expect(lines).toHaveLength(2);
		expect(lines[0]?.spans.map((s) => s.text).join("")).toBe("hello red");
		expect(lines[0]?.spans.find((s) => s.text === "red")?.fg).toBe(paletteColor(1));
		// The prompt line ends with the cursor cell.
		const prompt = lines[1]?.spans ?? [];
		expect(prompt.map((s) => s.text).join("")).toBe("$  ");
		expect(prompt.at(-1)?.bg).toBeDefined();
		terminal.dispose();
	});

	it("handles UTF-8 split across events", async () => {
		const { client } = fakeClient();
		const terminal = new RemoteTerminal(1, client, { cols: 20, rows: 5, title: "t" });
		await terminal.open();
		const bytes = Buffer.from("中文");
		const done = settle(terminal);
		terminal.output(bytes.subarray(0, 2).toString("base64"));
		terminal.output(bytes.subarray(2).toString("base64"));
		await done;
		expect(
			terminal
				.render()[0]
				?.spans.map((s) => s.text)
				.join(""),
		).toContain("中文");
		terminal.dispose();
	});

	it("sends input, resizes and reports the exit", async () => {
		const { client, calls } = fakeClient();
		const terminal = new RemoteTerminal(1, client, { cwd: "/w", cols: 30, rows: 8, title: "t" });
		await terminal.open();
		await terminal.send("ls\r");
		expect(calls.at(-1)).toEqual({ method: "terminal.write", params: { terminalId: "t1", data: "ls\r" } });
		terminal.resize(50, 12);
		expect(calls.at(-1)).toEqual({ method: "terminal.resize", params: { terminalId: "t1", cols: 50, rows: 12 } });
		expect(terminal.keySequence("up")).toBe("\x1b[A");
		terminal.exited(0);
		expect(terminal.status).toBe("exited");
		await terminal.send("x");
		expect(calls.at(-1)?.method).toBe("terminal.resize");
		terminal.dispose();
	});

	it("reports a failed start", async () => {
		const request = vi.fn(async () => {
			throw new Error("UNSUPPORTED");
		});
		const terminal = new RemoteTerminal(1, { request } as never, { cols: 30, rows: 8, title: "t" });
		await terminal.open();
		expect(terminal.status).toBe("exited");
		expect(terminal.error).toContain("UNSUPPORTED");
		terminal.dispose();
	});
});

describe("terminal helpers", () => {
	it("maps control keys", () => {
		expect(controlKey("c")).toBe("\x03");
		expect(controlKey("C")).toBe("\x03");
		expect(controlKey("[")).toBe("\x1b");
		expect(controlKey("1")).toBeUndefined();
	});

	it("maps the 256-color palette", () => {
		expect(paletteColor(16)).toBe("#000000");
		expect(paletteColor(231)).toBe("#ffffff");
		expect(paletteColor(232)).toBe("#080808");
	});

	it("chunks text without splitting surrogate pairs", () => {
		const text = `${"a".repeat(9)}😀b`;
		const chunks = chunkText(text, 10);
		expect(chunks.join("")).toBe(text);
		expect(chunks[0]).toBe("a".repeat(9));
	});
});
