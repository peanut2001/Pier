import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PierProtocolError } from "@pier/protocol";

interface LockContent {
	pid: number;
	path: string;
	acquiredAt: string;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Advisory lock that prevents two Pier hosts from writing the same session file.
 * Lock files live in `~/.pier/locks` so pi's session directories stay untouched.
 */
export class SessionLock {
	private released = false;

	private constructor(readonly lockPath: string) {}

	static acquire(locksDir: string, sessionFile: string): SessionLock {
		mkdirSync(locksDir, { recursive: true, mode: 0o700 });
		const name = createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
		const lockPath = join(locksDir, `${name}.lock`);
		const content: LockContent = { pid: process.pid, path: sessionFile, acquiredAt: new Date().toISOString() };
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = openSync(lockPath, "wx", 0o600);
				writeSync(fd, JSON.stringify(content));
				closeSync(fd);
				return new SessionLock(lockPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let holder: LockContent | undefined;
				try {
					holder = JSON.parse(readFileSync(lockPath, "utf8")) as LockContent;
				} catch {
					holder = undefined;
				}
				if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
					throw new PierProtocolError("CONFLICT", `Session is open in another Pier host (pid ${holder.pid})`);
				}
				rmSync(lockPath, { force: true });
			}
		}
		throw new PierProtocolError("CONFLICT", "Could not acquire the session lock");
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		rmSync(this.lockPath, { force: true });
	}
}

interface FileStamp {
	size: number;
	mtimeMs: number;
}

function stamp(path: string): FileStamp | undefined {
	try {
		const s = statSync(path);
		return { size: s.size, mtimeMs: s.mtimeMs };
	} catch {
		return undefined;
	}
}

/**
 * Detects writes to a session file made outside this host (for example `pi --resume`
 * in a terminal). The host records the file stamp after its own writes and refuses to
 * append when the file changed behind its back.
 */
export class ExternalChangeGuard {
	private known: FileStamp | undefined;

	constructor(private path: string | undefined) {
		this.record();
	}

	setPath(path: string | undefined): void {
		this.path = path;
		this.record();
	}

	record(): void {
		this.known = this.path ? stamp(this.path) : undefined;
	}

	/** Whether the file differs from the last recorded state. */
	changedExternally(): boolean {
		if (!this.path) return false;
		const current = stamp(this.path);
		if (!this.known) return false;
		if (!current) return true;
		return current.size !== this.known.size || current.mtimeMs !== this.known.mtimeMs;
	}
}
