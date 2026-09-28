import { homedir } from "node:os";
import { join } from "node:path";

/** Pier's own state directory (separate from pi's `~/.pi/agent`). Override with `PIER_DIR`. */
export function defaultPierDir(): string {
	return process.env.PIER_DIR || join(homedir(), ".pier");
}

export function configPath(pierDir: string): string {
	return join(pierDir, "config.json");
}

/** Runtime discovery file written while a host is running (port + local token). */
export function runtimeFilePath(pierDir: string): string {
	return join(pierDir, "run", "host.json");
}

export function locksDir(pierDir: string): string {
	return join(pierDir, "locks");
}
