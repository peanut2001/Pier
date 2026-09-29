import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import { LOCAL_ONLY_METHODS, type PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySettingsChange } from "../src/pi/settings-files.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	return (error as PierProtocolError | undefined)?.code;
}

describe("applySettingsChange", () => {
	it("sets nested keys, creating objects on the way", () => {
		const settings: Record<string, unknown> = { theme: "dark" };
		applySettingsChange(settings, { path: ["compaction", "enabled"], value: false });
		applySettingsChange(settings, { path: ["retry", "provider", "maxRetries"], value: 2 });
		expect(settings).toEqual({ theme: "dark", compaction: { enabled: false }, retry: { provider: { maxRetries: 2 } } });
	});

	it("removes keys and prunes the objects they leave empty", () => {
		const settings: Record<string, unknown> = { retry: { enabled: true, provider: { maxRetries: 2 } } };
		applySettingsChange(settings, { path: ["retry", "provider", "maxRetries"] });
		expect(settings).toEqual({ retry: { enabled: true } });
		applySettingsChange(settings, { path: ["retry", "enabled"] });
		expect(settings).toEqual({});
		applySettingsChange(settings, { path: ["missing", "key"] });
		expect(settings).toEqual({});
	});

	it("refuses to descend into values that are not objects", () => {
		const settings: Record<string, unknown> = { terminal: "odd" };
		expect(() => applySettingsChange(settings, { path: ["terminal", "showImages"], value: true })).toThrow(
			/not an object/,
		);
		expect(() => applySettingsChange(settings, { path: ["__proto__", "polluted"], value: true })).toThrow();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("pi settings files", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let userPath: string;
	let projectPath: string;

	beforeEach(async () => {
		t = await startTestHost({ fileSettings: true });
		userPath = join(t.root, "agent", "settings.json");
		projectPath = join(t.workspaceDir, ".pi", "settings.json");
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
	});

	it("is open to paired devices", () => {
		for (const method of ["settings.get", "settings.update", "settings.write"] as const) {
			expect(LOCAL_ONLY_METHODS.has(method), method).toBe(false);
		}
	});

	it("reads the user and project files as stored", async () => {
		const user = await client.request("settings.get");
		expect(user.agentDir).toBe(join(t.root, "agent"));
		expect(user.user).toMatchObject({
			scope: "user",
			path: userPath,
			exists: true,
			settings: { defaultProvider: "faux", defaultModel: "faux-1" },
		});
		expect(user.user.modifiedAt).toBeTypeOf("string");
		expect(user.project).toBeUndefined();

		const both = await client.request("settings.get", { workspaceId: workspace.id });
		expect(both.project).toEqual({
			scope: "project",
			path: projectPath,
			exists: false,
			text: "",
			settings: {},
			workspaceId: workspace.id,
		});
	});

	it("updates individual keys, keeps unknown ones, and reloads open sessions", async () => {
		writeFileSync(userPath, `${JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", custom: [1] })}\n`);
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		const events = new Recorder();
		client.onEvent(events.handler);

		const result = await client.request("settings.update", {
			scope: "user",
			changes: [
				{ path: ["defaultThinkingLevel"], value: "high" },
				{ path: ["compaction", "enabled"], value: false },
			],
		});
		expect(result.changed).toBe(true);
		expect(result.reload).toEqual({ reloaded: 1, pending: 0, failed: 0 });
		expect(result.file.settings).toEqual({
			defaultProvider: "faux",
			defaultModel: "faux-1",
			custom: [1],
			defaultThinkingLevel: "high",
			compaction: { enabled: false },
		});
		const text = readFileSync(userPath, "utf8");
		expect(text).toBe(`${JSON.stringify(result.file.settings, null, 2)}\n`);
		await events.waitFor((f) => f.event.type === "settings.changed");
		expect(events.types()).toEqual(
			expect.arrayContaining(["settings.changed", "extension.changed", "provider.changed"]),
		);

		// A new session starts with the saved thinking level.
		const next = await client.request("session.create", { workspaceId: workspace.id });
		expect((await client.request("session.snapshot", { sessionId: next.session.id })).thinkingLevel).toBe("high");
		expect(session.id).not.toBe(next.session.id);

		const removed = await client.request("settings.update", {
			scope: "user",
			changes: [{ path: ["compaction", "enabled"] }],
			reload: false,
		});
		expect(removed.reload).toEqual({ reloaded: 0, pending: 0, failed: 0 });
		expect(readJson(userPath).compaction).toBeUndefined();

		const unchanged = await client.request("settings.update", { scope: "user", changes: [{ path: ["nothing"] }] });
		expect(unchanged.changed).toBe(false);
	});

	it("writes project settings into the workspace", async () => {
		const events = new Recorder();
		client.onEvent(events.handler);
		expect(
			await codeOf(client.request("settings.update", { scope: "project", changes: [{ path: ["theme"], value: "x" }] })),
		).toBe("BAD_REQUEST");
		const result = await client.request("settings.update", {
			scope: "project",
			workspaceId: workspace.id,
			changes: [{ path: ["steeringMode"], value: "all" }],
		});
		expect(result.file).toMatchObject({ scope: "project", path: projectPath, exists: true });
		expect(readJson(projectPath)).toEqual({ steeringMode: "all" });
		const changed = await events.waitFor((f) => f.event.type === "settings.changed");
		expect(changed.event).toEqual({ type: "settings.changed", scope: "project", workspaceId: workspace.id });
		expect(events.types()).not.toContain("provider.changed");
	});

	it("replaces the file as text and detects concurrent edits", async () => {
		const { user } = await client.request("settings.get");
		const text = '{\n  "defaultProvider": "faux",\n  "defaultModel": "faux-1",\n  "quietStartup": true\n}\n';
		const written = await client.request("settings.write", {
			scope: "user",
			text,
			...(user.modifiedAt ? { expectedModifiedAt: user.modifiedAt } : {}),
		});
		expect(written.changed).toBe(true);
		expect(readFileSync(userPath, "utf8")).toBe(text);

		expect(
			await codeOf(
				client.request("settings.write", { scope: "user", text: "{}", expectedModifiedAt: "2000-01-01T00:00:00.000Z" }),
			),
		).toBe("CONFLICT");
		expect(await codeOf(client.request("settings.write", { scope: "user", text: "[1, 2]" }))).toBe("BAD_REQUEST");
		expect(await codeOf(client.request("settings.write", { scope: "user", text: "{ nope" }))).toBe("BAD_REQUEST");
		expect(readFileSync(userPath, "utf8")).toBe(text);
	});

	it("reports files it cannot parse and refuses to patch them", async () => {
		mkdirSync(join(t.workspaceDir, ".pi"), { recursive: true });
		writeFileSync(projectPath, "{ broken");
		const { project } = await client.request("settings.get", { workspaceId: workspace.id });
		expect(project?.settings).toBeUndefined();
		expect(project?.error).toBeTypeOf("string");
		expect(project?.text).toBe("{ broken");
		expect(
			await codeOf(
				client.request("settings.update", {
					scope: "project",
					workspaceId: workspace.id,
					changes: [{ path: ["theme"], value: "dark" }],
				}),
			),
		).toBe("CONFLICT");
		// The text editor can still fix it.
		await client.request("settings.write", {
			scope: "project",
			workspaceId: workspace.id,
			text: '{ "theme": "dark" }',
		});
		expect(readJson(projectPath)).toEqual({ theme: "dark" });
	});

	it("rejects reserved keys", async () => {
		expect(
			await codeOf(client.request("settings.update", { scope: "user", changes: [{ path: ["__proto__"], value: 1 }] })),
		).toBe("BAD_REQUEST");
	});
});
