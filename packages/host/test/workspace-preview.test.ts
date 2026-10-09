import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	authorizeWorkspaceFilePreview,
	MAX_IMAGE_PREVIEW_BYTES,
	MAX_TEXT_PREVIEW_BYTES,
	previewWorkspaceFile,
	readWorkspaceFile,
} from "../src/workspace-files.ts";
import { startTestHost } from "./helpers.ts";

describe("Markdown file previews on the host", () => {
	let root: string;
	let workspace: string;
	let outside: string;
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
		"base64",
	);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-preview-"));
		workspace = join(root, "workspace");
		outside = mkdtempSync(join(homedir(), ".pier-preview-test-"));
		mkdirSync(join(workspace, "docs"), { recursive: true });
		writeFileSync(join(workspace, "docs", "guide.md"), "# Guide\n");
		writeFileSync(join(workspace, "screen.png"), png);
		writeFileSync(join(root, "screen.png"), png);
		writeFileSync(join(outside, "private.txt"), "outside");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("previews relative and absolute workspace references, including parent links inside it", async () => {
		for (const path of ["docs/guide.md", "docs/../docs/guide.md", join(workspace, "docs", "guide.md")]) {
			expect(await previewWorkspaceFile(workspace, path)).toMatchObject({ path, kind: "text", text: "# Guide\n" });
		}
	});

	it("reads temporary screenshots as image data while keeping workspace.readFile confined", async () => {
		const path = join(root, "screen.png");
		expect(await previewWorkspaceFile(workspace, path)).toMatchObject({
			path,
			kind: "image",
			mimeType: "image/png",
			data: png.toString("base64"),
		});
		await expect(readWorkspaceFile(workspace, path)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(previewWorkspaceFile(workspace, "../screen.png")).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("reports missing files, directories, malformed paths and oversized images", async () => {
		await expect(previewWorkspaceFile(workspace, "missing.png")).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(previewWorkspaceFile(workspace, "docs")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		for (const path of ["file:///tmp/screen.png", "https://example.com/screen.png", "x\0.png", "//server/share.png"]) {
			await expect(previewWorkspaceFile(workspace, path)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		writeFileSync(join(root, "large.png"), Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1));
		expect(await previewWorkspaceFile(workspace, join(root, "large.png"))).toMatchObject({
			kind: "image",
			tooLarge: true,
		});
	});

	it("rejects absolute files outside the workspace and temporary directories", async () => {
		const path = join(outside, "private.txt");
		await expect(previewWorkspaceFile(workspace, path)).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { reason: "OUTSIDE_ALLOWED_ROOTS", resolvedPath: realpathSync(path) },
		});
	});

	it("reads only the confirmed file once, preserving boundaries for subsequent previews and workspace reads", async () => {
		const path = join(outside, "private.txt");
		const expectedRealPath = realpathSync(path);
		expect(await authorizeWorkspaceFilePreview(workspace, path, expectedRealPath)).toMatchObject({
			path,
			kind: "text",
			text: "outside",
		});
		await expect(previewWorkspaceFile(workspace, path)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(readWorkspaceFile(workspace, path)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		writeFileSync(join(outside, "other.txt"), "another file");
		await expect(
			authorizeWorkspaceFilePreview(workspace, join(outside, "other.txt"), expectedRealPath),
		).rejects.toMatchObject({ code: "CONFLICT", data: { reason: "PREVIEW_TARGET_CHANGED" } });
	});

	it.skipIf(process.platform === "win32")("requires fresh confirmation after a symlink changes target", async () => {
		const link = join(workspace, "linked.txt");
		const first = join(outside, "private.txt");
		const second = join(outside, "other.txt");
		writeFileSync(second, "different file");
		symlinkSync(first, link);
		await expect(previewWorkspaceFile(workspace, "linked.txt")).rejects.toMatchObject({
			data: { reason: "OUTSIDE_ALLOWED_ROOTS", resolvedPath: realpathSync(first) },
		});
		rmSync(link);
		symlinkSync(second, link);
		await expect(authorizeWorkspaceFilePreview(workspace, "linked.txt", realpathSync(first))).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(await authorizeWorkspaceFilePreview(workspace, "linked.txt", realpathSync(second))).toMatchObject({
			text: "different file",
		});
	});

	it("retains size limits, file-type checks and path validation for authorized reads", async () => {
		const text = join(outside, "large.txt");
		const image = join(outside, "large.png");
		writeFileSync(text, "x".repeat(MAX_TEXT_PREVIEW_BYTES + 1));
		writeFileSync(image, Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1));
		expect(await authorizeWorkspaceFilePreview(workspace, text, realpathSync(text))).toMatchObject({
			kind: "text",
			truncated: true,
		});
		expect(await authorizeWorkspaceFilePreview(workspace, image, realpathSync(image))).toMatchObject({
			kind: "image",
			tooLarge: true,
		});
		await expect(authorizeWorkspaceFilePreview(workspace, outside, realpathSync(outside))).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		for (const path of ["file:///tmp/screen.png", "https://example.com/screen.png", "x\0.png", "//server/share.png"]) {
			await expect(authorizeWorkspaceFilePreview(workspace, path, path)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps OS permission failures distinct and cannot override them with preview authorization",
		async () => {
			const path = join(outside, "private.txt");
			const expectedRealPath = realpathSync(path);
			chmodSync(path, 0);
			try {
				await expect(authorizeWorkspaceFilePreview(workspace, path, expectedRealPath)).rejects.toMatchObject({
					code: "FORBIDDEN",
					data: { reason: "FILESYSTEM_PERMISSION_DENIED" },
				});
			} finally {
				chmodSync(path, 0o600);
			}
		},
	);

	it.skipIf(process.platform === "win32")("checks symlink targets before reading", async () => {
		symlinkSync(join(outside, "private.txt"), join(root, "escape.txt"));
		symlinkSync(join(outside, "private.txt"), join(workspace, "escape.txt"));
		symlinkSync(join(workspace, "screen.png"), join(workspace, "alias.png"));
		await expect(previewWorkspaceFile(workspace, join(root, "escape.txt"))).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(previewWorkspaceFile(workspace, "escape.txt")).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await previewWorkspaceFile(workspace, "alias.png")).toMatchObject({
			kind: "image",
			data: png.toString("base64"),
		});
	});

	it("serves previews through the authenticated Host protocol", async () => {
		const host = await startTestHost();
		try {
			const client = await host.connect();
			const { workspace: info } = await client.request("workspace.add", { path: workspace });
			expect(
				await client.request("workspace.previewFile", { workspaceId: info.id, path: join(root, "screen.png") }),
			).toMatchObject({
				kind: "image",
				data: png.toString("base64"),
			});
			const path = join(outside, "private.txt");
			const params = { workspaceId: info.id, path, expectedRealPath: realpathSync(path) };
			expect(await client.request("workspace.authorizeFilePreview", params)).toMatchObject({ text: "outside" });
			await expect(client.request("workspace.previewFile", { workspaceId: info.id, path })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(
				client.request("workspace.authorizeFilePreview", { ...params, expectedRealPath: join(outside, "other.txt") }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(
				client.request("workspace.previewFile", { workspaceId: "missing", path: "screen.png" }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		} finally {
			await host.close();
		}
	});
});
