/**
 * A `TerminalBridge` over a Pier connection: shells another computer's Pier Host runs for
 * this one (`terminal.*`, protocol 1.16).
 *
 * A remote terminal belongs to one connection: when it drops, the host hangs the shell up,
 * so the tab ends with an explanation instead of silently reattaching to nothing.
 */

import type { PierClient } from "@pier/client";
import type { TerminalBridge, TerminalHandlers } from "./bridge.ts";

/** The parts of a `PierClient` the bridge uses. */
export type TerminalClient = Pick<PierClient, "request" | "onEvent" | "onState">;

/** Keep each `terminal.write` well under the protocol's 1 MB limit. */
const WRITE_CHUNK = 64 * 1024;
/** Events for a terminal id not registered yet (should not happen: the host sends the id first). */
const MAX_EARLY_EVENTS = 256;

export function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Split text into chunks of at most `size` UTF-16 units without breaking surrogate pairs. */
export function chunkText(text: string, size = WRITE_CHUNK): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + size, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}

interface RemoteTerminal {
	id: number;
	terminalId: string;
	handlers: TerminalHandlers;
}

type TerminalEvent =
	| { type: "terminal.output"; terminalId: string; data: string }
	| { type: "terminal.exit"; terminalId: string; code: number | null; error?: string };

/**
 * A `TerminalBridge` over one client. The bridge's numeric ids map to the host's terminal ids.
 * `hostName` names the computer in messages.
 */
export function remoteTerminalBridge(client: TerminalClient, hostName: () => string): TerminalBridge {
	const byId = new Map<number, RemoteTerminal>();
	const byTerminalId = new Map<string, RemoteTerminal>();
	const early: TerminalEvent[] = [];
	let nextId = 0;

	const dispatch = (terminal: RemoteTerminal, event: TerminalEvent) => {
		if (event.type === "terminal.output") {
			terminal.handlers.output(decodeBase64(event.data));
			return;
		}
		byId.delete(terminal.id);
		byTerminalId.delete(terminal.terminalId);
		terminal.handlers.exit(event.code, event.error ? `${hostName()} 上的终端已丢失：${event.error}` : undefined);
	};

	client.onEvent((frame) => {
		if (frame.sessionId) return;
		const event = frame.event as unknown as TerminalEvent;
		if (event.type !== "terminal.output" && event.type !== "terminal.exit") return;
		if (typeof event.terminalId !== "string") return;
		const terminal = byTerminalId.get(event.terminalId);
		if (terminal) dispatch(terminal, event);
		else if (early.length < MAX_EARLY_EVENTS) early.push(event);
	});
	client.onState((state) => {
		if (state === "open") return;
		// The host hangs up a connection's shells when it closes; a reconnect gets a new one.
		early.length = 0;
		const lost = [...byId.values()];
		byId.clear();
		byTerminalId.clear();
		for (const terminal of lost) terminal.handlers.exit(null, `与 ${hostName()} 的连接已断开，终端已关闭`);
	});

	return {
		spawn: async ({ cwd, cols, rows }, handlers) => {
			const size = (n: number) => Math.min(1000, Math.max(2, Math.round(n) || 2));
			const result = await client.request("terminal.open", {
				...(cwd ? { cwd } : {}),
				cols: size(cols),
				rows: size(rows),
			});
			const id = ++nextId;
			const terminal: RemoteTerminal = { id, terminalId: result.terminalId, handlers };
			byId.set(id, terminal);
			byTerminalId.set(result.terminalId, terminal);
			const pending = early.filter((e) => e.terminalId === result.terminalId);
			if (pending.length) {
				early.splice(0, early.length, ...early.filter((e) => e.terminalId !== result.terminalId));
				// After the caller has the id, like live events.
				queueMicrotask(() => {
					for (const event of pending) if (byTerminalId.get(event.terminalId) === terminal) dispatch(terminal, event);
				});
			}
			return { id, shell: result.shell, cwd: result.cwd };
		},
		write: async (id, data, binary) => {
			const terminal = byId.get(id);
			if (!terminal) throw new Error("终端已关闭");
			for (const chunk of chunkText(data)) {
				if (!chunk) continue;
				await client.request("terminal.write", {
					terminalId: terminal.terminalId,
					data: chunk,
					...(binary ? { binary: true } : {}),
				});
			}
		},
		resize: async (id, cols, rows) => {
			const terminal = byId.get(id);
			if (!terminal) return;
			const size = (n: number) => Math.min(1000, Math.max(2, n));
			await client.request("terminal.resize", { terminalId: terminal.terminalId, cols: size(cols), rows: size(rows) });
		},
		kill: async (id) => {
			const terminal = byId.get(id);
			if (!terminal) return;
			await client.request("terminal.close", { terminalId: terminal.terminalId });
		},
		// Nothing outlives a page reload: the host hangs up when the connection closes.
		killAll: async () => {},
	};
}
