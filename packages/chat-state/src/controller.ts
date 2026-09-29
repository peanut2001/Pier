import type { PierClient, Subscription } from "@pier/client";
import type { EventFrame, ImageInput, SessionSummary, ThinkingLevel, UiResponse } from "@pier/protocol";
import { applySnapshot, type ChatState, clearResync, dismissNotice, initialChatState, reduceChat } from "./reducer.ts";
import { BUILTIN_COMMANDS, mergeCommands, type SlashCommand } from "./slash.ts";

/** Slash commands of a session, and whether the host could list its own (older hosts cannot). */
export interface CommandList {
	commands: SlashCommand[];
	known: boolean;
}

export interface ChatView {
	chat: ChatState;
	/** Failure to open or subscribe to the session. */
	error?: string;
}

export interface ChatHooks {
	onReplaced(previousId: string, session: SessionSummary): void;
	onSettled(controller: ChatController): void;
	onChange(controller: ChatController): void;
	onError(message: string): void;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One subscribed session: its reduced state plus the actions the UI can take on it. */
export class ChatController {
	private view: ChatView;
	private readonly listeners = new Set<() => void>();
	private sub: Subscription | undefined;
	private disposed = false;
	private commandList: CommandList = { commands: [...BUILTIN_COMMANDS], known: false };
	private commandsLoading: Promise<CommandList> | undefined;
	readonly workspaceId: string;

	constructor(
		private readonly client: PierClient,
		session: SessionSummary,
		private readonly hooks: ChatHooks,
	) {
		this.workspaceId = session.workspaceId;
		this.view = { chat: initialChatState(session.id, session) };
	}

	get sessionId(): string {
		return this.view.chat.sessionId;
	}

	get chat(): ChatState {
		return this.view.chat;
	}

	getView = (): ChatView => this.view;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private update(view: ChatView): void {
		if (this.disposed) return;
		this.view = view;
		for (const listener of [...this.listeners]) listener();
		this.hooks.onChange(this);
	}

	async start(): Promise<void> {
		try {
			// Load the session into the host's active pool (no-op when it is already there).
			await this.client.request("session.open", { workspaceId: this.workspaceId, sessionId: this.sessionId });
			const sub = await this.client.subscribe(this.sessionId, (frame) => this.onFrame(frame), {
				workspaceId: this.workspaceId,
			});
			if (this.disposed) await sub.unsubscribe();
			else this.sub = sub;
		} catch (error) {
			this.update({ ...this.view, error: message(error) });
		}
	}

	private onFrame(frame: EventFrame): void {
		const previousId = this.view.chat.sessionId;
		let chat = reduceChat(this.view.chat, frame);
		if (chat === this.view.chat) return;
		if (frame.event.type === "session.replaced") {
			this.commandList = { commands: [...BUILTIN_COMMANDS], known: false };
			this.hooks.onReplaced(previousId, frame.event.session as SessionSummary);
		}
		if (chat.needsResync) {
			chat = clearResync(chat);
			void this.resync();
		}
		const { error: _e, ...rest } = this.view;
		this.update({ ...rest, chat });
		if (frame.event.type === "agent_settled") this.hooks.onSettled(this);
	}

	private async resync(): Promise<void> {
		try {
			const snapshot = await this.client.request("session.snapshot", { sessionId: this.sessionId });
			this.update({ ...this.view, chat: applySnapshot(this.view.chat, snapshot) });
		} catch (error) {
			this.hooks.onError(`刷新会话失败：${message(error)}`);
		}
	}

	private async run<T>(action: string, fn: () => Promise<T>): Promise<T | undefined> {
		try {
			return await fn();
		} catch (error) {
			this.hooks.onError(`${action}失败：${message(error)}`);
			return undefined;
		}
	}

	/** Send a message; while the agent runs it steers (or queues a follow-up). */
	send(text: string, images: ImageInput[], mode: "auto" | "steer" | "followUp" = "auto"): Promise<unknown> {
		const sessionId = this.sessionId;
		const idle = this.chat.runState === "idle" || this.chat.runState === "inactive";
		const imageParam = images.length ? { images } : {};
		if (mode === "auto" && idle) {
			return this.run("发送", () => this.client.request("session.prompt", { sessionId, text, ...imageParam }));
		}
		if (mode === "followUp") {
			return this.run("排队", () => this.client.request("session.followUp", { sessionId, text, ...imageParam }));
		}
		return this.run("引导", () => this.client.request("session.steer", { sessionId, text, ...imageParam }));
	}

