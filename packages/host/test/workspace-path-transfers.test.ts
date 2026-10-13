import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteWorkspacePath } from "../src/workspace-files.ts";
import { transferWorkspacePath } from "../src/workspace-path-transfers.ts";
import { startTestHost } from "./helpers.ts";

const faults = vi.hoisted(() => ({ crossDevice: "", changeAfterCopy: "", crossDeviceHits: 0, copies: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		rename: async (from: string, to: string) => {
			if (from === faults.crossDevice) {
				faults.crossDeviceHits++;
				throw Object.assign(new Error("cross device"), { code: "EXDEV" });
			}
			return fs.rename(from, to);
		},
		cp: async (from: string, to: string, options: Parameters<typeof fs.cp>[2]) => {
			await fs.cp(from, to, options);
			faults.copies++;
			if (faults.changeAfterCopy) await fs.writeFile(faults.changeAfterCopy, "new content");
		},
	};
});

describe("workspace path transfers", () => {
	let root: string;
	let source: string;
	let destination: string;
	beforeEach(() => {
		// Match the canonical paths used by workspaceRealRoot, including macOS /var
		// aliases and Windows temporary-directory casing, so EXDEV is actually injected.
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "pier-path-transfer-")));
		source = join(root, "source");
		destination = join(root, "destination");
		mkdirSync(join(source, "folder", "empty"), { recursive: true });
		mkdirSync(join(source, "folder", ".git"), { recursive: true });
		mkdirSync(destination);
		writeFileSync(join(source, "folder", ".git", "config"), "git metadata");
		writeFileSync(join(source, "folder", "file.bin"), Buffer.from([0, 1, 255]));
		faults.crossDevice = "";
		faults.changeAfterCopy = "";
		faults.crossDeviceHits = 0;
		faults.copies = 0;
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("copies hidden contents and empty directories and keeps its source", async () => {
		await transferWorkspacePath(source, "folder", destination, "folder", "copy");
		expect(readFileSync(join(destination, "folder", "file.bin"))).toEqual(Buffer.from([0, 1, 255]));
		expect(readdirSync(join(destination, "folder", "empty"))).toEqual([]);
		expect(readFileSync(join(destination, "folder", ".git", "config"), "utf8")).toBe("git metadata");
		expect(existsSync(join(source, "folder"))).toBe(true);
		expect(readdirSync(destination)).toEqual(["folder"]);
	});

	it("moves whole directories and rejects same-path and descendant targets even across overlapping workspaces", async () => {
		await expect(transferWorkspacePath(source, "folder", source, "folder", "move")).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(
			transferWorkspacePath(source, "folder", join(source, "folder"), "nested", "copy"),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await transferWorkspacePath(source, "folder", destination, "moved", "move");
		expect(existsSync(join(source, "folder"))).toBe(false);
		expect(readFileSync(join(destination, "moved", ".git", "config"), "utf8")).toBe("git metadata");
	});

	it("replaces only explicitly confirmed regular files and never replaces folders", async () => {
		writeFileSync(join(destination, "existing"), "old");
		await expect(
			transferWorkspacePath(source, "folder/file.bin", destination, "existing", "copy"),
		).rejects.toMatchObject({ code: "CONFLICT", data: { kind: "file" } });
		expect(readFileSync(join(destination, "existing"), "utf8")).toBe("old");
		await transferWorkspacePath(source, "folder/file.bin", destination, "existing", "copy", true);
		expect(readFileSync(join(destination, "existing"))).toEqual(Buffer.from([0, 1, 255]));
		mkdirSync(join(destination, "folder"));
		writeFileSync(join(destination, "folder", "keep"), "keep");
		await expect(transferWorkspacePath(source, "folder", destination, "folder", "move", true)).rejects.toMatchObject({
			code: "CONFLICT",
			data: { kind: "directory" },
		});
		expect(readFileSync(join(destination, "folder", "keep"), "utf8")).toBe("keep");
		expect(existsSync(join(source, "folder"))).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"preserves symlinks without copying their external targets, and rejects escaped parent paths",
		async () => {
			writeFileSync(join(root, "outside"), "outside");
			symlinkSync(join(root, "outside"), join(source, "folder", "link"));
			await transferWorkspacePath(source, "folder", destination, "copy", "copy");
			expect(readlinkSync(join(destination, "copy", "link"))).toBe(join(root, "outside"));
			symlinkSync(root, join(destination, "escape"));
			await expect(transferWorkspacePath(source, "folder", destination, "escape/leak", "copy")).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(transferWorkspacePath(source, "../outside", destination, "leak", "copy")).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		},
	);

	it("finishes cross-filesystem moves only after copying all contents", async () => {
		faults.crossDevice = join(source, "folder");
		await transferWorkspacePath(source, "folder", destination, "folder", "move");
		expect(faults.crossDeviceHits).toBe(1);
		expect(faults.copies).toBe(1);
		expect(existsSync(join(source, "folder"))).toBe(false);
		expect(existsSync(join(destination, "folder", "empty"))).toBe(true);
	});

	it("retains a source modified during a cross-filesystem move and removes staging files", async () => {
		faults.crossDevice = join(source, "folder");
		faults.changeAfterCopy = join(source, "folder", "new-file");
		await expect(transferWorkspacePath(source, "folder", destination, "folder", "move")).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(faults.crossDeviceHits).toBe(1);
		expect(faults.copies).toBe(1);
		expect(readFileSync(faults.changeAfterCopy, "utf8")).toBe("new content");
		expect(readdirSync(destination)).toEqual([]);
	});

	it("keeps changed files and symlinks when a guarded cross-Host delete is requested", async () => {
		await expect(deleteWorkspacePath(source, "folder/file.bin", "old", 3)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(existsSync(join(source, "folder", "file.bin"))).toBe(true);
		await expect(deleteWorkspacePath(source, "folder", undefined, 0)).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("routes native transfer requests through the Host and checks both workspace registrations", async () => {
		const host = await startTestHost();
		try {
			const client = await host.connect();
			const { workspace: a } = await client.request("workspace.add", { path: source });
			const { workspace: b } = await client.request("workspace.add", { path: destination });
			const params = {
				workspaceId: a.id,
				path: "folder",
				destinationWorkspaceId: b.id,
				destinationPath: "folder",
				mode: "copy" as const,
			};
			expect(await client.request("workspace.transferPath", params)).toEqual({
				sourcePath: "folder",
				path: "folder",
				kind: "directory",
			});
			await expect(
				client.request("workspace.transferPath", { ...params, destinationWorkspaceId: "missing" }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		} finally {
			await host.close();
		}
	});
});
