/**
 * The npm-compatible package managers pi can use for `npmCommand` (`host.packageManagers`, 1.16):
 * npm, pnpm and bun, found on the host's `PATH` and in the directories their installers use.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PackageManagerInfo, PackageManagerName } from "@pier/protocol";

export const PACKAGE_MANAGER_NAMES: readonly PackageManagerName[] = ["npm", "pnpm", "bun"];

const VERSION_TIMEOUT_MS = 5000;
const MAX_RESULTS = 24;

export interface DetectOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	/** Directories searched after `PATH`. Defaults to the package managers' usual install locations. */
	extraDirs?: string[];
	timeoutMs?: number;
}

function executableNames(name: PackageManagerName, platform: NodeJS.Platform): string[] {
	if (platform !== "win32") return [name];
	return name === "bun" ? ["bun.exe"] : [`${name}.cmd`, `${name}.exe`];
}

/** Where npm, pnpm and bun install themselves when that directory is not on `PATH`. */
export function wellKnownDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
	if (platform === "win32") {
		const dirs = [join(home, ".bun", "bin")];
		if (env.APPDATA) dirs.push(join(env.APPDATA, "npm"));
		if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "pnpm"), join(env.LOCALAPPDATA, "Volta", "bin"));
		if (env.ProgramFiles) dirs.push(join(env.ProgramFiles, "nodejs"));
		return dirs;
	}
	const dirs = [
		join(home, ".bun", "bin"),
		env.PNPM_HOME,
		platform === "darwin" ? join(home, "Library", "pnpm") : join(home, ".local", "share", "pnpm"),
		join(home, ".volta", "bin"),
		join(home, ".npm-global", "bin"),
		join(home, ".local", "bin"),
		join(home, ".nvm", "current", "bin"),
		platform === "darwin" ? "/opt/homebrew/bin" : undefined,
		"/usr/local/bin",
		"/usr/bin",
	];
	return dirs.filter((dir): dir is string => !!dir);
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

interface Candidate {
	name: PackageManagerName;
	path: string;
	onPath: boolean;
}

/** Every npm / pnpm / bun executable, `PATH` order first, one entry per real file. */
export function findPackageManagers(options: DetectOptions = {}): Candidate[] {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const separator = platform === "win32" ? ";" : ":";
	// Windows keeps the variable as `Path`.
	const pathValue = env.PATH ?? env.Path ?? "";
	const pathDirs = pathValue.split(separator).filter((dir) => dir.length > 0);
	const extraDirs = options.extraDirs ?? wellKnownDirs(platform, home, env);
	const found: Candidate[] = [];
	const seen = new Set<string>();
	for (const name of PACKAGE_MANAGER_NAMES) {
		const dirs: Array<[string, boolean]> = [
			...pathDirs.map((dir): [string, boolean] => [dir, true]),
			...extraDirs.map((dir): [string, boolean] => [dir, false]),
		];
		for (const [dir, onPath] of dirs) {
			for (const file of executableNames(name, platform)) {
				const onDisk = join(dir, file);
				if (!isExecutable(onDisk, platform)) continue;
				// Through the real directory: version managers put per-shell symlinks on PATH (fnm's
				// `fnm_multishells/<pid>`) that disappear later, while the directory they point to stays.
				const path = join(realPath(dir), file);
				const key = `${name}\0${realPath(path)}`;
				if (seen.has(key)) continue;
				seen.add(key);
				found.push({ name, path, onPath });
			}
		}
	}
	return found.slice(0, MAX_RESULTS);
}

function firstLine(text: string, max: number): string {
	return (text.split(/\r?\n/).find((line) => line.trim()) ?? "").trim().slice(0, max);
}

/** Run `<path> --version` with the host's environment (the one pi runs it with). */
export function readVersion(
	path: string,
	options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<{ version?: string; error?: string }> {
	const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
	// Not a project directory: corepack's pnpm refuses to run where package.json asks for another
	// package manager.
	const cwd = options.cwd ?? homedir();
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (result: { version?: string; error?: string }) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			// `.cmd` shims only run through cmd.exe.
			child = /\.(cmd|bat)$/i.test(path)
				? spawn(`"${path}" --version`, { cwd, env: options.env ?? process.env, shell: true, windowsHide: true })
				: spawn(path, ["--version"], {
						cwd,
						env: options.env ?? process.env,
						windowsHide: true,
						// Its own process group on Unix, so a timeout also stops what a wrapper script started.
						detached: process.platform !== "win32",
					});
		} catch (error) {
			resolve({ error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const timer = setTimeout(() => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			finish({ error: "`--version` did not finish in time" });
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (stdout.length < 10_000) stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < 10_000) stderr += chunk;
		});
		child.stdin?.end();
		child.on("error", (error) => finish({ error: error.message }));
		child.on("close", (code) => {
			const version = firstLine(stdout, 100).replace(/^v(?=\d)/, "");
			if (code === 0 && version) finish({ version });
			else finish({ error: firstLine(stderr, 300) || `exited with code ${code ?? "unknown"}` });
		});
	});
}

/** Find npm, pnpm and bun and read their versions. */
export async function detectPackageManagers(options: DetectOptions = {}): Promise<PackageManagerInfo[]> {
	const candidates = findPackageManagers(options);
	// A bare name runs the first one of that name on PATH.
	const defaults = new Set<Candidate>();
	const named = new Set<PackageManagerName>();
	for (const candidate of candidates) {
		if (!candidate.onPath || named.has(candidate.name)) continue;
		named.add(candidate.name);
		defaults.add(candidate);
	}
	return Promise.all(
		candidates.map(async (candidate): Promise<PackageManagerInfo> => {
			const isDefault = defaults.has(candidate);
			const result = await readVersion(candidate.path, {
				...(options.env ? { env: options.env } : {}),
				...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			});
			return {
				name: candidate.name,
				path: candidate.path,
				onPath: candidate.onPath,
				...(isDefault ? { default: true as const } : {}),
				...result,
			};
		}),
	);
}
