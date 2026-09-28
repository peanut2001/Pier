import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PierSessionEvent } from "@pier/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { ExternalChangeGuard, SessionLock } from "../src/session-lock.ts";
import { UiBridge } from "../src/ui-bridge.ts";

const root = mkdtempSync(join(tmpdir(), "pier-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function bridge(timeoutMs?: number) {
	const events: PierSessionEvent[] = [];
	const b = new UiBridge({
		sessionId: () => "s1",
		emit: (e) => events.push(e),
		...(timeoutMs === undefined ? {} : { defaultTimeoutMs: timeoutMs }),
	});
	return { b, events };
}

describe("UiBridge", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("broadcasts requests and resolves with the first answer", async () => {
		const { b, events } = bridge();
		const promise = b.request({ kind: "confirm", title: "Sure?" });
		const request = b.pendingRequests[0];
		expect(request).toMatchObject({ kind: "confirm", sessionId: "s1", title: "Sure?" });
		expect(events[0]).toMatchObject({ type: "ui.request" });

		expect(b.respond(request?.id ?? "", { confirmed: true }, "conn-a")).toBe(true);
		expect(b.respond(request?.id ?? "", { confirmed: false }, "conn-b")).toBe(false);
		await expect(promise).resolves.toEqual({ confirmed: true });
		expect(events[1]).toEqual({
			type: "ui.resolved",
			requestId: request?.id,
			resolution: "answered",
			response: { confirmed: true },
			by: "conn-a",
		});
		expect(b.pendingRequests).toHaveLength(0);
	});

	it("validates responses against the request kind", () => {
		const { b } = bridge();
		void b.request({ kind: "select", title: "Pick", options: ["a", "b"] });
		const id = b.pendingRequests[0]?.id ?? "";
		expect(() => b.respond(id, { confirmed: true })).toThrow(/value/);
		expect(() => b.respond(id, { value: "c" })).toThrow(/not an option/);
		expect(b.respond(id, { value: "b" })).toBe(true);
	});

	it("rejects allow_session when it is not offered", () => {
		const { b } = bridge();
		void b.request({
			kind: "approval",
			title: "Allow?",
			approval: {
				toolName: "bash",
				toolCallId: "t",
				summary: "rm -rf /",
				input: {},
				reason: "danger",
				severity: "high",
				sessionAllowable: false,
			},
		});
		const id = b.pendingRequests[0]?.id ?? "";
		expect(() => b.respond(id, { decision: "allow_session" })).toThrow(/not offered/);
		expect(b.respond(id, { decision: "deny", reason: "no" })).toBe(true);
	});

	it("times out with the default (undefined) answer", async () => {
		const { b, events } = bridge(1000);
		const promise = b.request({ kind: "input", title: "Name?" });
		expect(b.pendingRequests[0]?.expiresAt).toBeDefined();
		vi.advanceTimersByTime(1000);
		await expect(promise).resolves.toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: "ui.resolved", resolution: "timeout" });
	});

	it("stays pending with no timeout when disabled, and cancels on abort", async () => {
		const { b, events } = bridge(0);
		const controller = new AbortController();
		const promise = b.request({ kind: "input", title: "Name?" }, { signal: controller.signal });
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(b.pendingRequests).toHaveLength(1);
		controller.abort();
		await expect(promise).resolves.toBeUndefined();
		expect(events.at(-1)).toMatchObject({ type: "ui.resolved", resolution: "cancelled" });
	});

	it("tracks status, widget, and title state for snapshots", () => {
		const { b } = bridge();
		b.setStatus("git", "main");
		b.setWidget("todo", ["a", "b"], "belowEditor");
		b.setTitle("Hello");
		expect(Object.fromEntries(b.statuses)).toEqual({ git: "main" });
		expect(Object.fromEntries(b.widgets)).toEqual({ todo: { lines: ["a", "b"], placement: "belowEditor" } });
		b.setStatus("git", undefined);
		b.setWidget("todo", undefined);
		expect(b.statuses.size).toBe(0);
		expect(b.widgets.size).toBe(0);
		expect(b.title).toBe("Hello");
	});
});

describe("ConfigStore", () => {
	it("creates a private default config and persists workspaces", () => {
		const path = join(root, "cfg", "config.json");
		const store = new ConfigStore(path);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(store.defaultPolicy).toBe("smart");
		const ws = store.addWorkspace({ path: "/tmp/x", name: "x" });
		expect(store.addWorkspace({ path: "/tmp/x", name: "again" }).id).toBe(ws.id);
		expect(store.setWorkspacePolicy(ws.id, "ask")?.policy).toBe("ask");

		const reloaded = new ConfigStore(path);
		expect(reloaded.hostId).toBe(store.hostId);
		expect(reloaded.listWorkspaces()).toMatchObject([{ id: ws.id, policy: "ask" }]);
		expect(reloaded.removeWorkspace(ws.id)).toBe(true);
		expect(reloaded.removeWorkspace(ws.id)).toBe(false);
	});

	it("refuses an invalid config file", () => {
		const path = join(root, "bad.json");
		writeFileSync(path, JSON.stringify({ version: 2 }));
		expect(() => new ConfigStore(path)).toThrow(/Invalid Pier config/);
	});
});

describe("SessionLock", () => {
	it("blocks a live foreign holder and replaces stale locks", () => {
		const locks = join(root, "locks");
		const file = join(root, "session.jsonl");
		const lock = SessionLock.acquire(locks, file);
		const content = JSON.parse(readFileSync(lock.lockPath, "utf8"));
		expect(content.pid).toBe(process.pid);

		// Pretend the parent process (alive, not us) holds it.
		writeFileSync(lock.lockPath, JSON.stringify({ ...content, pid: process.ppid }));
		expect(() => SessionLock.acquire(locks, file)).toThrow(/another Pier host/);

		// A dead pid is stale.
		writeFileSync(lock.lockPath, JSON.stringify({ ...content, pid: 2 ** 22 + 12345 }));
		const again = SessionLock.acquire(locks, file);
		again.release();
		again.release();
	});
});

describe("ExternalChangeGuard", () => {
	it("detects writes made after the last recorded stamp", () => {
		const file = join(root, "guarded.jsonl");
		writeFileSync(file, "a\n");
		const guard = new ExternalChangeGuard(file);
		expect(guard.changedExternally()).toBe(false);
		writeFileSync(file, "a\nb\n");
		expect(guard.changedExternally()).toBe(true);
		guard.record();
		expect(guard.changedExternally()).toBe(false);
		expect(new ExternalChangeGuard(undefined).changedExternally()).toBe(false);
	});
});
