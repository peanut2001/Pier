import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import {
	type ApprovalDetails,
	type EventFrame,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type PierSessionEvent,
	type QueueState,
	type SessionCommandInfo,
	type SessionRunState,
	type SessionSnapshot,
	type SessionSummary,
	type StreamingBehavior,
	type SubscribeResult,
	type ThinkingLevel,
	type UiResponse,
	type WireEvent,
	type WorkspaceInfo,
} from "@pier/protocol";
import { DEFAULT_EVENT_LOG_CAPACITY, EventLog } from "./event-log.ts";
import { createApprovalExtension } from "./pi/approval-extension.ts";
import { type PiEnvironment, toModelInfo } from "./pi/environment.ts";
import { toWireEvent } from "./pi/events.ts";
import { createUiContext } from "./pi/ui-context.ts";
import { ExternalChangeGuard, SessionLock } from "./session-lock.ts";
import { UiBridge } from "./ui-bridge.ts";

export interface SessionSubscriber {
	readonly connectionId: string;
	send(frame: EventFrame): void;
}

interface SubscriberEntry {
	subscriber: SessionSubscriber;
	/** Until `start()` runs, live frames are buffered so they follow the replay/snapshot. */
	ready: boolean;
	buffer: EventFrame[];
}

export interface PendingSubscription {
	result: SubscribeResult;
	/** Send the replay (or snapshot) followed by buffered live events. Call after the response is sent. */
	start(): void;
}

export interface ManagedSessionOptions {
	env: PiEnvironment;
	workspace: () => WorkspaceInfo;
	locksDir: string;
	uiTimeoutMs?: number;
	eventLogCapacity?: number;
	/** Called after an extension command replaced the underlying pi session (new/fork/switch). */
	onReplaced?: (session: ManagedSession, previousId: string) => void;
	/** Called when the run state or the number of pending UI requests changes. */
	onActivity?: (session: ManagedSession) => void;
}

/** pi events that indicate the session file may have been written by this host. */
const WRITE_EVENTS = new Set([
	"entry_appended",
	"message_end",
	"agent_settled",
	"compaction_end",
	"session_info_changed",
	"thinking_level_changed",
]);

