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

/** Deleted session files, kept so they can be restored by hand. */
export function sessionTrashDir(pierDir: string): string {
	return join(pierDir, "trash", "sessions");
}

/** Host static key for the remote secure channel. */
export function identityPath(pierDir: string): string {
	return join(pierDir, "identity.json");
}

/** Paired remote devices. */
export function devicesPath(pierDir: string): string {
	return join(pierDir, "devices.json");
}

/** Append-only log of actions taken by remote devices. */
export function auditLogPath(pierDir: string): string {
	return join(pierDir, "audit.log");
}

/** The saved 云链API personal-center login. */
export function accountPath(pierDir: string): string {
	return join(pierDir, "account.json");
}