	/**
	 * Send a slash command the agent runtime handles (extension command, prompt template, skill).
	 * Unlike `send`, it goes through `session.prompt` while the agent runs too, because pi only
	 * runs extension commands from a prompt.
	 */
	sendCommand(text: string, images: ImageInput[], mode: "auto" | "steer" | "followUp" = "auto"): Promise<unknown> {
		const sessionId = this.sessionId;
		const idle = this.chat.runState === "idle" || this.chat.runState === "inactive";
		const streamingBehavior =
			idle && mode === "auto" ? {} : ({ streamingBehavior: mode === "followUp" ? "followUp" : "steer" } as const);
		return this.run("发送命令", () =>
			this.client.request("session.prompt", {
				sessionId,
				text,
				...(images.length ? { images } : {}),
				...streamingBehavior,
			}),
		);
	}

	/** Last known slash commands (built-ins until `loadCommands` finished). */
	get commands(): CommandList {
		return this.commandList;
	}

	/** Fetch the host's slash commands for this session. Never rejects. */
	loadCommands(): Promise<CommandList> {
		if (this.commandsLoading) return this.commandsLoading;
		const sessionId = this.sessionId;
		const loading = this.client
			.request("session.commands", { sessionId })
			.then((result): CommandList => ({ commands: mergeCommands(result.commands), known: true }))
			.catch((): CommandList => ({ commands: [...BUILTIN_COMMANDS], known: false }))
			.then((list) => {
				if (this.sessionId === sessionId) this.commandList = list;
				return list;
			})
			.finally(() => {
				if (this.commandsLoading === loading) this.commandsLoading = undefined;
			});
		this.commandsLoading = loading;
		return loading;
	}

	rename(name: string): Promise<unknown> {
		return this.run("重命名", () => this.client.request("session.rename", { sessionId: this.sessionId, name }));
	}

	reload(): Promise<unknown> {
		return this.run("重新加载", async () => {
			const result = await this.client.request("session.reload", { sessionId: this.sessionId });
			this.commandsLoading = undefined;
			await this.loadCommands();
			return result;
		});
	}

	abort(): Promise<unknown> {
		return this.run("中止", () => this.client.request("session.abort", { sessionId: this.sessionId }));
	}

	compact(instructions?: string): Promise<unknown> {
		return this.run("压缩上下文", () =>
			this.client.request(
				"session.compact",
				{ sessionId: this.sessionId, ...(instructions ? { instructions } : {}) },
				{ timeoutMs: 15 * 60_000 },
			),
		);
	}

	respond(requestId: string, response: UiResponse): Promise<unknown> {
		return this.run("回复", () =>
			this.client.request("ui.respond", { sessionId: this.sessionId, requestId, response }),
		);
	}

	listModels() {
		return this.client.request("model.list", { sessionId: this.sessionId });
	}

	setModel(provider: string, modelId: string, persist = false): Promise<unknown> {
		return this.run("切换模型", () =>
			this.client.request("model.set", { sessionId: this.sessionId, provider, modelId, persist }),
		);
	}

	setThinking(level: ThinkingLevel, persist = false): Promise<unknown> {
		return this.run("设置思考等级", async () => {
			const result = await this.client.request("thinking.set", { sessionId: this.sessionId, level, persist });
			this.update({ ...this.view, chat: { ...this.view.chat, thinkingLevel: result.level } });
			return result;
		});
	}

	forkPoints() {
		return this.client.request("session.forkPoints", { sessionId: this.sessionId });
	}

	dismissNotice(id: number): void {
		this.update({ ...this.view, chat: dismissNotice(this.view.chat, id) });
	}

	get busy(): boolean {
		const state = this.chat.runState;
		return state === "streaming" || state === "compacting" || state === "retrying" || this.chat.pendingUi.length > 0;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		void this.sub?.unsubscribe();
	}
}