function toImages(images: ImageInput[] | undefined) {
	return images?.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

/**
 * One active pi session held by the host: owns the pi runtime, the event log,
 * the UI bridge, per-session approval allowances, and the subscriber set.
 */
export class ManagedSession {
	readonly bridge: UiBridge;
	readonly allowances = new Set<string>();
	private log: EventLog<WireEvent>;
	private readonly subscribers = new Map<string, SubscriberEntry>();
	private runtime!: AgentSessionRuntime;
	private unsubscribePi: (() => void) | undefined;
	private lock: SessionLock | undefined;
	private guard = new ExternalChangeGuard(undefined);
	private boundSessionId: string | undefined;
	private runState: SessionRunState = "idle";
	private disposed = false;
	lastActivity = Date.now();

	private constructor(private readonly options: ManagedSessionOptions) {
		this.log = new EventLog(options.eventLogCapacity ?? DEFAULT_EVENT_LOG_CAPACITY);
		this.bridge = new UiBridge({
			sessionId: () => this.id,
			emit: (event) => {
				this.emit(event);
				if (event.type === "ui.request" || event.type === "ui.resolved") this.options.onActivity?.(this);
			},
			...(options.uiTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.uiTimeoutMs }),
		});
	}

	static async start(
		options: ManagedSessionOptions,
		sessionManager: ReturnType<PiEnvironment["newSessionManager"]>,
	): Promise<ManagedSession> {
		const managed = new ManagedSession(options);
		const file = sessionManager.getSessionFile();
		if (file) managed.lock = SessionLock.acquire(options.locksDir, file);
		try {
			managed.runtime = await options.env.createRuntime({
				cwd: options.workspace().path,
				sessionManager,
				extensions: () => [createApprovalExtension(managed.approvalGate())],
			});
			managed.runtime.setRebindSession(async () => managed.bind());
			await managed.bind();
		} catch (error) {
			managed.lock?.release();
			throw error;
		}
		return managed;
	}

	private approvalGate() {
		return {
			policy: () => this.options.workspace().policy,
			workspacePath: () => this.options.workspace().path,
			allowances: this.allowances,
			requestApproval: async (details: ApprovalDetails, signal: AbortSignal | undefined) =>
				this.bridge.request(
					{ kind: "approval", title: `Allow ${details.toolName}?`, message: details.reason, approval: details },
					signal ? { signal } : {},
				),
		};
	}

	get session(): AgentSession {
		return this.runtime.session;
	}

	get id(): string {
		return this.runtime.session.sessionId;
	}

	get workspaceId(): string {
		return this.options.workspace().id;
	}

	get epoch(): string {
		return this.log.epoch;
	}

	get currentSeq(): number {
		return this.log.currentSeq;
	}

	get state(): SessionRunState {
		return this.runState;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	/** Whether the session must stay loaded (running work or waiting for a UI answer). */
	get busy(): boolean {
		return this.runState !== "idle" || this.bridge.pendingRequests.length > 0;
	}

	/** (Re)bind extensions and event subscriptions to the runtime's current AgentSession. */
	private async bind(): Promise<void> {
		const session = this.runtime.session;
		const previousId = this.boundSessionId;
		const replaced = previousId !== undefined && previousId !== session.sessionId;
		this.unsubscribePi?.();

		if (replaced) {
			this.bridge.cancelAll();
			this.allowances.clear();
			this.emit({ type: "session.replaced", previousSessionId: previousId, session: this.summary() }, previousId);
			this.lock?.release();
			this.lock = undefined;
			const file = session.sessionFile;
			if (file) this.lock = SessionLock.acquire(this.options.locksDir, file);
			this.log = new EventLog(this.options.eventLogCapacity ?? DEFAULT_EVENT_LOG_CAPACITY);
		}
		this.boundSessionId = session.sessionId;
		this.guard.setPath(session.sessionFile);

		await session.bindExtensions({
			uiContext: createUiContext(this.bridge),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (opts) => this.runtime.newSession(opts),
				fork: async (entryId, opts) => ({ cancelled: (await this.runtime.fork(entryId, opts)).cancelled }),
				navigateTree: async (targetId, opts) => ({
					cancelled: (await session.navigateTree(targetId, opts ?? {})).cancelled,
				}),
				switchSession: (path, opts) => this.runtime.switchSession(path, opts),
				reload: () => session.reload(),
			},
			shutdownHandler: () => {
				this.bridge.notify("An extension requested shutdown; Pier keeps the host running.", "warning");
			},
			onError: (error) => {
				this.emit({
					type: "extension.error",
					extensionPath: error.extensionPath,
					event: error.event,
					error: error.error,
				});
			},
		});
		this.unsubscribePi = session.subscribe((event) => this.handlePiEvent(event));
		this.updateRunState();

		if (replaced && previousId !== undefined) {
			this.options.onReplaced?.(this, previousId);
			const snapshot = this.snapshot();
			for (const entry of this.subscribers.values()) {
				this.deliver(entry, { type: "evt", sessionId: this.id, event: { type: "session.snapshot", snapshot } });
			}
		}
	}

	private handlePiEvent(event: AgentSessionEvent): void {
		this.lastActivity = Date.now();
		const wire = toWireEvent(event);
		if (wire) this.emit(wire);
		if (WRITE_EVENTS.has(event.type)) this.guard.record();
		this.updateRunState();
	}

	private computeRunState(): SessionRunState {
		const session = this.runtime.session;
		if (session.isCompacting) return "compacting";
		if (session.isRetrying) return "retrying";
		if (!session.isIdle) return "streaming";
		return "idle";
	}

	private updateRunState(): void {
		const next = this.computeRunState();
		if (next === this.runState) return;
		this.runState = next;
		this.emit({ type: "session.status", state: next });
		this.options.onActivity?.(this);
	}

	/** Append an event to the log and fan it out to subscribers. */
	private emit(event: WireEvent | PierSessionEvent, sessionId: string = this.id): void {
		if (this.disposed) return;
		const entry = this.log.append(event as WireEvent);
		const frame: EventFrame = { type: "evt", sessionId, seq: entry.seq, event: entry.event };
		for (const subscriber of this.subscribers.values()) this.deliver(subscriber, frame);
	}

	private deliver(entry: SubscriberEntry, frame: EventFrame): void {
		if (entry.ready) entry.subscriber.send(frame);
		else entry.buffer.push(frame);
	}

	subscribe(subscriber: SessionSubscriber, sinceSeq?: number, epoch?: string): PendingSubscription {
		this.lastActivity = Date.now();
		const entry: SubscriberEntry = { subscriber, ready: false, buffer: [] };
		this.subscribers.set(subscriber.connectionId, entry);
		const replay = sinceSeq !== undefined && epoch === this.log.epoch ? this.log.since(sinceSeq) : undefined;
		const replayEpoch = this.log.epoch;
		const result: SubscribeResult = {
			mode: replay ? "replay" : "snapshot",
			currentSeq: this.log.currentSeq,
			epoch: this.log.epoch,
		};
		const start = () => {
			if (this.subscribers.get(subscriber.connectionId) !== entry || entry.ready) return;
			let buffered = entry.buffer;
			if (replay && replayEpoch === this.log.epoch) {
				for (const logged of replay) {
					subscriber.send({ type: "evt", sessionId: this.id, seq: logged.seq, event: logged.event });
				}
			} else {
				// The snapshot already reflects every logged event up to its seq.
				const snapshot = this.snapshot();
				subscriber.send({ type: "evt", sessionId: this.id, event: { type: "session.snapshot", snapshot } });
				buffered = buffered.filter((f) => f.seq === undefined || f.seq > snapshot.seq || f.sessionId !== this.id);
			}
			entry.ready = true;
			entry.buffer = [];
			for (const frame of buffered) subscriber.send(frame);
		};
		return { result, start };
	}

	unsubscribe(connectionId: string): boolean {
		this.lastActivity = Date.now();
		return this.subscribers.delete(connectionId);
	}

	summary(): SessionSummary {
		const session = this.runtime.session;
		const manager = session.sessionManager;
		const header = manager.getHeader();
		const messages = session.messages.filter((m) => m.role === "user" || m.role === "assistant");
		const firstUser = session.messages.find((m) => m.role === "user") as { content?: unknown } | undefined;
		const now = new Date().toISOString();
		return {
			id: session.sessionId,
			workspaceId: this.workspaceId,
			...(session.sessionFile ? { path: session.sessionFile } : {}),
			...(session.sessionName ? { name: session.sessionName } : {}),
			cwd: manager.getCwd(),
			createdAt: header?.timestamp ?? now,
			modifiedAt: new Date(this.lastActivity).toISOString(),
			messageCount: messages.length,
			firstMessage: firstUser ? textOf(firstUser.content).slice(0, 200) : "",
			...(header?.parentSession ? { parentSessionPath: header.parentSession } : {}),
			active: true,
			state: this.runState,
			pendingUi: this.bridge.pendingRequests.length,
		};
	}

	snapshot(): SessionSnapshot {
		const session = this.runtime.session;
		const state = session.state;
		const model = session.model;
		return {
			session: this.summary(),
			seq: this.log.currentSeq,
			epoch: this.log.epoch,
			messages: [...session.messages],
			...(state.streamingMessage ? { streamingMessage: state.streamingMessage } : {}),
			pendingToolCalls: [...state.pendingToolCalls],
			pendingUi: this.bridge.pendingRequests,
			queue: this.queue(),
			...(model ? { model: toModelInfo(model) } : {}),
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			statuses: Object.fromEntries(this.bridge.statuses),
			widgets: Object.fromEntries(this.bridge.widgets),
			...(this.bridge.title ? { title: this.bridge.title } : {}),
			...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
		};
	}

	queue(): QueueState {
		const session = this.runtime.session;
		return { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] };
	}

	private assertWritable(): void {
		if (this.runtime.session.isIdle && this.guard.changedExternally()) {
			throw new PierProtocolError(
				"CONFLICT",
				"The session file was modified outside Pier (for example by the pi CLI). Close and reopen the session to continue.",
			);
		}
	}

	/** Start a prompt. Resolves once pi accepted it (the run continues in the background). */
	prompt(text: string, images?: ImageInput[], streamingBehavior?: StreamingBehavior): Promise<void> {
		this.assertWritable();
		this.lastActivity = Date.now();
		const session = this.runtime.session;
		if (!session.isIdle && !streamingBehavior) {
			return Promise.reject(
				new PierProtocolError("CONFLICT", "Session is busy; pass streamingBehavior `steer` or `followUp`"),
			);
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			// Extension commands may wait for UI answers from any client, so accept them right away
			// instead of holding the request until the handler returns.
			if (this.isExtensionCommand(text)) {
				settled = true;
				resolve();
			}
			session
				.prompt(text, {
					...(images ? { images: toImages(images) } : {}),
					...(streamingBehavior ? { streamingBehavior } : {}),
					source: "rpc",
					preflightResult: (ok) => {
						if (ok && !settled) {
							settled = true;
							resolve();
						}
					},
				})
				.then(() => {
					// Extension commands and queued prompts may finish without a preflight callback.
					if (!settled) {
						settled = true;
						resolve();
					}
				})
				.catch((error: unknown) => {
					if (!settled) {
						settled = true;
						reject(new PierProtocolError("CONFLICT", errorMessage(error)));
					} else {
						this.emit({ type: "ui.notify", level: "error", message: `Prompt failed: ${errorMessage(error)}` });
					}
				});
		});
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(1) : text.slice(1, space);
		return name.length > 0 && this.runtime.session.extensionRunner.getCommand(name) !== undefined;
	}

	async steer(text: string, images?: ImageInput[]): Promise<QueueState> {
		this.lastActivity = Date.now();
		await this.runtime.session.steer(text, toImages(images), { source: "rpc" });
		return this.queue();
	}

	async followUp(text: string, images?: ImageInput[]): Promise<QueueState> {
		this.lastActivity = Date.now();
		await this.runtime.session.followUp(text, toImages(images), { source: "rpc" });
		return this.queue();
	}

	async abort(): Promise<void> {
		this.lastActivity = Date.now();
		await this.runtime.session.abort();
	}

	async compact(instructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		this.assertWritable();
		this.lastActivity = Date.now();
		const result = await this.runtime.session.compact(instructions);
		this.guard.record();
		return { summary: result.summary, tokensBefore: result.tokensBefore };
	}

	rename(name: string): SessionSummary {
		this.assertWritable();
		this.runtime.session.setSessionName(name);
		this.guard.record();
		return this.summary();
	}

	async setModel(provider: string, modelId: string, persist: boolean): Promise<ModelInfo> {
		const model = this.options.env.modelRuntime.getModel(provider, modelId);
		if (!model) throw new PierProtocolError("NOT_FOUND", `Unknown model ${provider}/${modelId}`);
		this.assertWritable();
		await this.runtime.session.setModel(model, { persist });
		this.guard.record();
		const info = toModelInfo(model);
		this.emit({ type: "session.model", model: info, thinkingLevel: this.runtime.session.thinkingLevel });
		return info;
	}

	setThinking(level: ThinkingLevel, persist: boolean): string {
		this.assertWritable();
		this.runtime.session.setThinkingLevel(level, { persist });
		this.guard.record();
		return this.runtime.session.thinkingLevel;
	}

	/** Slash commands pi handles in `prompt()`: extension commands, prompt templates, and skills. */
	commands(): SessionCommandInfo[] {
		const session = this.runtime.session;
		const commands: SessionCommandInfo[] = [];
		for (const command of session.extensionRunner.getRegisteredCommands()) {
			commands.push({
				name: command.invocationName,
				...(command.description ? { description: command.description } : {}),
				source: "extension",
			});
		}
		for (const template of session.promptTemplates) {
			commands.push({
				name: template.name,
				...(template.description ? { description: template.description } : {}),
				...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
				source: "prompt",
			});
		}
		// Like pi's interactive mode, `enableSkillCommands: false` hides skills from discovery;
		// a typed `/skill:name` still works.
		if (session.settingsManager.getEnableSkillCommands()) {
			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					...(skill.description ? { description: skill.description } : {}),
					source: "skill",
				});
			}
		}
		return commands;
	}

	/** Reload settings, extensions, skills, prompt templates, themes, and context files. */
	async reload(): Promise<void> {
		this.lastActivity = Date.now();
		if (this.busy) throw new PierProtocolError("CONFLICT", "Wait for the agent to finish before reloading");
		await this.runtime.session.reload();
	}

	forkPoints(): Array<{ entryId: string; text: string }> {
		return this.runtime.session.getUserMessagesForForking();
	}

	respondUi(requestId: string, response: UiResponse, by: string): boolean {
		this.lastActivity = Date.now();
		return this.bridge.respond(requestId, response, by);
	}

	async dispose(reason: "idle" | "closed" | "host_shutdown"): Promise<void> {
		if (this.disposed) return;
		this.bridge.cancelAll();
		this.emit({ type: "session.closed", reason });
		this.disposed = true;
		this.subscribers.clear();
		this.unsubscribePi?.();
		try {
			await this.runtime.dispose();
		} finally {
			this.lock?.release();
		}
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && part.type === "text" ? String(part.text ?? "") : ""))
			.join(" ");
	}
	return "";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
