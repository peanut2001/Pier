import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureInstallationPath } from "../src/runtimes/installation-path.ts";
import { publishAgentCommand, sharedAgentPaths } from "../src/runtimes/shared-installation.ts";

describe("shared Agent commands", () => {
	let root: string;
	let home: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-shared-"));
		home = root;
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")("replaces an old CLI symlink without overwriting its package", async () => {
		const paths = sharedAgentPaths("claude-code", home);
		mkdirSync(paths.bin, { recursive: true });
		const old = join(home, "npm-claude");
		writeFileSync(old, "old-npm-package");
		symlinkSync(old, paths.executable);
		const next = join(home, "new-claude");
		writeFileSync(next, "new-native");
		await publishAgentCommand("claude-code", next, home);
		expect(readFileSync(paths.executable, "utf8")).toBe("new-native");
		expect(readFileSync(old, "utf8")).toBe("old-npm-package");
	});

	it("publishes Windows native commands and Codex companions, replacing older shell launchers", async () => {
		const paths = sharedAgentPaths("codex", home, "win32");
		mkdirSync(paths.bin, { recursive: true });
		for (const ext of ["exe", "cmd", "bat", "ps1"]) writeFileSync(join(paths.bin, `codex.${ext}`), "old-launcher");
		const pkg = join(home, "package", "bin");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "codex.exe"), "native-codex");
		writeFileSync(join(pkg, "codex-command-runner.exe"), "native-companion");
		await publishAgentCommand("codex", join(pkg, "codex.exe"), home, "win32");
		expect(readFileSync(paths.executable, "utf8")).toBe("native-codex");
		expect(readFileSync(join(paths.bin, "codex-command-runner.exe"), "utf8")).toBe("native-companion");
		expect(readdirSync(paths.bin).sort()).toEqual(["codex-command-runner.exe", "codex.exe"]);
	});

	it("restores launchers and companion programs if Windows publication fails partway through", async () => {
		const paths = sharedAgentPaths("codex", home, "win32");
		mkdirSync(paths.executable, { recursive: true }); // Main entry cannot be replaced.
		writeFileSync(join(paths.bin, "codex.cmd"), "old-command");
		writeFileSync(join(paths.bin, "codex-command-runner.exe"), "old-companion");
		const pkg = join(home, "package", "bin");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "codex.exe"), "new-codex");
		writeFileSync(join(pkg, "codex-command-runner.exe"), "new-companion");
		await expect(publishAgentCommand("codex", join(pkg, "codex.exe"), home, "win32")).rejects.toThrow("命令路径是目录");
		expect(readFileSync(join(paths.bin, "codex.cmd"), "utf8")).toBe("old-command");
		expect(readFileSync(join(paths.bin, "codex-command-runner.exe"), "utf8")).toBe("old-companion");
		expect(readdirSync(paths.bin).sort()).toEqual(["codex-command-runner.exe", "codex.cmd", "codex.exe"]);
	});

	it.skipIf(process.platform === "win32")(
		"preserves shell setup and makes new terminals choose the shared CLI over an older CLI",
		async () => {
			home = join(home, "home with ' and $ characters");
			mkdirSync(home);
			const paths = sharedAgentPaths("claude-code", home);
			mkdirSync(paths.bin, { recursive: true });
			const previous = join(home, "old-bin");
			mkdirSync(previous);
			writeFileSync(join(previous, "claude"), "#!/bin/sh\necho old\n", { mode: 0o755 });
			writeFileSync(paths.executable, "#!/bin/sh\necho new\n", { mode: 0o755 });
			const original = "# User configuration\nexport KEEP_THIS=yes\n";
			for (const name of [".profile", ".bashrc", ".bash_profile", ".zshrc"]) writeFileSync(join(home, name), original);
			const env = { PATH: `${previous}:/usr/bin:/bin` };
			await configureInstallationPath(paths.bin, { home, platform: "linux", env });
			const first = readFileSync(join(home, ".bash_profile"), "utf8");
			await configureInstallationPath(paths.bin, { home, platform: "linux", env });
			expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe(first);
			expect(first.startsWith(original)).toBe(true);
			const output = execFileSync(
				"/bin/sh",
				["-c", '. "$HOME/.bash_profile"; . "$HOME/.profile"; claude; echo "$KEEP_THIS"; echo "$PATH"'],
				{
					env: { HOME: home, PATH: `${previous}:/usr/bin:/bin` },
					encoding: "utf8",
				},
			);
			expect(output.trim().split("\n")).toEqual(["new", "yes", `${paths.bin}:${previous}:/usr/bin:/bin`]);
			expect(env.PATH).toBe(`${paths.bin}:${previous}:/usr/bin:/bin`);
		},
	);

	it("persists Windows user PATH through PowerShell and updates the Host's case-insensitive Path", async () => {
		const bin = String.raw`C:\Users\Someone's home\.local\bin`;
		const env = { Path: String.raw`C:\Windows;C:\old-cli` };
		const runPowerShell = vi.fn<(script: string, env: NodeJS.ProcessEnv) => Promise<void>>(async () => {});
		await configureInstallationPath(bin, { home, platform: "win32", env, runPowerShell });
		expect(runPowerShell).toHaveBeenCalledWith(expect.stringContaining("SetEnvironmentVariable"), {
			Path: String.raw`C:\Windows;C:\old-cli`,
			PIER_AGENT_COMMAND_DIRECTORY: bin,
		});
		expect(runPowerShell.mock.calls[0]?.[0]).not.toContain(bin); // Path is data, not PowerShell source.
		expect(env.Path).toBe(`${bin};C:\\Windows;C:\\old-cli`);
	});

	it("does not report successful PATH setup when Windows cannot persist it", async () => {
		const env = { Path: "old-path" };
		await expect(
			configureInstallationPath("new-bin", {
				home,
				platform: "win32",
				env,
				runPowerShell: async () => {
					throw new Error("registry denied");
				},
			}),
		).rejects.toThrow("registry denied");
		expect(env.Path).toBe("old-path");
		expect(existsSync(join(home, ".profile"))).toBe(false);
	});
});
