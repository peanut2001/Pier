import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergePath, parseShellPath, RESOLVING_ENV_VAR, readLoginShellPath } from "../src/login-shell-path.ts";

const posix = process.platform !== "win32";

describe("login shell PATH helpers", () => {
	it("puts the login shell's entries first and keeps the inherited ones after them", () => {
		expect(mergePath("/a:/b:/a", "/b:/c::/d", ":")).toBe("/a:/b:/c:/d");
		expect(mergePath(undefined, "/c", ":")).toBe("/c");
	});

	it("reads PATH between the markers, ignoring what startup files print", () => {
		const output = [
			"Welcome!",
			"__PIER_ENV_BEGIN__",
			"HOME=/home/u",
			"MYPATH=/nope",
			"PATH=/home/u/.bun/bin:/usr/bin",
			"__PIER_ENV_END__",
			"bye",
		].join("\n");
		expect(parseShellPath(output)).toBe("/home/u/.bun/bin:/usr/bin");
		expect(parseShellPath("PATH=/usr/bin")).toBeUndefined();
	});
});

describe.runIf(posix)("reading the login shell's PATH", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-shell-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/** A shell that adds to PATH like a profile would, then runs `-c`'s command (its 4th argument). */
	function fakeShell(body: string): string {
		const path = join(root, "fake-shell");
		writeFileSync(path, `#!/bin/sh\n${body}\nshift 3\neval "$1"\n`);
		chmodSync(path, 0o755);
		return path;
	}

	it("returns the PATH the shell's startup files set up", async () => {
		const shell = fakeShell(
			`[ "$1 $2 $3" = "-i -l -c" ] || exit 3\n[ "$${RESOLVING_ENV_VAR}" = 1 ] || exit 4\necho noise\nPATH="/home/u/.bun/bin:$PATH"; export PATH`,
		);
		const path = await readLoginShellPath({ shell, env: { PATH: "/usr/bin:/bin" } });
		expect(path).toBe("/home/u/.bun/bin:/usr/bin:/bin");
	});

	it("starts the shell without the entries an AppImage added", async () => {
		const shell = fakeShell("");
		const path = await readLoginShellPath({
			shell,
			env: { APPDIR: "/tmp/.mount_pier", PATH: "/tmp/.mount_pier/usr/bin:/usr/bin:/bin" },
		});
		expect(path).toBe("/usr/bin:/bin");
	});

	it("gives up on a shell that hangs or cannot start", async () => {
		const shell = fakeShell("sleep 10");
		expect(await readLoginShellPath({ shell, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 200 })).toBeUndefined();
		expect(await readLoginShellPath({ shell: join(root, "missing"), env: {} })).toBeUndefined();
	});
});
