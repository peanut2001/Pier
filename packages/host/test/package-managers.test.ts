import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPackageManagers, findPackageManagers, wellKnownDirs } from "../src/package-managers.ts";

const posix = process.platform !== "win32";

function script(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

describe.runIf(posix)("package manager detection", () => {
	let root: string;
	let first: string;
	let second: string;
	let extra: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "pier-pm-")));
		first = join(root, "first");
		second = join(root, "second");
		extra = join(root, "extra");
		for (const dir of [first, second, extra]) mkdirSync(dir);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("lists PATH entries in order, then well-known directories, one per real file", () => {
		script(join(first, "npm"), "echo 10.9.2");
		script(join(second, "npm"), "echo 9.0.0");
		script(join(second, "pnpm"), "echo 10.1.0");
		// The same pnpm through a symlinked directory (e.g. /bin → /usr/bin) is listed once.
		symlinkSync(second, join(root, "linked"));
		script(join(extra, "bun"), "echo 1.3.0");
		writeFileSync(join(extra, "pnpm"), "not executable");
		const env = { PATH: [first, second, join(root, "linked"), join(root, "missing")].join(":") };

		const found = findPackageManagers({ env, platform: "linux", extraDirs: [extra, second] });
		expect(found).toEqual([
			{ name: "npm", path: join(first, "npm"), onPath: true },
			{ name: "npm", path: join(second, "npm"), onPath: true },
			{ name: "pnpm", path: join(second, "pnpm"), onPath: true },
			{ name: "bun", path: join(extra, "bun"), onPath: false },
		]);
	});

	it("reads versions and marks the one a bare name runs", async () => {
		script(join(first, "npm"), "echo v10.9.2");
		script(join(second, "npm"), "echo \"/usr/bin/env: 'node': No such file or directory\" >&2; exit 127");
		script(join(extra, "pnpm"), "echo 10.1.0");
		const env = { PATH: [first, second].join(":") };

		const managers = await detectPackageManagers({ env, platform: "linux", extraDirs: [extra] });
		expect(managers).toEqual([
			{ name: "npm", path: join(first, "npm"), onPath: true, default: true, version: "10.9.2" },
			{
				name: "npm",
				path: join(second, "npm"),
				onPath: true,
				error: "/usr/bin/env: 'node': No such file or directory",
			},
			// Only in a well-known directory: a bare `pnpm` would not run it.
			{ name: "pnpm", path: join(extra, "pnpm"), onPath: false, version: "10.1.0" },
		]);
	});

	it("gives up on a version check that hangs", async () => {
		script(join(first, "bun"), `PATH=${process.env.PATH ?? ""} sleep 10`);
		const [bun] = await detectPackageManagers({
			env: { PATH: first },
			platform: "linux",
			extraDirs: [],
			timeoutMs: 200,
		});
		expect(bun).toMatchObject({ name: "bun", default: true, error: "`--version` did not finish in time" });
		expect(bun?.version).toBeUndefined();
	});
});

describe("well-known install directories", () => {
	it("covers bun, pnpm, Volta and Homebrew", () => {
		const mac = wellKnownDirs("darwin", "/Users/u", { PNPM_HOME: "/Users/u/pnpm-home" });
		expect(mac).toEqual(
			expect.arrayContaining([
				"/Users/u/.bun/bin",
				"/Users/u/pnpm-home",
				"/Users/u/Library/pnpm",
				"/Users/u/.volta/bin",
				"/opt/homebrew/bin",
			]),
		);
		expect(wellKnownDirs("linux", "/home/u", {})).toContain("/home/u/.local/share/pnpm");
		expect(wellKnownDirs("linux", "/home/u", {})).not.toContain("/opt/homebrew/bin");
	});
});
