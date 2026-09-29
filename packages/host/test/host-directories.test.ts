import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listHostDirectories } from "../src/host-directories.ts";

describe("listHostDirectories", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-dirs-"));
		mkdirSync(join(root, "b-project"));
		mkdirSync(join(root, "A-project"));
		mkdirSync(join(root, "project10"));
		mkdirSync(join(root, "project9"));
		writeFileSync(join(root, "file.txt"), "not a directory");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("lists only subdirectories, sorted naturally, with absolute paths", async () => {
		const listing = await listHostDirectories(root);
		expect(listing.path).toBe(root);
		expect(listing.parent).toBe(dirname(root));
		expect(listing.home).toBe(homedir());
		expect(listing.entries.map((e) => e.name)).toEqual(["A-project", "b-project", "project9", "project10"]);
		expect(listing.entries[0]?.path).toBe(join(root, "A-project"));
		expect(listing.truncated).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("includes symlinks to directories but not broken links", async () => {
		symlinkSync(join(root, "A-project"), join(root, "link"));
		symlinkSync(join(root, "missing"), join(root, "broken"));
		const listing = await listHostDirectories(root);
		expect(listing.entries.find((e) => e.name === "link")).toMatchObject({ symlink: true });
		expect(listing.entries.some((e) => e.name === "broken")).toBe(false);
	});

	it("defaults to the home directory and rejects relative or missing paths", async () => {
		expect((await listHostDirectories()).path).toBe(homedir());
		await expect(listHostDirectories("relative/path")).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(listHostDirectories(join(root, "missing"))).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(listHostDirectories(join(root, "file.txt"))).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("omits the parent at a filesystem root", async () => {
		const top = dirname(root).split(/[\\/]/)[0] || "/";
		const listing = await listHostDirectories(process.platform === "win32" ? `${top}\\` : "/");
		expect(listing.parent).toBeUndefined();
	});
});
