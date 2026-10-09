import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { PierClient } from "@pier/client";
import { LOCAL_ONLY_METHODS, PierProtocolError, type SessionSummary, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, Recorder, startTestHost, type TestHost } from "./helpers.ts";

function extensionSource(command: string): string {
	return `export default function (pi) {\n\tpi.registerCommand(${JSON.stringify(command)}, { description: "From a test extension", handler: async () => {} });\n}\n`;
}

function skillSource(name: string): string {
	return `---\nname: ${name}\ndescription: A test skill\n---\n\nBody\n`;
}

function settingsOf(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("extension management", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let agentDir: string;
	let pkgDir: string;

	beforeEach(async () => {
		t = await startTestHost({ fileSettings: true });
		agentDir = join(t.root, "agent");
		pkgDir = join(t.root, "demo-package");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		mkdirSync(join(pkgDir, "skills", "demo-skill"), { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "demo-package",
				version: "1.2.3",
				description: "A demo pi package",
				keywords: ["pi-package"],
			}),
		);
		writeFileSync(join(pkgDir, "extensions", "demo.js"), extensionSource("demo-cmd"));
		writeFileSync(
			join(pkgDir, "skills", "demo-skill", "SKILL.md"),
			"---\nname: demo-skill\ndescription: A demo skill\n---\n\nBody\n",
		);
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
	});

	async function newSession(): Promise<{ session: SessionSummary; rec: Recorder }> {
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		return { session, rec };
	}

	async function commandNames(sessionId: string): Promise<string[]> {
		return (await client.request("session.commands", { sessionId })).commands.map((c) => c.name);
	}

	it("lets paired devices manage extensions (1.10)", () => {
		for (const method of [
			"extension.list",
			"extension.install",
			"extension.remove",
			"extension.update",
			"extension.checkUpdates",
			"extension.setEnabled",
			"extension.delete",
		] as const) {
			expect(LOCAL_ONLY_METHODS.has(method), method).toBe(false);
		}
	});

	it("installs a local package, reloads open sessions, and removes it", async () => {
		const { session } = await newSession();
		expect(await commandNames(session.id)).not.toContain("demo-cmd");
		const events = new Recorder();
		client.onEvent(events.handler);

		const installed = await client.request("extension.install", { source: pkgDir });
		expect(installed.package).toMatchObject({
			// Settings keep local paths relative to the settings file (with the platform separator, as pi writes them).
			source: relative(agentDir, pkgDir),
			installedPath: pkgDir,
			scope: "user",
			kind: "local",
			name: "demo-package",
			version: "1.2.3",
			description: "A demo pi package",
		});
		expect(installed.reload).toEqual({ reloaded: 1, pending: 0, failed: 0 });
		await events.waitForType("extension.changed");
		expect(await commandNames(session.id)).toContain("demo-cmd");
		expect(await commandNames(session.id)).toContain("skill:demo-skill");
		expect(settingsOf(join(agentDir, "settings.json")).packages).toHaveLength(1);

		const listed = await client.request("extension.list");
		expect(listed.agentDir).toBe(agentDir);
		expect(listed.packages).toHaveLength(1);
		const fromPackage = listed.resources.filter((r) => r.origin === "package");
		expect(fromPackage.map((r) => [r.type, r.name, r.enabled, r.deletable])).toEqual(
			expect.arrayContaining([
				["extensions", "demo.js", true, false],
				["skills", "demo-skill", true, false],
			]),
		);

		const source = listed.packages[0]?.source ?? "";
		const removed = await client.request("extension.remove", { source, scope: "user" });
		expect(removed).toEqual({ removed: true, reload: { reloaded: 1, pending: 0, failed: 0 } });
		expect(await commandNames(session.id)).not.toContain("demo-cmd");
		expect((await client.request("extension.list")).packages).toEqual([]);
		// Local packages are only unlinked, never deleted.
		expect(existsSync(pkgDir)).toBe(true);

		expect(await client.request("extension.remove", { source, scope: "user" })).toEqual({
			removed: false,
			reload: { reloaded: 0, pending: 0, failed: 0 },
		});
	});

	it("enables and disables package resources through the package filter", async () => {
		await client.request("extension.install", { source: pkgDir });
		const { session } = await newSession();
		const path = join(pkgDir, "extensions", "demo.js");

		const off = await client.request("extension.setEnabled", { type: "extensions", path, enabled: false });
		expect(off.resource).toMatchObject({ path, enabled: false, origin: "package" });
		expect(off.reload.reloaded).toBe(1);
		expect(settingsOf(join(agentDir, "settings.json")).packages).toEqual([
			{ source: relative(agentDir, pkgDir), extensions: [`-${join("extensions", "demo.js")}`] },
		]);
		expect(await commandNames(session.id)).not.toContain("demo-cmd");
		// The skill of the same package is unaffected.
		expect(await commandNames(session.id)).toContain("skill:demo-skill");

		const on = await client.request("extension.setEnabled", { type: "extensions", path, enabled: true });
		expect(on.resource.enabled).toBe(true);
		expect(await commandNames(session.id)).toContain("demo-cmd");

		const missing = await client
			.request("extension.setEnabled", { type: "extensions", path: join(pkgDir, "nope.js"), enabled: true })
			.catch((e: unknown) => e);
		expect((missing as PierProtocolError).code).toBe("NOT_FOUND");
	});

	it("disables and deletes extensions in the extensions directory", async () => {
		mkdirSync(join(agentDir, "extensions", "multi"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "single.js"), extensionSource("single-cmd"));
		writeFileSync(join(agentDir, "extensions", "multi", "index.js"), extensionSource("multi-cmd"));
		const { session } = await newSession();
		expect(await commandNames(session.id)).toEqual(expect.arrayContaining(["single-cmd", "multi-cmd"]));

		const listed = (await client.request("extension.list")).resources.filter(
			(r) => r.type === "extensions" && r.source === "auto",
		);
		expect(listed.map((r) => [r.name, r.scope, r.enabled, r.deletable]).sort()).toEqual([
			["multi/index.js", "user", true, true],
			["single.js", "user", true, true],
		]);

		const single = join(agentDir, "extensions", "single.js");
		await client.request("extension.setEnabled", { type: "extensions", path: single, enabled: false });
		expect(settingsOf(join(agentDir, "settings.json")).extensions).toEqual([`-${join("extensions", "single.js")}`]);
		expect(await commandNames(session.id)).not.toContain("single-cmd");

		// An override written with "/" (by hand or on another OS) names the same file, so it is replaced.
		const settings = settingsOf(join(agentDir, "settings.json"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ ...settings, extensions: ["-extensions/single.js"] }),
		);
		await client.request("extension.setEnabled", { type: "extensions", path: single, enabled: true });
		expect(settingsOf(join(agentDir, "settings.json")).extensions).toEqual([`+${join("extensions", "single.js")}`]);
		expect(await commandNames(session.id)).toContain("single-cmd");

		const deleted = await client.request("extension.delete", {
			path: join(agentDir, "extensions", "multi", "index.js"),
		});
		expect(deleted).toEqual({ deleted: true, reload: { reloaded: 1, pending: 0, failed: 0 } });
		expect(existsSync(join(agentDir, "extensions", "multi"))).toBe(false);
		const trash = readdirSync(join(t.root, "pier", "trash", "extensions"));
		expect(trash).toHaveLength(1);
		expect(trash[0]).toMatch(/-multi$/);
		expect(await commandNames(session.id)).not.toContain("multi-cmd");
	});

	it("drops settings path entries instead of deleting their files", async () => {
		const file = join(t.root, "loose.js");
		writeFileSync(file, extensionSource("loose-cmd"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", extensions: [file] }),
		);
		const resource = (await client.request("extension.list")).resources.find((r) => r.path === file);
		expect(resource).toMatchObject({ source: "local", deletable: true, enabled: true });
		await client.request("extension.delete", { path: file });
		expect(settingsOf(join(agentDir, "settings.json")).extensions).toEqual([]);
		expect(existsSync(file)).toBe(true);
	});

	it("trashes disabled skill directories with their assets and reloads sessions", async () => {
		const skillDir = join(agentDir, "skills", "nested", "standalone");
		const path = join(skillDir, "SKILL.md");
		const sibling = join(agentDir, "skills", "loose.md");
		mkdirSync(join(skillDir, "scripts"), { recursive: true });
		writeFileSync(path, skillSource("standalone"));
		writeFileSync(join(skillDir, "scripts", "helper.js"), "export const value = 42;\n");
		writeFileSync(sibling, skillSource("loose"));
		const { session } = await newSession();
		expect(await commandNames(session.id)).toContain("skill:standalone");

		await client.request("extension.setEnabled", { type: "skills", path, enabled: false });
		expect((await client.request("extension.list")).resources.find((r) => r.path === path)).toMatchObject({
			type: "skills",
			source: "auto",
			enabled: false,
			deletable: true,
		});
		// Omitting type retains the old extension-only API behavior.
		const wrongType = await client.request("extension.delete", { path }).catch((e: unknown) => e);
		expect((wrongType as PierProtocolError).code).toBe("NOT_FOUND");
		expect(existsSync(skillDir)).toBe(true);

		const deleted = await client.request("extension.delete", { type: "skills", path });
		expect(deleted).toEqual({ deleted: true, reload: { reloaded: 1, pending: 0, failed: 0 } });
		expect(existsSync(skillDir)).toBe(false);
		expect(existsSync(sibling)).toBe(true);
		expect((await client.request("extension.list")).resources.some((r) => r.path === path)).toBe(false);
		expect(await commandNames(session.id)).not.toContain("skill:standalone");
		const trashDir = join(t.root, "pier", "trash", "extensions");
		const [trashed = ""] = readdirSync(trashDir);
		expect(trashed).toMatch(/-standalone$/);
		expect(readFileSync(join(trashDir, trashed, "scripts", "helper.js"), "utf8")).toContain("value = 42");

		await client.request("extension.delete", { type: "skills", path: sibling });
		expect(existsSync(sibling)).toBe(false);
		expect(await commandNames(session.id)).not.toContain("skill:loose");
	});

	it("deletes a project .agents skill without touching global skills", async () => {
		const projectSkill = join(t.workspaceDir, ".agents", "skills", "project-skill");
		const globalSkill = join(agentDir, "skills", "global-skill");
		for (const [dir, name] of [
			[projectSkill, "project-skill"],
			[globalSkill, "global-skill"],
		] as const) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), skillSource(name));
		}
		const { session } = await newSession();
		const path = join(projectSkill, "SKILL.md");
		const listed = await client.request("extension.list", { workspaceId: workspace.id });
		expect(listed.resources.find((r) => r.path === path)).toMatchObject({
			scope: "project",
			source: "auto",
			deletable: true,
		});
		const deleted = await client.request("extension.delete", { type: "skills", path, workspaceId: workspace.id });
		expect(deleted.reload.reloaded).toBe(1);
		expect(existsSync(projectSkill)).toBe(false);
		expect(existsSync(globalSkill)).toBe(true);
		expect(await commandNames(session.id)).not.toContain("skill:project-skill");
		expect(await commandNames(session.id)).toContain("skill:global-skill");
	});

	it.each(["prompts", "themes"] as const)("trashes auto-discovered %s files", async (type) => {
		const filename = type === "prompts" ? "demo.md" : "demo.json";
		const path = join(agentDir, type, filename);
		mkdirSync(join(agentDir, type), { recursive: true });
		writeFileSync(path, type === "prompts" ? "A prompt template\n" : "{}\n");
		expect((await client.request("extension.list")).resources.find((r) => r.path === path)).toMatchObject({
			type,
			source: "auto",
			deletable: true,
		});
		await client.request("extension.delete", { type, path });
		expect(existsSync(path)).toBe(false);
		expect((await client.request("extension.list")).resources.some((r) => r.path === path)).toBe(false);
		const trashDir = join(t.root, "pier", "trash", "extensions");
		const [trashed] = readdirSync(trashDir);
		expect(trashed).toMatch(new RegExp(`-${filename.replace(".", "\\.")}$`));
	});

	it.each(["skills", "prompts", "themes"] as const)("unlinks explicit %s entries and preserves files", async (type) => {
		const dir = join(t.root, "external-skill");
		mkdirSync(dir);
		const path =
			type === "skills" ? join(dir, "SKILL.md") : join(t.root, type === "prompts" ? "loose.md" : "loose.json");
		writeFileSync(path, type === "skills" ? skillSource("external-skill") : "{}\n");
		const entry = type === "skills" ? dir : path;
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", [type]: [entry] }),
		);
		expect((await client.request("extension.list")).resources.find((r) => r.path === path)).toMatchObject({
			type,
			source: "local",
			deletable: true,
		});
		await client.request("extension.setEnabled", { type, path, enabled: false });
		await client.request("extension.delete", { type, path });
		expect(settingsOf(join(agentDir, "settings.json"))[type]).toEqual([]);
		expect(existsSync(path)).toBe(true);
		expect((await client.request("extension.list")).resources.some((r) => r.path === path)).toBe(false);
	});

	it("preserves package resources and resources discovered through a settings directory", async () => {
		await client.request("extension.install", { source: pkgDir });
		const path = join(pkgDir, "skills", "demo-skill", "SKILL.md");
		const error = await client.request("extension.delete", { type: "skills", path }).catch((e: unknown) => e);
		expect((error as PierProtocolError).code).toBe("BAD_REQUEST");
		expect(existsSync(path)).toBe(true);

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", skills: [join(pkgDir, "skills")] }),
		);
		expect((await client.request("extension.list")).resources.find((r) => r.path === path)).toMatchObject({
			origin: "top-level",
			source: "local",
			deletable: false,
		});
		const directoryError = await client.request("extension.delete", { type: "skills", path }).catch((e: unknown) => e);
		expect((directoryError as PierProtocolError).code).toBe("BAD_REQUEST");
		expect(existsSync(path)).toBe(true);
	});

	it("trashes a skill symlink while preserving its target and refuses to traverse ancestor symlinks", async () => {
		const external = join(t.root, "external-skill");
		const linked = join(agentDir, "skills", "linked-skill");
		mkdirSync(external);
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		writeFileSync(join(external, "SKILL.md"), skillSource("linked-skill"));
		symlinkSync(external, linked, "junction");
		const path = join(linked, "SKILL.md");
		expect((await client.request("extension.list")).resources.find((r) => r.path === path)?.deletable).toBe(true);
		await client.request("extension.delete", { type: "skills", path });
		expect(existsSync(linked)).toBe(false);
		expect(readFileSync(join(external, "SKILL.md"), "utf8")).toContain("linked-skill");
		const trashDir = join(t.root, "pier", "trash", "extensions");
		const [trashed = ""] = readdirSync(trashDir);
		expect(lstatSync(join(trashDir, trashed)).isSymbolicLink()).toBe(true);

		const collection = join(t.root, "external-collection");
		mkdirSync(join(collection, "nested"), { recursive: true });
		writeFileSync(join(collection, "nested", "SKILL.md"), skillSource("nested"));
		symlinkSync(collection, linked, "junction");
		const nested = join(linked, "nested", "SKILL.md");
		expect((await client.request("extension.list")).resources.find((r) => r.path === nested)?.deletable).toBe(false);
		const error = await client.request("extension.delete", { type: "skills", path: nested }).catch((e: unknown) => e);
		expect((error as PierProtocolError).code).toBe("BAD_REQUEST");
		expect(existsSync(join(collection, "nested", "SKILL.md"))).toBe(true);
	});

	it("installs into a workspace's project settings", async () => {
		const file = join(t.root, "project-ext.js");
		writeFileSync(file, extensionSource("project-cmd"));
		const noWorkspace = await client.request("extension.install", { source: file, scope: "project" }).catch((e) => e);
		expect((noWorkspace as PierProtocolError).code).toBe("BAD_REQUEST");

		const { session } = await newSession();
		const installed = await client.request("extension.install", {
			source: file,
			scope: "project",
			workspaceId: workspace.id,
		});
		expect(installed.package?.scope).toBe("project");
		expect(installed.reload.reloaded).toBe(1);
		expect(await commandNames(session.id)).toContain("project-cmd");
		expect(existsSync(join(t.workspaceDir, ".pi", "settings.json"))).toBe(true);

		expect((await client.request("extension.list")).packages).toEqual([]);
		const listed = await client.request("extension.list", { workspaceId: workspace.id });
		expect(listed.workspaceId).toBe(workspace.id);
		expect(listed.packages.map((p) => p.scope)).toEqual(["project"]);
		expect(listed.resources.find((r) => r.path === file)).toMatchObject({ scope: "project", origin: "package" });

		const source = listed.packages[0]?.source ?? "";
		const removed = await client.request("extension.remove", { source, scope: "project", workspaceId: workspace.id });
		expect(removed.removed).toBe(true);
		expect(await commandNames(session.id)).not.toContain("project-cmd");
	});

	it("rejects relative or missing paths", async () => {
		for (const source of ["./relative", join(t.root, "missing")]) {
			const error = await client.request("extension.install", { source }).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(PierProtocolError);
			expect((error as PierProtocolError).code).toBe("BAD_REQUEST");
		}
	});

	it("refuses to write over settings it cannot read", async () => {
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		const error = await client.request("extension.install", { source: pkgDir }).catch((e: unknown) => e);
		expect((error as PierProtocolError).code).toBe("CONFLICT");
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe("{ not json");
	});

	it("leaves busy sessions for a later reload", async () => {
		const { session, rec } = await newSession();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("done");
			},
		]);
		const from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "work" });
		const installed = await client.request("extension.install", { source: pkgDir });
		expect(installed.reload).toEqual({ reloaded: 0, pending: 1, failed: 0 });
		release();
		await rec.waitForType("agent_settled", from);
		expect(await commandNames(session.id)).not.toContain("demo-cmd");
		await client.request("session.reload", { sessionId: session.id });
		expect(await commandNames(session.id)).toContain("demo-cmd");
	});
});
