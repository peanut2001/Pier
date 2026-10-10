import { randomUUID } from "node:crypto";
import {
	type AgentRuntimeCapabilities,
	type ImageInput,
	type ModelInfo,
	PierProtocolError,
	type QueueState,
	type SessionSummary,
	type StreamingBehavior,
	type ThinkingLevel,
	type WireEvent,
} from "@pier/protocol";
import {
	errorMessage,
	ManagedSession,
	type ManagedSessionOptions,
	type SessionContent,
	type SessionDescription,
} from "../managed-session.ts";
import {
	firstPromptOf,
	type ImagePart,
	LiveTranscript,
	type TextPart,
	type TranscriptMessage,
	type UserMessage,
	usageFrom,
	userContentText,
} from "../runtimes/live-transcript.ts";
import type { CodexAppServer } from "./app-server.ts";
import {
	CODEX_PROVIDER,
	codexPolicy,
	effortToLevel,
	levelToEffort,
	reasoningText,
	toolCallFor,
	toolResultFor,
} from "./convert.ts";

export const CODEX_CAPABILITIES: AgentRuntimeCapabilities = {
	steer: true,
	followUp: true,
	compact: true,
	fork: true,
	rename: true,
	setModel: true,
	thinking: true,
	reload: false,
	images: true,
	piExtensions: false,
};

type Json = Record<string, unknown>;

/** What a Codex session needs from its runtime. */
export interface CodexSessionHost {
	server(): CodexAppServer;
	model(id: string): ModelInfo | undefined;
	defaultModel(): ModelInfo | undefined;
	/** Route the app server's requests for this thread to the session; returns the unregister function. */
	register(session: CodexSession): () => void;
	log(message: string): void;
}

export interface CodexThreadStart {
	thread: Json;
	/** Model and effort the app server reported for the thread. */
	model?: string;
	effort?: string | null;
	messages?: TranscriptMessage[];
}

interface QueuedPrompt {
	clientId: string;
	text: string;
	images?: ImageInput[];
	content: UserMessage["content"];
	steer: boolean;
}

