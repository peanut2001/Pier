import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { mergePath } from "../login-shell-path.ts";

const BEGIN = "# >>> Pier Agent commands >>>";
const END = "# <<< Pier Agent commands <<<";

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function updateProfile(path: string, command: string): Promise<void> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		contents = "";
	}
	const block = `${BEGIN}\n${command}\n${END}`;
	const start = contents.indexOf(BEGIN);
	const end = contents.indexOf(END, start);
	if (start >= 0 && end < 0) throw new Error(`请先修复 ${path} 中未闭合的 Pier PATH 配置`);
	const next =
		start >= 0
			? contents.slice(0, start) + block + contents.slice(end + END.length)
			: `${contents}${contents.endsWith("\n") || !contents ? "" : "\n"}\n${block}\n`;
	if (next !== contents) await writeFile(path, next, { mode: 0o600 });
}

export interface InstallationPathOptions {
	home: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** Injectable for Windows tests; never invokes a shell for Unix profile updates. */
	runPowerShell?: (script: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ env, timeout: 15_000, windowsHide: true },
			(error) => (error ? reject(new Error("无法设置用户 PATH，请检查系统权限后重试")) : resolve()),
		);
	});
}

/** Persist the public command directory for new terminals, and use it in this Host immediately. */
export async function configureInstallationPath(bin: string, options: InstallationPathOptions): Promise<void> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (platform === "win32") {
		await (options.runPowerShell ?? runPowerShell)(
			`$ErrorActionPreference = 'Stop'
$bin = $env:PIER_AGENT_COMMAND_DIRECTORY
$previous = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($previous -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $bin.TrimEnd('\\') })
[Environment]::SetEnvironmentVariable('Path', (@($bin) + $entries -join ';'), 'User')
# Notify Explorer so subsequently opened terminals inherit the updated user environment.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PierEnvironment {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][PierEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)`,
			{ ...env, PIER_AGENT_COMMAND_DIRECTORY: bin },
		);
	} else {
		await mkdir(options.home, { recursive: true });
		const command = `case "$PATH" in
  ${quote(bin)}|${quote(bin)}:*) ;;
  *) export PATH=${quote(bin)}:"$PATH" ;;
esac`;
		// Bash uses the first existing login profile; .bashrc also covers non-login terminals.
		const profiles = [".profile", ".bashrc", ".zprofile", ".zshrc"];
		for (const name of [".bash_profile", ".bash_login"]) {
			try {
				await readFile(join(options.home, name));
				profiles.push(name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		for (const name of profiles) await updateProfile(join(options.home, name), command);
		const fish = join(options.home, ".config", "fish", "conf.d");
		await mkdir(fish, { recursive: true });
		await updateProfile(join(fish, "pier-agent-path.fish"), `fish_add_path --move --prepend ${quote(bin)}`);
	}
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = mergePath(bin, env[pathKey], platform === "win32" ? ";" : delimiter);
}
