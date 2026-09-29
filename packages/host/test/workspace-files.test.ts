import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deleteWorkspacePath,
	listWorkspaceDirectory,
	MAX_DIRECTORY_ENTRIES,
	MAX_IMAGE_PREVIEW_BYTES,
	MAX_TEXT_PREVIEW_BYTES,
	MAX_TEXT_WRITE_BYTES,
	normalizeRelativePath,
	readWorkspaceFile,
	writeWorkspaceFile,
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

describe("writeWorkspaceFile", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-write-"));
		outside = mkdtempSync(join(tmpdir(), "pier-outside-"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "index.ts"), "old\n");
		writeFileSync(join(outside, "secret.txt"), "secret");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("overwrites the file in place and returns fresh metadata", async () => {
		const file = join(root, "src", "index.ts");
		chmodSync(file, 0o754);
		linkSync(file, join(root, "hard.ts"));
		const result = await writeWorkspaceFile(root, "src\\index.ts", "新的内容\n");
		expect(result).toEqual({
			path: "src/index.ts",
			size: Buffer.byteLength("新的内容\n"),
			modifiedAt: statSync(file).mtime.toISOString(),
		});
		expect(readFileSync(file, "utf8")).toBe("新的内容\n");
		// Windows has no POSIX permission bits (only read-only), so only check them elsewhere.
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o754);
		expect(readFileSync(join(root, "hard.ts"), "utf8")).toBe("新的内容\n");
	});

	it("refuses to write when the file changed since it was read", async () => {
		const read = await readWorkspaceFile(root, "src/index.ts");
		expect((await writeWorkspaceFile(root, "src/index.ts", "mine\n", read.modifiedAt)).path).toBe("src/index.ts");
		const stale = new Date(Date.parse(read.modifiedAt) - 60_000).toISOString();
		const error = await writeWorkspaceFile(root, "src/index.ts", "theirs\n", stale).catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "CONFLICT",
			data: { modifiedAt: statSync(join(root, "src", "index.ts")).mtime.toISOString() },
		});
		expect(readFileSync(join(root, "src", "index.ts"), "utf8")).toBe("mine\n");
	});

	it("keeps a UTF-8 byte order mark", async () => {
		writeFileSync(join(root, "bom.txt"), "\uFEFFhello");
		expect((await readWorkspaceFile(root, "bom.txt")).text).toBe("hello");
		await writeWorkspaceFile(root, "bom.txt", "world");
		expect(readFileSync(join(root, "bom.txt"))).toEqual(Buffer.from("\uFEFFworld"));
	});

	it("never creates files or writes outside the workspace", async () => {
		await expect(writeWorkspaceFile(root, "new.txt", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(existsSync(join(root, "new.txt"))).toBe(false);
		await expect(writeWorkspaceFile(root, "src", "x")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(writeWorkspaceFile(root, "", "x")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(writeWorkspaceFile(root, "../x", "x")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
		await expect(writeWorkspaceFile(root, "leak.txt", "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
		const big = "a".repeat(MAX_TEXT_WRITE_BYTES + 1);
		await expect(writeWorkspaceFile(root, "src/index.ts", big)).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("reports read-only files as FORBIDDEN", async () => {
		if (process.getuid?.() === 0) return;
		chmodSync(join(root, "src", "index.ts"), 0o444);
		await expect(writeWorkspaceFile(root, "src/index.ts", "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("deleteWorkspacePath", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-delete-"));
		outside = mkdtempSync(join(tmpdir(), "pier-outside-"));
		mkdirSync(join(root, "src", "lib"), { recursive: true });
		writeFileSync(join(root, "src", "index.ts"), "x");
		writeFileSync(join(root, "src", "lib", "a.ts"), "a");
		writeFileSync(join(root, "keep.txt"), "keep");
		writeFileSync(join(outside, "secret.txt"), "secret");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("deletes files and whole directories", async () => {
		expect(await deleteWorkspacePath(root, "src\\index.ts")).toEqual({ path: "src/index.ts", kind: "file" });
		expect(existsSync(join(root, "src", "index.ts"))).toBe(false);
		expect(await deleteWorkspacePath(root, "src/")).toEqual({ path: "src", kind: "directory" });
		expect(existsSync(join(root, "src"))).toBe(false);
		expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("keep");
	});

	it("removes symlinks without touching their targets", async () => {
		symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
		symlinkSync(outside, join(root, "out"), "dir");
		symlinkSync(join(root, "src"), join(root, "alias"), "dir");
		expect(await deleteWorkspacePath(root, "leak.txt")).toEqual({ path: "leak.txt", kind: "other" });
		expect(await deleteWorkspacePath(root, "out")).toEqual({ path: "out", kind: "other" });
		expect(await deleteWorkspacePath(root, "alias")).toEqual({ path: "alias", kind: "other" });
		expect(existsSync(join(root, "leak.txt"))).toBe(false);
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
		expect(existsSync(join(root, "src", "lib", "a.ts"))).toBe(true);
		// Deleting through a link to the inside works; through a link to the outside is refused.
		symlinkSync(join(root, "src"), join(root, "alias"), "dir");
		expect(await deleteWorkspacePath(root, "alias/index.ts")).toEqual({ path: "alias/index.ts", kind: "file" });
		expect(existsSync(join(root, "src", "index.ts"))).toBe(false);
		symlinkSync(outside, join(root, "out"), "dir");
		await expect(deleteWorkspacePath(root, "out/secret.txt")).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(existsSync(join(outside, "secret.txt"))).toBe(true);
	});

	it("rejects the root, escaping paths and missing entries", async () => {
		for (const bad of ["", ".", "./", "../x", "/etc/passwd"]) {
			await expect(deleteWorkspacePath(root, bad), bad).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		await expect(deleteWorkspacePath(root, "missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(deleteWorkspacePath(root, "nope/x.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(deleteWorkspacePath(root, "keep.txt/x")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(existsSync(join(root, "keep.txt"))).toBe(true);
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

	it("writes a workspace file with workspace.writeFile", async () => {
		const read = await client.request("workspace.readFile", { workspaceId: workspace.id, path: "docs/guide.md" });
		const written = await client.request("workspace.writeFile", {
			workspaceId: workspace.id,
			path: "docs/guide.md",
			text: "# Changed\n",
			expectedModifiedAt: read.modifiedAt,
		});
		expect(written).toMatchObject({ path: "docs/guide.md", size: 10 });
		expect(readFileSync(join(t.workspaceDir, "docs", "guide.md"), "utf8")).toBe("# Changed\n");
		await expectCode(
			client.request("workspace.writeFile", { workspaceId: "nope", path: "docs/guide.md", text: "" }),
			"NOT_FOUND",
		);
	});

	it("deletes a workspace path with workspace.deletePath", async () => {
		expect(await client.request("workspace.deletePath", { workspaceId: workspace.id, path: "docs" })).toEqual({
			path: "docs",
			kind: "directory",
		});
		expect(existsSync(join(t.workspaceDir, "docs"))).toBe(false);
		expect(existsSync(t.workspaceDir)).toBe(true);
		await expectCode(client.request("workspace.deletePath", { workspaceId: workspace.id, path: "docs" }), "NOT_FOUND");
		await expectCode(client.request("workspace.deletePath", { workspaceId: workspace.id, path: "." }), "BAD_REQUEST");
		await expectCode(client.request("workspace.deletePath", { workspaceId: "nope", path: "docs" }), "NOT_FOUND");
	});
});
