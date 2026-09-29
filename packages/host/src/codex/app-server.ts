import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

export interface AppServerOptions {
	executable: string;
	/** Arguments before `app-server` flags; defaults to `["app-server"]`. */
	args?: string[];
	env?: NodeJS.ProcessEnv;
	clientName: string;
	clientVersion: string;
	log?: (message: string) => void;
	/** Timeout of one request. */
	requestTimeoutMs?: number;
}

export type NotificationHandler = (method: string, params: Json) => void;
/** Answer a request the server sent (approvals, questions). Throw to reply with an error. */
export type ServerRequestHandler = (method: string, params: Json) => Promise<unknown>;

export class AppServerError extends Error {
	constructor(
		message: string,
		readonly code?: number,
	) {
		super(message);
	}
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Client of `codex app-server`: newline-delimited JSON-RPC over the child's stdio. One process
 * serves every Codex thread of the host; notifications and server requests are dispatched to
 * the registered handlers.
 */
export class CodexAppServer {
	private child: ChildProcessWithoutNullStreams | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly notificationHandlers = new Set<NotificationHandler>();
	private readonly exitHandlers = new Set<(reason: string) => void>();
	private requestHandler: ServerRequestHandler | undefined;
	private starting: Promise<void> | undefined;
	private stderrTail: string[] = [];
	private closed = false;

	constructor(private readonly options: AppServerOptions) {}

	get running(): boolean {
		return this.child !== undefined && this.starting === undefined;
	}

	onNotification(handler: NotificationHandler): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	onExit(handler: (reason: string) => void): () => void {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	setRequestHandler(handler: ServerRequestHandler): void {
		this.requestHandler = handler;
	}

	/** Start the process and complete the `initialize` handshake (once; restarts after an exit). */
	start(): Promise<void> {
		if (this.closed) return Promise.reject(new AppServerError("The Codex app server was closed"));
		if (this.child && !this.starting) return Promise.resolve();
		this.starting ??= this.spawnAndInitialize().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async spawnAndInitialize(): Promise<void> {
		const child = spawn(this.options.executable, this.options.args ?? ["app-server"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: this.options.env ?? process.env,
			windowsHide: true,
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.options.executable),
		});
		this.child = child;
		this.stderrTail = [];
		child.stdin.on("error", () => {});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				this.stderrTail.push(line);
				if (this.stderrTail.length > 20) this.stderrTail.shift();
				this.options.log?.(`codex app-server: ${line.slice(0, 500)}`);
			}
		});
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => this.onLine(line));
		const exited = new Promise<never>((_, reject) => {
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				const reason = `Codex app server exited (${signal ?? `code ${code}`})${
					this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(" | ")}` : ""
				}`;
				if (this.child === child) this.child = undefined;
				for (const [id, pending] of this.pending) {
					if (pending.timer) clearTimeout(pending.timer);
					pending.reject(new AppServerError(reason));
					this.pending.delete(id);
				}
				for (const handler of this.exitHandlers) handler(reason);
				reject(new AppServerError(reason));
			};
			child.once("exit", onExit);
			child.once("error", (error) => {
				if (this.child === child) this.child = undefined;
				reject(new AppServerError(`Could not start Codex: ${error.message}`));
			});
		});
		exited.catch(() => {});
		const initialized = (async () => {
			await this.send("initialize", {
				clientInfo: { name: this.options.clientName, title: "Pier", version: this.options.clientVersion },
				capabilities: { experimentalApi: false, requestAttestation: false },
			});
			this.write({ method: "initialized" });
		})();
		await Promise.race([initialized, exited]);
	}

	private write(message: Json): void {
		const child = this.child;
		if (!child) throw new AppServerError("The Codex app server is not running");
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private send(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new AppServerError(`Codex did not answer ${method} in time`));
						}, timeoutMs)
					: undefined;
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ id, method, params });
			} catch (error) {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
				reject(error as Error);
			}
		});
	}

	async request<T = Json>(method: string, params: unknown): Promise<T> {
		await this.start();
		return (await this.send(method, params)) as T;
	}

	private onLine(line: string): void {
		if (!line.trim()) return;
		let message: Json;
		try {
			message = JSON.parse(line) as Json;
		} catch {
			this.options.log?.(`codex app-server sent invalid JSON: ${line.slice(0, 200)}`);
			return;
		}
		const id = message.id;
		const method = typeof message.method === "string" ? message.method : undefined;
		if (method && id !== undefined && id !== null) {
			void this.answer(id, method, (message.params ?? {}) as Json);
			return;
		}
		if (method) {
			for (const handler of this.notificationHandlers) {
				try {
					handler(method, (message.params ?? {}) as Json);
				} catch (error) {
					this.options.log?.(`codex notification ${method} failed: ${error instanceof Error ? error.message : error}`);
				}
			}
			return;
		}
		if (typeof id === "number") {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (pending.timer) clearTimeout(pending.timer);
			const error = message.error as Json | undefined;
			if (error) {
				pending.reject(
					new AppServerError(String(error.message ?? "Codex request failed"), Number(error.code ?? 0) || undefined),
				);
			} else pending.resolve(message.result);
		}
	}

	private async answer(id: unknown, method: string, params: Json): Promise<void> {
		try {
			if (!this.requestHandler) throw new AppServerError(`Unsupported request ${method}`);
			const result = await this.requestHandler(method, params);
			this.write({ id, result: result ?? {} });
		} catch (error) {
			try {
				this.write({
					id,
					error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
				});
			} catch {
				// The server went away.
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.stdin.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2000);
			timer.unref?.();
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}
}
