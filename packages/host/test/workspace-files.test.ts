import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listWorkspaceDirectory,
	MAX_DIRECTORY_ENTRIES,
	MAX_IMAGE_PREVIEW_BYTES,
	MAX_TEXT_PREVIEW_BYTES,
	normalizeRelativePath,
	readWorkspaceFile,
} from "../src/workspace-files.ts";
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

describe("readWorkspaceFile", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-read-"));
		outside = mkdtempSync(join(tmpdir(), "pier-outside-"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "index.ts"), 'export const x = "你好";\n');
		writeFileSync(join(outside, "secret.txt"), "secret");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("returns UTF-8 text with metadata", async () => {
		const result = await readWorkspaceFile(root, "src\\index.ts");
		expect(result).toMatchObject({ path: "src/index.ts", kind: "text", text: 'export const x = "你好";\n' });
		expect(result.size).toBe(Buffer.byteLength('export const x = "你好";\n'));
		expect(result.truncated).toBeUndefined();
		expect(typeof result.modifiedAt).toBe("string");
	});

	it("truncates long text without splitting a character", async () => {
		// "é" is two bytes, so the limit falls in the middle of one.
		writeFileSync(join(root, "long.txt"), `a${"é".repeat(MAX_TEXT_PREVIEW_BYTES)}`);
		const result = await readWorkspaceFile(root, "long.txt");
		expect(result.kind).toBe("text");
		expect(result.truncated).toBe(true);
		expect(result.text).toBe(`a${"é".repeat(MAX_TEXT_PREVIEW_BYTES / 2 - 1)}`);
	});

	it("reports binary files without content", async () => {
		writeFileSync(join(root, "blob.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
		writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
		expect(await readWorkspaceFile(root, "blob.bin")).toMatchObject({ kind: "binary", size: 6 });
		expect((await readWorkspaceFile(root, "blob.bin")).text).toBeUndefined();
		expect((await readWorkspaceFile(root, "latin1.txt")).kind).toBe("binary");
	});

	it("returns images as base64 and skips oversized ones", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		writeFileSync(join(root, "logo.PNG"), png);
		expect(await readWorkspaceFile(root, "logo.PNG")).toMatchObject({
			kind: "image",
			mimeType: "image/png",
			data: png.toString("base64"),
		});
		writeFileSync(join(root, "huge.jpg"), Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1));
		const huge = await readWorkspaceFile(root, "huge.jpg");
		expect(huge).toMatchObject({ kind: "image", mimeType: "image/jpeg", tooLarge: true });
		expect(huge.data).toBeUndefined();
	});

	it("rejects directories, missing files and paths outside the workspace", async () => {
		await expect(readWorkspaceFile(root, "src")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(readWorkspaceFile(root, "")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(readWorkspaceFile(root, "../x")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(readWorkspaceFile(root, "missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
		symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
		await expect(readWorkspaceFile(root, "leak.txt")).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("follows symlinks that stay inside the workspace", async () => {
		symlinkSync(join(root, "src", "index.ts"), join(root, "alias.ts"));
		expect(await readWorkspaceFile(root, "alias.ts")).toMatchObject({ path: "alias.ts", kind: "text" });
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

	it("reads a workspace file with workspace.readFile", async () => {
		const file = await client.request("workspace.readFile", { workspaceId: workspace.id, path: "docs/guide.md" });
		expect(file).toMatchObject({ path: "docs/guide.md", kind: "text", text: "# Guide\n", size: 8 });
		await expectCode(client.request("workspace.readFile", { workspaceId: "nope", path: "docs/guide.md" }), "NOT_FOUND");
		await expectCode(client.request("workspace.readFile", { workspaceId: workspace.id, path: "docs" }), "BAD_REQUEST");
		await expectCode(
			client.request("workspace.readFile", { workspaceId: workspace.id, path: "/etc/passwd" }),
			"BAD_REQUEST",
		);
	});
});