function toInput(text: string, images: ImageInput[] | undefined): Json[] {
	return [
		{ type: "text", text, text_elements: [] },
		...(images ?? []).map((image) => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
	];
}

function userContent(text: string, images: ImageInput[] | undefined): UserMessage["content"] {
	if (!images?.length) return text;
	const parts: Array<TextPart | ImagePart> = [{ type: "text", text }];
	for (const image of images) parts.push({ type: "image", data: image.data, mimeType: image.mimeType });
	return parts;
}

/** A Codex thread driven through `codex app-server`. */
export class CodexSession extends ManagedSession {
	readonly runtimeId = "codex";
	readonly capabilities = CODEX_CAPABILITIES;
	private readonly threadId: string;
	private readonly transcript: LiveTranscript;
	private path: string | undefined;
	private name: string | undefined;
	private readonly createdAt: string;
	private readonly forkedFrom: string | undefined;
	private modelId: string | undefined;
	private thinkingLevel: ThinkingLevel;
	private turnId: string | undefined;
	/** Content index of streamed text and reasoning items. */
	private readonly itemIndex = new Map<string, number>();
	private readonly commandOutput = new Map<string, string>();
	/** Latest item of each tool call, for approvals that only carry the item id. */
	private readonly toolItems = new Map<string, Json>();
	private queued: QueuedPrompt[] = [];
	private readonly ownClientIds = new Set<string>();
	private pendingError: string | undefined;
	private retrying = false;
	private compacting = false;
	private compactWaiters: Array<() => void> = [];
	private lastUsage: Json | undefined;
	private offNotifications: (() => void) | undefined;
	private offExit: (() => void) | undefined;
	private unregister: (() => void) | undefined;

	private constructor(
		options: ManagedSessionOptions,
		private readonly host: CodexSessionHost,
		start: CodexThreadStart,
	) {
		super(options);
		const thread = start.thread;
		this.threadId = String(thread.id);
		this.path = typeof thread.path === "string" ? thread.path : undefined;
		this.name = typeof thread.name === "string" && thread.name ? thread.name : undefined;
		this.createdAt = new Date(
			typeof thread.createdAt === "number" ? thread.createdAt * 1000 : Date.now(),
		).toISOString();
		this.forkedFrom = typeof thread.forkedFromId === "string" ? thread.forkedFromId : undefined;
		this.modelId = start.model ?? (typeof thread.model === "string" ? thread.model : undefined);
		this.thinkingLevel =
			effortToLevel(start.effort ?? thread.reasoningEffort) ??
			(this.currentModel()?.thinkingLevels?.includes("medium") ? "medium" : "off");
		this.transcript = new LiveTranscript(
			(event) => this.emit(event),
			() => ({ provider: CODEX_PROVIDER, api: "openai-responses", ...(this.modelId ? { model: this.modelId } : {}) }),
		);
		if (start.messages) this.transcript.load(start.messages);
	}

	static start(options: ManagedSessionOptions, host: CodexSessionHost, start: CodexThreadStart): CodexSession {
		const session = new CodexSession(options, host, start);
		session.acquireLock(session.path ?? `codex-thread:${session.threadId}`);
		session.unregister = host.register(session);
		const server = host.server();
		session.offNotifications = server.onNotification((method, params) => {
			if (params.threadId === session.threadId) session.onNotification(method, params);
		});
		session.offExit = server.onExit((reason) => {
			if (session.transcript.isRunning) session.finishTurn(reason);
		});
		return session;
	}

	get id(): string {
		return this.threadId;
	}

	get sessionFile(): string | undefined {
		return this.path;
	}

	private get running(): boolean {
		return this.transcript.isRunning;
	}

	private currentModel(): ModelInfo | undefined {
		return this.modelId ? this.host.model(this.modelId) : this.host.defaultModel();
	}

	// ---------------------------------------------------------------- app-server events

	/** Answer an approval or question the app server asked for this thread. */
	async handleServerRequest(method: string, params: Json): Promise<unknown> {
		this.lastActivity = Date.now();
		switch (method) {
			case "item/commandExecution/requestApproval": {
				const itemId = String(params.itemId ?? "");
				const item = this.toolItems.get(itemId);
				const command = String(params.command ?? item?.command ?? "");
				const result = await this.approveToolCall({
					toolName: "bash",
					toolCallId: itemId,
					input: { command, ...(params.cwd ? { cwd: params.cwd } : {}) },
					runtimeAsked: {
						reason: String(params.reason ?? "Codex asks to run this command outside its sandbox"),
						summary: command,
					},
				});
				return { decision: result.allowed ? (result.scope === "session" ? "acceptForSession" : "accept") : "decline" };
			}
			case "item/fileChange/requestApproval": {
				const itemId = String(params.itemId ?? "");
				const item = this.toolItems.get(itemId);
				const call = item ? toolCallFor(item) : undefined;
				const path = String(call?.arguments.path ?? params.grantRoot ?? "");
				const result = await this.approveToolCall({
					toolName: call?.name ?? "edit",
					toolCallId: itemId,
					input: { path, ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}) },
					runtimeAsked: { reason: String(params.reason ?? "Codex asks to change files"), summary: path },
				});
				return { decision: result.allowed ? (result.scope === "session" ? "acceptForSession" : "accept") : "decline" };
			}
			case "item/permissions/requestApproval": {
				const permissions = (params.permissions ?? {}) as Json;
				const result = await this.approveToolCall({
					toolName: "permissions",
					toolCallId: String(params.itemId ?? randomUUID()),
					input: permissions,
					runtimeAsked: {
						reason: String(params.reason ?? "Codex asks for more permissions"),
						summary: JSON.stringify(permissions).slice(0, 200),
						severity: "high",
					},
				});
				if (!result.allowed) return { permissions: {}, scope: "turn" };
				const granted: Json = {};
				if (permissions.network) granted.network = permissions.network;
				if (permissions.fileSystem) granted.fileSystem = permissions.fileSystem;
				return { permissions: granted, scope: result.scope === "session" ? "session" : "turn" };
			}
			case "item/tool/requestUserInput": {
				const questions = Array.isArray(params.questions) ? (params.questions as Json[]) : [];
				const answers: Record<string, { answers: string[] }> = {};
				for (const question of questions) {
					const options = Array.isArray(question.options)
						? (question.options as Json[]).map((o) => String(o.label ?? "")).filter(Boolean)
						: [];
					const title = String(question.header ?? question.question ?? "Codex");
					const message = String(question.question ?? "");
					const response = options.length
						? await this.bridge.request({ kind: "select", title, message, options })
						: await this.bridge.request({ kind: "input", title, message });
					answers[String(question.id)] = { answers: response?.value !== undefined ? [response.value] : [] };
				}
				return { answers };
			}
			case "mcpServer/elicitation/request":
				return { action: "decline", content: null, _meta: null };
			default:
				throw new Error(`Pier does not support ${method}`);
		}
	}

	private onNotification(method: string, params: Json): void {
		this.lastActivity = Date.now();
		const t = this.transcript;
		switch (method) {
			case "turn/started": {
				const turn = (params.turn ?? {}) as Json;
				this.turnId = String(turn.id ?? "");
				this.ensureRunning();
				return;
			}
			case "item/started": {
				const item = (params.item ?? {}) as Json;
				this.onItemStarted(item);
				return;
			}
			case "item/agentMessage/delta": {
				this.ensureRunning();
				const itemId = String(params.itemId ?? "");
				let index = this.itemIndex.get(itemId);
				if (index === undefined) {
					index = t.textStart();
					this.itemIndex.set(itemId, index);
				}
				t.textDelta(index, String(params.delta ?? ""));
				return;
			}
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta": {
				this.ensureRunning();
				const itemId = String(params.itemId ?? "");
				let index = this.itemIndex.get(itemId);
				if (index === undefined) {
					index = t.thinkingStart();
					this.itemIndex.set(itemId, index);
				}
				t.thinkingDelta(index, String(params.delta ?? ""));
				return;
			}
			case "item/reasoning/summaryPartAdded": {
				const index = this.itemIndex.get(String(params.itemId ?? ""));
				if (index !== undefined && Number(params.summaryIndex ?? 0) > 0) t.thinkingDelta(index, "\n\n");
				return;
			}
			case "item/commandExecution/outputDelta": {
				const itemId = String(params.itemId ?? "");
				const output = (this.commandOutput.get(itemId) ?? "") + String(params.delta ?? "");
				this.commandOutput.set(itemId, output);
				t.toolUpdate(itemId, output);
				return;
			}
			case "item/completed": {
				const item = (params.item ?? {}) as Json;
				this.onItemCompleted(item);
				return;
			}
			case "turn/completed": {
				const turn = (params.turn ?? {}) as Json;
				const error = (turn.error as Json | null | undefined)?.message;
				const failure = turn.status === "failed" ? String(error ?? this.pendingError ?? "The turn failed") : undefined;
				this.finishTurn(failure);
				return;
			}
			case "thread/tokenUsage/updated": {
				const usage = (params.tokenUsage ?? {}) as Json;
				this.lastUsage = (usage.last ?? usage.total) as Json | undefined;
				return;
			}
			case "thread/name/updated": {
				const name = typeof params.threadName === "string" ? params.threadName : undefined;
				if (name && name !== this.name) {
					this.name = name;
					this.emit({ type: "session_info_changed", name });
				}
				return;
			}
			case "thread/compacted":
				this.endCompaction();
				return;
			case "error": {
				const error = (params.error ?? {}) as Json;
				const message = String(error.message ?? "Codex reported an error");
				if (params.willRetry === true) {
					this.retrying = true;
					this.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 0, delayMs: 0, errorMessage: message });
					this.setRunState("retrying");
				} else {
					this.pendingError = message;
				}
				return;
			}
			default:
				return;
		}
	}

	private ensureRunning(): void {
		if (this.retrying) {
			this.retrying = false;
			this.emit({ type: "auto_retry_end", success: true });
		}
		if (!this.running) this.transcript.startRun();
		if (!this.compacting) this.setRunState("streaming");
	}

	private onItemStarted(item: Json): void {
		const t = this.transcript;
		const id = String(item.id ?? "");
		switch (item.type) {
			case "userMessage": {
				const clientId = typeof item.clientId === "string" ? item.clientId : undefined;
				if (clientId && this.ownClientIds.has(clientId)) {
					this.ownClientIds.delete(clientId);
					const queued = this.queued.findIndex((q) => q.clientId === clientId);
					if (queued !== -1) {
						const [prompt] = this.queued.splice(queued, 1);
						this.ensureRunning();
						t.endAssistant();
						// Steering joins the running turn, so it is not a fork point of its own.
						if (prompt) t.addUser(prompt.content);
						this.emitQueue();
					}
				}
				return;
			}
			case "agentMessage":
				this.ensureRunning();
				if (!this.itemIndex.has(id)) this.itemIndex.set(id, t.textStart());
				return;
			case "reasoning":
				this.ensureRunning();
				if (!this.itemIndex.has(id)) this.itemIndex.set(id, t.thinkingStart());
				return;
			case "contextCompaction":
				if (!this.compacting) {
					this.compacting = true;
					this.emit({ type: "compaction_start", reason: "threshold" });
					this.setRunState("compacting");
				}
				return;
			default: {
				const call = toolCallFor(item);
				if (!call) return;
				this.ensureRunning();
				this.toolItems.set(id, item);
				t.toolCall(call);
				t.endAssistant();
				return;
			}
		}
	}

	private onItemCompleted(item: Json): void {
		const t = this.transcript;
		const id = String(item.id ?? "");
		switch (item.type) {
			case "agentMessage": {
				let index = this.itemIndex.get(id);
				if (index === undefined) {
					this.ensureRunning();
					index = t.textStart();
				}
				t.textEnd(index, String(item.text ?? ""));
				this.itemIndex.delete(id);
				return;
			}
			case "reasoning": {
				const text = reasoningText(item);
				let index = this.itemIndex.get(id);
				if (index === undefined) {
					if (!text) return;
					this.ensureRunning();
					index = t.thinkingStart();
				}
				t.thinkingEnd(index, text || undefined);
				this.itemIndex.delete(id);
				return;
			}
			case "contextCompaction":
				this.endCompaction();
				return;
			case "userMessage":
				return;
			default: {
				const call = toolCallFor(item);
				if (!call) return;
				if (!this.toolItems.has(id)) {
					// Completed without a start event (e.g. replayed); show the call first.
					this.ensureRunning();
					t.toolCall(call);
					t.endAssistant();
				}
				this.toolItems.delete(id);
				const output = this.commandOutput.get(id);
				this.commandOutput.delete(id);
				t.toolResult(id, toolResultFor(item, output), call.name);
			}
		}
	}

	private finishTurn(failure?: string): void {
		const t = this.transcript;
		const usage = this.lastUsage;
		if (usage && t.streaming) {
			const input = Number(usage.inputTokens ?? 0);
			const cached = Number(usage.cachedInputTokens ?? 0);
			t.setUsage(
				usageFrom({
					input: Math.max(0, input - cached),
					output: Number(usage.outputTokens ?? 0),
					cacheRead: cached,
				}),
			);
		}
		this.lastUsage = undefined;
		this.pendingError = undefined;
		if (this.retrying) {
			this.retrying = false;
			this.emit({ type: "auto_retry_end", success: failure === undefined });
		}
		this.endCompaction(failure);
		this.itemIndex.clear();
		this.commandOutput.clear();
		this.toolItems.clear();
		this.turnId = undefined;
		// Steering that the finished turn did not take becomes a follow-up.
		for (const q of this.queued) q.steer = false;
		t.endRun(failure);
		this.setRunState("idle");
		const next = this.queued.shift();
		if (next) {
			this.emitQueue();
			void this.startTurn(next.text, next.images, next.content).catch((error: unknown) => {
				this.emit({ type: "ui.notify", level: "error", message: `Follow-up failed: ${errorMessage(error)}` });
			});
		}
	}

	private endCompaction(failure?: string): void {
		if (!this.compacting) return;
		this.compacting = false;
		this.emit({
			type: "compaction_end",
			reason: "manual",
			...(failure ? {} : { result: { summary: "", tokensBefore: 0 } }),
			aborted: false,
			willRetry: false,
			...(failure ? { errorMessage: failure } : {}),
		} as WireEvent);
		if (this.running) this.setRunState("streaming");
		const waiters = this.compactWaiters;
		this.compactWaiters = [];
		for (const resolve of waiters) resolve();
	}

	// ---------------------------------------------------------------- ManagedSession

	protected describe(): SessionDescription {
		const messages = this.transcript.messages.filter((m) => m.role === "user" || m.role === "assistant");
		return {
			...(this.path ? { path: this.path } : {}),
			...(this.name ? { name: this.name } : {}),
			cwd: this.workspacePath,
			createdAt: this.createdAt,
			messageCount: messages.length,
			firstMessage: firstPromptOf(this.transcript.messages),
			...(this.forkedFrom ? { parentSessionPath: this.forkedFrom } : {}),
		};
	}

	protected content(): SessionContent {
		const t = this.transcript;
		const model = this.currentModel();
		return {
			messages: t.publicMessages(),
			...(t.streaming ? { streamingMessage: structuredClone(t.streaming) } : {}),
			pendingToolCalls: t.pendingToolCalls,
			...(model
				? { model }
				: this.modelId
					? {
							model: {
								provider: CODEX_PROVIDER,
								id: this.modelId,
								name: this.modelId,
								reasoning: true,
								input: ["text", "image"],
							},
						}
					: {}),
			thinkingLevel: this.thinkingLevel,
			...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
		};
	}

	queue(): QueueState {
		return {
			steering: this.queued.filter((q) => q.steer).map((q) => q.text),
			followUp: this.queued.filter((q) => !q.steer).map((q) => q.text),
		};
	}

	private emitQueue(): void {
		const queue = this.queue();
		this.emit({ type: "queue_update", steering: queue.steering, followUp: queue.followUp });
	}

	private async startTurn(text: string, images: ImageInput[] | undefined, content: UserMessage["content"]) {
		const policy = codexPolicy(this.options.workspace().policy);
		const clientId = randomUUID();
		this.ownClientIds.add(clientId);
		this.transcript.startRun();
		this.setRunState("streaming");
		const user = this.transcript.addUser(content);
		try {
			const response = await this.host.server().request<{ turn?: Json }>("turn/start", {
				threadId: this.threadId,
				clientUserMessageId: clientId,
				input: toInput(text, images),
				cwd: this.workspacePath,
				approvalPolicy: policy.approvalPolicy,
				sandboxPolicy: policy.sandboxPolicy,
				...(this.modelId ? { model: this.modelId } : {}),
				effort: levelToEffort(this.thinkingLevel),
			});
			const turnId = typeof response.turn?.id === "string" ? response.turn.id : undefined;
			if (turnId) {
				this.turnId ??= turnId;
				user.entryId = turnId;
			}
		} catch (error) {
			this.ownClientIds.delete(clientId);
			this.finishTurn(errorMessage(error));
			throw new PierProtocolError("CONFLICT", errorMessage(error));
		}
	}

	async prompt(text: string, images?: ImageInput[], streamingBehavior?: StreamingBehavior): Promise<void> {
		this.lastActivity = Date.now();
		if (this.running) {
			if (!streamingBehavior) {
				throw new PierProtocolError("CONFLICT", "Session is busy; pass streamingBehavior `steer` or `followUp`");
			}
			await (streamingBehavior === "steer" ? this.steer(text, images) : this.followUp(text, images));
			return;
		}
		await this.startTurn(text, images, userContent(text, images));
	}

	async steer(text: string, images?: ImageInput[]): Promise<QueueState> {
		this.lastActivity = Date.now();
		if (!this.running) {
			await this.prompt(text, images);
			return this.queue();
		}
		if (!this.turnId) return this.followUp(text, images);
		const clientId = randomUUID();
		this.ownClientIds.add(clientId);
		this.queued.push({
			clientId,
			text,
			...(images ? { images } : {}),
			content: userContent(text, images),
			steer: true,
		});
		this.emitQueue();
		try {
			await this.host.server().request("turn/steer", {
				threadId: this.threadId,
				clientUserMessageId: clientId,
				input: toInput(text, images),
				expectedTurnId: this.turnId,
			});
		} catch (error) {
			// The turn ended meanwhile: keep the message as a follow-up.
			const queued = this.queued.find((q) => q.clientId === clientId);
			if (queued) queued.steer = false;
			this.ownClientIds.delete(clientId);
			this.host.log(`steering Codex failed: ${errorMessage(error)}`);
			this.emitQueue();
			if (!this.running) this.finishIdleQueue();
		}
		return this.queue();
	}

	private finishIdleQueue(): void {
		const next = this.queued.shift();
		if (!next) return;
		this.emitQueue();
		void this.startTurn(next.text, next.images, next.content).catch(() => {});
	}

	async followUp(text: string, images?: ImageInput[]): Promise<QueueState> {
		this.lastActivity = Date.now();
		if (!this.running) {
			await this.prompt(text, images);
			return this.queue();
		}
		this.queued.push({
			clientId: randomUUID(),
			text,
			...(images ? { images } : {}),
			content: userContent(text, images),
			steer: false,
		});
		this.emitQueue();
		return this.queue();
	}

	async abort(): Promise<void> {
		this.lastActivity = Date.now();
		if (!this.running) return;
		this.queued = [];
		this.emitQueue();
		this.bridge.cancelAll();
		if (!this.turnId) return;
		try {
			await this.host.server().request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
		} catch (error) {
			this.host.log(`interrupting Codex failed: ${errorMessage(error)}`);
			this.finishTurn();
		}
	}

	override async compact(_instructions?: string): Promise<{ summary: string; tokensBefore: number }> {
		if (this.running) throw new PierProtocolError("CONFLICT", "Wait for the agent to finish before compacting");
		const done = new Promise<void>((resolve) => this.compactWaiters.push(resolve));
		this.compacting = true;
		this.emit({ type: "compaction_start", reason: "manual" });
		this.setRunState("compacting");
		try {
			await this.host.server().request("thread/compact/start", { threadId: this.threadId });
		} catch (error) {
			this.endCompaction(errorMessage(error));
			if (!this.running) this.setRunState("idle");
			throw new PierProtocolError("CONFLICT", errorMessage(error));
		}
		await done;
		if (!this.running) this.setRunState("idle");
		return { summary: "", tokensBefore: 0 };
	}

	async rename(name: string): Promise<SessionSummary> {
		await this.host.server().request("thread/name/set", { threadId: this.threadId, name });
		this.name = name;
		this.emit({ type: "session_info_changed", name });
		return this.summary();
	}

	async setModel(provider: string, modelId: string, _persist: boolean): Promise<ModelInfo> {
		if (provider !== CODEX_PROVIDER)
			throw new PierProtocolError("BAD_REQUEST", "Codex sessions can only use Codex models");
		const info = this.host.model(modelId);
		if (!info) throw new PierProtocolError("NOT_FOUND", `Unknown model ${provider}/${modelId}`);
		this.modelId = modelId;
		const levels = info.thinkingLevels ?? ["off"];
		if (!levels.includes(this.thinkingLevel)) {
			this.thinkingLevel = levels.includes("medium") ? "medium" : (levels.at(-1) ?? "off");
		}
		this.emit({ type: "session.model", model: info, thinkingLevel: this.thinkingLevel });
		return info;
	}

	setThinking(level: ThinkingLevel, _persist: boolean): string {
		const levels = this.currentModel()?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh"];
		let next = level;
		if (!levels.includes(next)) {
			const order: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
			const wanted = order.indexOf(level);
			next = levels.reduce((best, l) =>
				Math.abs(order.indexOf(l) - wanted) < Math.abs(order.indexOf(best) - wanted) ? l : best,
			);
		}
		this.thinkingLevel = next;
		this.emit({ type: "thinking_level_changed", level: next });
		return next;
	}

	override forkPoints(): Array<{ entryId: string; text: string }> {
		return this.transcript.messages
			.filter((m): m is UserMessage => m.role === "user" && typeof m.entryId === "string" && m.entryId !== "")
			.map((m) => ({ entryId: m.entryId as string, text: userContentText(m.content) }));
	}

	/** Turn ids in order, for forking. */
	turnIds(): string[] {
		return this.forkPoints().map((p) => p.entryId);
	}

	protected async disposeRuntime(): Promise<void> {
		this.offNotifications?.();
		this.offExit?.();
		this.unregister?.();
		const waiters = this.compactWaiters;
		this.compactWaiters = [];
		for (const resolve of waiters) resolve();
		const server = this.host.server();
		if (this.running && this.turnId) {
			await server.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined);
		}
		if (server.running) {
			await server.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => undefined);
		}
	}
}
