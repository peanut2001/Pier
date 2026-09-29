/**
 * The desktop shell the host runs in (the Tauri app), reached over the sidecar's stdio.
 *
 * The shell owns the app's updater; the host relays it to its clients (`update.*`, 1.13) so a
 * paired computer or phone can update Pier on this computer. One JSON object per line:
 *
 * - shell → host (stdin): `{"type":"pier.shell.updateStatus","status":{…}}` whenever the
 *   updater's state changes (and once when the host is ready), and
 *   `{"type":"pier.shell.response","id":"…","ok":true,"result":{…}}` /
 *   `{"type":"pier.shell.response","id":"…","ok":false,"error":"…"}`.
 * - host → shell (stdout, after the `pier.ready` line):
 *   `{"type":"pier.shell.request","id":"…","method":"update.check"}`.
 *
 * A shell that never reports an updater status (an older app, or no app at all) has no updater
 * the host can drive.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AppUpdateState, AppUpdateStatus } from "@pier/protocol";

export const SHELL_UPDATE_STATUS = "pier.shell.updateStatus";
export const SHELL_REQUEST = "pier.shell.request";
export const SHELL_RESPONSE = "pier.shell.response";

export type ShellMethod = "update.check" | "update.install";

/** The desktop app around the host, as far as the host can drive it. */
export interface AppShell {
	/** The updater's latest status; undefined while the shell has not reported one. */
	readonly updateStatus: AppUpdateStatus | undefined;
	onUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void;
	/** Ask the shell's updater to check or install; resolves with its status afterwards. */
	request(method: ShellMethod): Promise<AppUpdateStatus>;
	close(): void;
}

const STATES: ReadonlySet<AppUpdateState> = new Set([
	"unsupported",
	"idle",
	"checking",
	"upToDate",
	"available",
	"downloading",
	"installing",
	"error",
]);

/** A check can take the updater's 30 s timeout; an install checks first when needed. */
export const SHELL_REQUEST_TIMEOUT_MS = 90_000;

const MAX_TEXT = 200_000;

function text(value: unknown, max = 1000): string | undefined {
	return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Validate an updater status from the shell (the Rust `UpdateStatus`, where missing fields
 * are `null`) and drop empty fields.
 */
export function parseUpdateStatus(raw: unknown): AppUpdateStatus | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	const state = value.state;
	if (typeof state !== "string" || !STATES.has(state as AppUpdateState)) return undefined;
	const currentVersion = text(value.currentVersion, 100);
	if (!currentVersion) return undefined;
	const status: AppUpdateStatus = {
		state: state as AppUpdateState,
		currentVersion,
		autoCheck: value.autoCheck === true,
		downloaded: count(value.downloaded) ?? 0,
	};
	const version = text(value.version, 100);
	if (version) status.version = version;
	const notes = text(value.notes, MAX_TEXT);
	if (notes) status.notes = notes;
	const date = text(value.date, 100);
	if (date) status.date = date;
	const total = count(value.total);
	if (total !== undefined) status.total = total;
	const error = text(value.error, 4000);
	if (error) status.error = error;
	const lastChecked = count(value.lastChecked);
	if (lastChecked !== undefined) status.lastChecked = lastChecked;
	if (value.installNeedsAuth === true) status.installNeedsAuth = true;
	return status;
}

interface Pending {
	resolve(status: AppUpdateStatus): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export interface StdioShellOptions {
	timeoutMs?: number;
	log?: (message: string) => void;
}

/** The shell on the other end of the sidecar's stdin / stdout. */
export class StdioShell implements AppShell {
	private status: AppUpdateStatus | undefined;
	private readonly listeners = new Set<(status: AppUpdateStatus) => void>();
	private readonly pending = new Map<string, Pending>();
	private nextId = 1;
	private closed = false;
	private readonly lines;
	private readonly timeoutMs: number;
	private readonly log: (message: string) => void;

	constructor(
		input: Readable,
		private readonly output: Writable,
		options: StdioShellOptions = {},
	) {
		this.timeoutMs = options.timeoutMs ?? SHELL_REQUEST_TIMEOUT_MS;
		this.log = options.log ?? (() => {});
		this.lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		this.lines.on("line", (line) => this.receive(line));
		this.lines.on("close", () => this.close());
	}

	get updateStatus(): AppUpdateStatus | undefined {
		return this.status;
	}

	onUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(method: ShellMethod): Promise<AppUpdateStatus> {
		if (this.closed) return Promise.reject(new Error("The desktop app is not reachable"));
		const id = String(this.nextId++);
		return new Promise<AppUpdateStatus>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("The desktop app did not answer in time"));
			}, this.timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			this.output.write(`${JSON.stringify({ type: SHELL_REQUEST, id, method })}\n`);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.lines.close();
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("The desktop app is not reachable"));
			this.pending.delete(id);
		}
	}

	private receive(line: string): void {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) return;
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			return;
		}
		if (message.type === SHELL_UPDATE_STATUS) {
			const status = parseUpdateStatus(message.status);
			if (!status) {
				this.log("ignored an invalid update status from the desktop app");
				return;
			}
			this.status = status;
			for (const listener of [...this.listeners]) listener(status);
		} else if (message.type === SHELL_RESPONSE && typeof message.id === "string") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.ok === true) {
				const status = parseUpdateStatus(message.result);
				if (status) pending.resolve(status);
				else pending.reject(new Error("The desktop app sent an invalid update status"));
			} else {
				pending.reject(new Error(text(message.error, 4000) ?? "The desktop app could not do that"));
			}
		}
	}
}
