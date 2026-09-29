/**
 * The user's login-shell `PATH`, for a host started by the desktop app.
 *
 * Apps launched from the Dock, Finder, a desktop launcher or an AppImage do not inherit the
 * `PATH` set up by `~/.zprofile`, `~/.bashrc`, nvm, fnm, mise, Volta, Homebrew, bun or pnpm, so
 * `npm` / `pnpm` / `bun` / `git` that work in a terminal are "not found" for pi. On Unix the
 * sidecar asks the user's shell (interactive login, like a new terminal) for its `PATH` once at
 * startup and puts those entries in front of the inherited ones. Windows GUI apps already get
 * the user's `PATH`.
 */
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { basename, delimiter } from "node:path";

const BEGIN = "__PIER_ENV_BEGIN__";
const END = "__PIER_ENV_END__";

/** Set while the probe runs, so shell startup files can skip slow or interactive setup. */
export const RESOLVING_ENV_VAR = "PIER_RESOLVING_ENVIRONMENT";

export const LOGIN_SHELL_TIMEOUT_MS = 5000;

export interface LoginShellPathOptions {
	/** Shell to ask. Defaults to `$SHELL`, then the account's login shell, then `/bin/sh`. */
	shell?: string;
	/** Environment to start it with. Defaults to `process.env` (without AppImage entries). */
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
	if (env.SHELL) return env.SHELL;
	try {
		const shell = userInfo().shell;
		if (shell) return shell;
	} catch {
		// No passwd entry.
	}
	return "/bin/sh";
}

/** Split a `PATH`-style list, dropping empty entries. */
export function splitPath(value: string | undefined, separator = delimiter): string[] {
	return (value ?? "").split(separator).filter((entry) => entry.length > 0);
}

/** `first`'s entries in order, then `rest`'s entries that are not in `first`, without duplicates. */
export function mergePath(first: string | undefined, rest: string | undefined, separator = delimiter): string {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const entry of [...splitPath(first, separator), ...splitPath(rest, separator)]) {
		if (seen.has(entry)) continue;
		seen.add(entry);
		merged.push(entry);
	}
	return merged.join(separator);
}

/** Remove the entries an AppImage runtime puts into `PATH`-style variables (`$APPDIR/...`). */
function withoutAppDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const appdir = env.APPDIR;
	if (!appdir) return env;
	const next = { ...env };
	for (const key of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS"]) {
		const value = next[key];
		if (value === undefined) continue;
		const kept = splitPath(value).filter((entry) => !entry.startsWith(appdir));
		if (kept.length) next[key] = kept.join(delimiter);
		else delete next[key];
	}
	return next;
}

/** Arguments that make `shell` an interactive login shell running `command`. */
function shellArgs(shell: string, command: string): string[] {
	const name = basename(shell);
	// csh / tcsh only accept `-l` on its own; their startup files still run for `-i`.
	if (name === "csh" || name === "tcsh") return ["-i", "-c", command];
	return ["-i", "-l", "-c", command];
}

/** Read `PATH` from `env`'s output between the markers. */
export function parseShellPath(output: string): string | undefined {
	const start = output.lastIndexOf(BEGIN);
	if (start < 0) return undefined;
	const end = output.indexOf(END, start);
	const block = output.slice(start + BEGIN.length, end < 0 ? undefined : end);
	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith("PATH=")) return line.slice("PATH=".length) || undefined;
	}
	return undefined;
}

/**
 * Ask the user's shell for its `PATH`. Resolves undefined when the shell cannot be started,
 * exits without printing it, or takes longer than `timeoutMs` (it is then killed).
 */
export function readLoginShellPath(options: LoginShellPathOptions = {}): Promise<string | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	const baseEnv = withoutAppDir(options.env ?? process.env);
	const shell = options.shell ?? defaultShell(baseEnv);
	const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
	// `echo` and `env` behave the same in sh, bash, zsh, fish and csh.
	const command = `echo ${BEGIN}; env; echo ${END}`;
	return new Promise((resolve) => {
		let output = "";
		let done = false;
		const finish = (value: string | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(shell, shellArgs(shell, command), {
				env: { ...baseEnv, [RESOLVING_ENV_VAR]: "1" },
				stdio: ["ignore", "pipe", "ignore"],
				// Its own session: an interactive shell must not take over the terminal (when the
				// host itself runs in one), and a timeout kills whatever its startup files started.
				detached: true,
			});
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			finish(undefined);
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (output.length < 1_000_000) output += chunk;
			// Some startup files leave background jobs holding stdout open; stop at the end marker.
			if (output.includes(END)) {
				finish(parseShellPath(output));
				child.stdout?.destroy();
				child.unref();
			}
		});
		child.on("error", () => finish(undefined));
		child.on("close", () => finish(parseShellPath(output)));
	});
}

/**
 * Put the login shell's `PATH` in front of this process's `PATH` (keeping the inherited entries
 * after it). Returns the entries that were added, or undefined when the shell gave no `PATH`.
 */
export async function applyLoginShellPath(options: LoginShellPathOptions = {}): Promise<string[] | undefined> {
	const shellPath = await readLoginShellPath(options);
	if (!shellPath) return undefined;
	const before = new Set(splitPath(process.env.PATH));
	process.env.PATH = mergePath(shellPath, process.env.PATH);
	return splitPath(shellPath).filter((entry) => !before.has(entry));
}
