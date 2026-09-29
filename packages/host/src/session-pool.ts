import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PierProtocolError, type SessionSummary, type WorkspaceInfo } from "@pier/protocol";
import type { ConfigStore } from "./config.ts";
import { ManagedSession, type ManagedSessionOptions } from "./managed-session.ts";
import type { PiEnvironment } from "./pi/environment.ts";
import { SessionLock } from "./session-lock.ts";

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface SessionPoolOptions {
	env: PiEnvironment;
	config: ConfigStore;
	locksDir: string;
	/** Where deleted session files are moved. */
	trashDir: string;
	uiTimeoutMs?: number;
	idleTimeoutMs?: number;
	eventLogCapacity?: number;
	/** Interval of the idle sweeper. */
	sweepIntervalMs?: number;
	onSessionReplaced?: (session: ManagedSession, previousId: string) => void;
	onSessionClosed?: (session: ManagedSession) => void;
	onSessionActivity?: (session: ManagedSession) => void;
}

/** Active session pool keyed by pi session id, loaded on demand and evicted when idle. */
export class SessionPool {
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly opening = new Map<string, Promise<ManagedSession>>();
	/** Resolved paths of session files being deleted; they cannot be opened meanwhile. */
	private readonly deleting = new Set<string>();
	private sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly options: SessionPoolOptions) {}

	get size(): number {
		return this.sessions.size;
	}

	all(): ManagedSession[] {
		return [...this.sessions.values()];
	}

	get(sessionId: string): ManagedSession | undefined {
		return this.sessions.get(sessionId);
	}

	require(sessionId: string): ManagedSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new PierProtocolError("NOT_FOUND", `Session ${sessionId} is not open`);
		return session;
	}

	private workspaceAccessor(workspace: WorkspaceInfo): () => WorkspaceInfo {
		let last = workspace;
		return () => {
			const current = this.options.config.getWorkspace(workspace.id);
			if (current) last = current;
			return last;
		};
	}

	private sessionOptions(workspace: WorkspaceInfo): ManagedSessionOptions {
		return {
			env: this.options.env,
			workspace: this.workspaceAccessor(workspace),
			locksDir: this.options.locksDir,
			...(this.options.uiTimeoutMs === undefined ? {} : { uiTimeoutMs: this.options.uiTimeoutMs }),
			...(this.options.eventLogCapacity === undefined ? {} : { eventLogCapacity: this.options.eventLogCapacity }),
			onReplaced: (session, previousId) => {
				this.sessions.delete(previousId);
				this.sessions.set(session.id, session);
				this.options.onSessionReplaced?.(session, previousId);
			},
			onActivity: (session) => this.options.onSessionActivity?.(session),
		};
	}

	private add(session: ManagedSession): ManagedSession {
		this.sessions.set(session.id, session);
		return session;
	}

	async create(workspace: WorkspaceInfo, name?: string): Promise<ManagedSession> {
		const sessionManager = this.options.env.newSessionManager(workspace.path);
		const session = this.add(await ManagedSession.start(this.sessionOptions(workspace), sessionManager));
		if (name) session.rename(name);
		return session;
	}

	private findActiveByPath(path: string): ManagedSession | undefined {
		return this.all().find((s) => s.session.sessionFile && resolve(s.session.sessionFile) === resolve(path));
	}

	/**
	 * Open a session that belongs to `workspace`. Paths must come from the workspace's
	 * session list, so clients cannot make the host parse arbitrary files.
	 */
	async open(workspace: WorkspaceInfo, target: { sessionId: string } | { path: string }): Promise<ManagedSession> {
		if ("sessionId" in target) {
			const active = this.sessions.get(target.sessionId);
			if (active) {
				if (active.workspaceId !== workspace.id) throw new PierProtocolError("NOT_FOUND", "Session not in workspace");
				return active;
			}
		}
		const infos = await this.options.env.listSessions(workspace.path);
		const info =
			"sessionId" in target
				? infos.find((i) => i.id === target.sessionId)
				: infos.find((i) => resolve(i.path) === resolve(target.path));
		if (!info) throw new PierProtocolError("NOT_FOUND", "Session not found in this workspace");

		const active = this.findActiveByPath(info.path) ?? this.sessions.get(info.id);
		if (active) return active;

		const key = resolve(info.path);
		if (this.deleting.has(key)) throw new PierProtocolError("NOT_FOUND", "Session is being deleted");
		const pending = this.opening.get(key);
		if (pending) return pending;
		const promise = (async () => {
			const sessionManager = this.options.env.openSessionManager(info.path, workspace.path);
			return this.add(await ManagedSession.start(this.sessionOptions(workspace), sessionManager));
		})();
		this.opening.set(key, promise);
		try {
			return await promise;
		} finally {
			this.opening.delete(key);
		}
	}

	async fork(
		source: ManagedSession,
		entryId: string,
		position: "before" | "at",
	): Promise<{ session: ManagedSession; selectedText?: string }> {
		const workspace = this.options.config.getWorkspace(source.workspaceId);
		if (!workspace) throw new PierProtocolError("NOT_FOUND", "Workspace no longer exists");
		let forked: ReturnType<PiEnvironment["forkSessionManager"]>;
		try {
			forked = this.options.env.forkSessionManager(source.session, entryId, position);
		} catch (error) {
			throw new PierProtocolError("BAD_REQUEST", error instanceof Error ? error.message : String(error));
		}
		const session = this.add(await ManagedSession.start(this.sessionOptions(workspace), forked.sessionManager));
		return forked.selectedText === undefined ? { session } : { session, selectedText: forked.selectedText };
	}

	async list(workspace: WorkspaceInfo): Promise<SessionSummary[]> {
		const infos = await this.options.env.listSessions(workspace.path);
		const summaries = new Map<string, SessionSummary>();
		for (const info of infos) {
			summaries.set(info.id, {
				id: info.id,
				workspaceId: workspace.id,
				path: info.path,
				...(info.name ? { name: info.name } : {}),
				cwd: info.cwd,
				createdAt: info.created.toISOString(),
				modifiedAt: info.modified.toISOString(),
				messageCount: info.messageCount,
				firstMessage: info.firstMessage.slice(0, 200),
				...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
				active: false,
				state: "inactive",
			});
		}
		for (const session of this.all()) {
			if (session.workspaceId !== workspace.id) continue;
			const listed = summaries.get(session.id);
			const live = session.summary();
			summaries.set(session.id, listed ? { ...listed, ...live, createdAt: listed.createdAt } : live);
		}
		return [...summaries.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
	}

	/**
	 * Close a session of `workspace` (if active) and move its file to the trash. Resolves to
	 * false when the workspace has no such session. The file is taken from the active session
	 * or the workspace's session list, so clients cannot make the host move arbitrary files.
	 */
	async delete(workspace: WorkspaceInfo, sessionId: string, force = false): Promise<boolean> {
		let active = this.sessions.get(sessionId);
		if (active && active.workspaceId !== workspace.id) {
			throw new PierProtocolError("NOT_FOUND", "Session not in workspace");
		}
		let file = active?.session.sessionFile;
		if (!active) {
			const infos = await this.options.env.listSessions(workspace.path);
			file = infos.find((i) => i.id === sessionId)?.path;
			if (!file) return false;
		}
		const key = file ? resolve(file) : undefined;
		if (key && this.deleting.has(key)) throw new PierProtocolError("CONFLICT", "Session is already being deleted");
		if (key) this.deleting.add(key);
		try {
			const opening = key ? this.opening.get(key) : undefined;
			if (opening) await opening.catch(() => undefined);
			active = this.sessions.get(sessionId) ?? (file ? this.findActiveByPath(file) : undefined);
			if (active) await this.close(active.id, force, "deleted");
			if (!file || !existsSync(file)) return active !== undefined;
			// Refuses when another Pier host has the session open.
			const lock = SessionLock.acquire(this.options.locksDir, file);
			try {
				moveToTrash(file, this.options.trashDir);
			} finally {
				lock.release();
			}
			return true;
		} finally {
			if (key) this.deleting.delete(key);
		}
	}

	async close(sessionId: string, force = false, reason: "closed" | "idle" | "deleted" = "closed"): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		if (session.state !== "idle" && !force) {
			throw new PierProtocolError("CONFLICT", "Session is running; abort it first or pass force");
		}
		this.sessions.delete(sessionId);
		await session.dispose(reason);
		this.options.onSessionClosed?.(session);
		return true;
	}

	startSweeper(): void {
		if (this.sweeper) return;
		const interval = this.options.sweepIntervalMs ?? 60_000;
		this.sweeper = setInterval(() => void this.sweep(), interval);
		this.sweeper.unref?.();
	}

	/** Dispose sessions with no subscribers, no running work, and no activity for the idle timeout. */
	async sweep(now = Date.now()): Promise<string[]> {
		const timeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		const evicted: string[] = [];
		for (const session of this.all()) {
			if (session.subscriberCount > 0 || session.busy) continue;
			if (now - session.lastActivity < timeout) continue;
			const id = session.id;
			await this.close(id, false, "idle").catch(() => false);
			evicted.push(id);
		}
		return evicted;
	}

	async disposeAll(timeoutMs = 5000): Promise<void> {
		if (this.sweeper) clearInterval(this.sweeper);
		this.sweeper = undefined;
		const sessions = this.all();
		this.sessions.clear();
		// An extension's session_shutdown handler must not be able to block host shutdown.
		await Promise.allSettled(
			sessions.map((s) =>
				Promise.race([
					s.dispose("host_shutdown"),
					new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
				]),
			),
		);
	}
}

/** Move a session file into `trashDir` under a unique name (copying across file systems). */
function moveToTrash(file: string, trashDir: string): string {
	mkdirSync(trashDir, { recursive: true, mode: 0o700 });
	const target = join(trashDir, `${Date.now()}-${basename(file)}`);
	try {
		renameSync(file, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		copyFileSync(file, target, constants.COPYFILE_EXCL);
		rmSync(file);
	}
	return target;
}
