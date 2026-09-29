import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkspaceDirectory, MAX_DIRECTORY_ENTRIES, normalizeRelativePath } from "../src/workspace-files.ts";
import { startTestHost, type TestHost } from "./helpers.ts";

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(PierProtocolError);
	expect((error as PierProtocolError).code).toBe(code);
}

describe("normalizeRelativePath", () => {
	it("normalizes separators and dots", () => {
		expect(normalizeRelativePath(undefined)).toBe("");
		expect(normalizeRelativePath("")).toBe("");
		expect(normalizeRelativePath(".")).toBe("");
		expect(normalizeRelativePath("src/./lib/")).toBe("src/lib");
		expect(normalizeRelativePath("src\\lib")).toBe("src/lib");
	});

	it("rejects absolute paths and parent segments", () => {
		for (const bad of ["/etc", "\\etc", "C:\\Windows", "..", "src/../..", "a/../b"]) {
			expect(() => normalizeRelativePath(bad), bad).toThrow(PierProtocolError);
		}
	});
});

describe("listWorkspaceDirectory", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-files-"));
		outside = mkdtempSync(join(tmpdir(), "pier-outside-"));
		mkdirSync(join(root, "src", "lib"), { recursive: true });
		mkdirSync(join(root, ".git", "objects"), { recursive: true });
		writeFileSync(join(root, "README.md"), "hello");
		writeFileSync(join(root, "b.txt"), "");
		writeFileSync(join(root, "file10.ts"), "");
		writeFileSync(join(root, "file2.ts"), "");
		writeFileSync(join(root, ".env.example"), "");
		writeFileSync(join(root, "src", "index.ts"), "export {};\n");
		writeFileSync(join(outside, "secret.txt"), "secret");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("lists directories first, sorted naturally, without .git", async () => {
		const result = await listWorkspaceDirectory(root);
		expect(result.path).toBe("");
		expect(result.truncated).toBeUndefined();
		expect(result.entries.map((e) => e.name)).toEqual([
			"src",
			".env.example",
			"b.txt",
			"file2.ts",
			"file10.ts",
			"README.md",
		]);
		const readme = result.entries.find((e) => e.name === "README.md");
		expect(readme).toMatchObject({ path: "README.md", kind: "file", size: 5 });
		expect(readme?.modifiedAt).toMatch(/^\d{4}-/);
		expect(result.entries[0]).toMatchObject({ path: "src", kind: "directory" });
	});

	it("lists nested directories with workspace-relative paths", async () => {
		const result = await listWorkspaceDirectory(root, "src/");
		expect(result.path).toBe("src");
		expect(result.entries).toEqual([
			expect.objectContaining({ name: "lib", path: "src/lib", kind: "directory" }),
			expect.objectContaining({ name: "index.ts", path: "src/index.ts", kind: "file", size: 11 }),
		]);
	});

	it("rejects paths that escape the workspace", async () => {
		await expectCode(listWorkspaceDirectory(root, ".."), "BAD_REQUEST");
		await expectCode(listWorkspaceDirectory(root, outside), "BAD_REQUEST");
		await expectCode(listWorkspaceDirectory(root, "missing"), "NOT_FOUND");
		await expectCode(listWorkspaceDirectory(root, "README.md"), "BAD_REQUEST");
	});

	it.skipIf(process.platform === "win32")("does not follow symlinks out of the workspace", async () => {
		symlinkSync(outside, join(root, "escape"));
		symlinkSync(join(root, "src"), join(root, "src-link"));
		symlinkSync(join(root, "gone"), join(root, "broken"));
		const { entries } = await listWorkspaceDirectory(root);
		expect(entries.find((e) => e.name === "escape")).toMatchObject({ kind: "other", symlink: true });
		expect(entries.find((e) => e.name === "src-link")).toMatchObject({ kind: "directory", symlink: true });
		expect(entries.find((e) => e.name === "broken")).toMatchObject({ kind: "other", symlink: true });
		await expectCode(listWorkspaceDirectory(root, "escape"), "FORBIDDEN");
		expect((await listWorkspaceDirectory(root, "src-link")).entries.map((e) => e.path)).toEqual([
			"src-link/lib",
			"src-link/index.ts",
		]);
	});

	it("truncates very large directories", async () => {
		const big = join(root, "big");
		mkdirSync(big);
		for (let i = 0; i < MAX_DIRECTORY_ENTRIES + 5; i++) writeFileSync(join(big, `f${i}`), "");
		const result = await listWorkspaceDirectory(root, "big");
		expect(result.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
		expect(result).toMatchObject({ truncated: true, total: MAX_DIRECTORY_ENTRIES + 5 });
	});
});

describe("workspace.files", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost();
		mkdirSync(join(t.workspaceDir, "docs"));
		writeFileSync(join(t.workspaceDir, "docs", "guide.md"), "# Guide\n");
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	it("lists the workspace root and subdirectories", async () => {
		const root = await client.request("workspace.files", { workspaceId: workspace.id });
		expect(root.entries.map((e) => [e.path, e.kind])).toEqual([["docs", "directory"]]);
		const docs = await client.request("workspace.files", { workspaceId: workspace.id, path: "docs" });
		expect(docs.entries.map((e) => [e.path, e.kind])).toEqual([["docs/guide.md", "file"]]);
	});

	it("rejects unknown workspaces and escaping paths", async () => {
		await expectCode(client.request("workspace.files", { workspaceId: "nope" }), "NOT_FOUND");
		await expectCode(client.request("workspace.files", { workspaceId: workspace.id, path: "../" }), "BAD_REQUEST");
	});
});
