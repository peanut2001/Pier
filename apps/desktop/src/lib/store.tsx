import { ChatController, type ChatView } from "@pier/chat-state";
import { type ClientState, PierClient } from "@pier/client";
import type {
	ApprovalPolicy,
	DeviceInfo,
	EventFrame,
	HostInfo,
	PairingRequest,
	PairingResolution,
	RemoteAccessStatus,
	SessionSummary,
	WorkspaceInfo,
} from "@pier/protocol";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Bridge, HostStatus } from "./bridge.ts";

export const APP_VERSION = "0.2.0";

/** Subscriptions kept alive for recently viewed sessions (so approvals elsewhere stay visible). */
const MAX_LIVE_CHATS = 8;

export interface Toast {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
}

export interface Draft {
	text: string;
	images: Array<{ data: string; mimeType: string; name: string }>;
}

export interface AppState {
	host: HostStatus;
	connection: ClientState | "none";
	hostInfo?: HostInfo;
	connectError?: string;
	workspaces: WorkspaceInfo[];
	workspacesLoaded: boolean;
	sessions: Record<string, SessionSummary[] | undefined>;
	expanded: Record<string, boolean>;
	selectedWorkspaceId?: string;
	selectedSessionId?: string;
	toasts: Toast[];
	/** Bumped whenever a live chat changes, so the sidebar can show running / approval badges. */
	chatsVersion: number;
	remote?: RemoteAccessStatus;
	devices: DeviceInfo[];
	/** Devices waiting for the user to allow pairing. */
	pairingRequests: PairingRequest[];
	/** The pairing code currently shown, if any. */
	pairing?: { uri: string; expiresAt: string; addresses: string[] };
}

const PAIRING_RESULT_TEXT: Record<PairingResolution, string> = {
	accepted: "已配对",
	rejected: "已拒绝配对",
	expired: "配对请求已超时",
	cancelled: "设备取消了配对",
};

const SELECTION_KEY = "pier.selection";
/** Refresh-timer key for the device list (workspace ids are UUIDs, so no clash). */
const DEVICES_KEY = "#devices";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class PierStore {
	private state: AppState;
	private readonly listeners = new Set<() => void>();
	client: PierClient | undefined;
	private clientKey: string | undefined;
	private readonly chats = new Map<string, ChatController>();
	private recent: string[] = [];
	private readonly drafts = new Map<string, Draft>();
	private nextToastId = 1;
	private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private wasOpen = false;

	constructor(private readonly bridge: Bridge) {
		const saved = (() => {
			try {
				return JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}") as {
					workspaceId?: string;
					sessionId?: string;
					expanded?: Record<string, boolean>;
				};
			} catch {
				return {};
			}
		})();
		this.state = {
			host: { state: "starting", restarts: 0, generation: 0 },
			connection: "none",
			workspaces: [],
			workspacesLoaded: false,
			sessions: {},
			expanded: saved.expanded ?? {},
			...(saved.workspaceId ? { selectedWorkspaceId: saved.workspaceId } : {}),
			...(saved.sessionId ? { selectedSessionId: saved.sessionId } : {}),
			toasts: [],
			chatsVersion: 0,
			devices: [],
			pairingRequests: [],
		};
	}

	// ---- external store plumbing -------------------------------------------------------

	getState = (): AppState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private set(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
		const next = typeof patch === "function" ? patch(this.state) : patch;
		this.state = { ...this.state, ...next };
		if ("selectedWorkspaceId" in next || "selectedSessionId" in next || "expanded" in next) {
			localStorage.setItem(
				SELECTION_KEY,
				JSON.stringify({
					workspaceId: this.state.selectedWorkspaceId,
					sessionId: this.state.selectedSessionId,
					expanded: this.state.expanded,
				}),
			);
		}
		for (const listener of [...this.listeners]) listener();
	}

	get bridgeKind(): Bridge["kind"] {
		return this.bridge.kind;
	}

	start(): () => void {
		const off = this.bridge.onStatus((status) => this.onHostStatus(status));
		void this.bridge.status().then((status) => this.onHostStatus(status));
		return () => {
			off();
			this.teardownClient();
		};
	}

	// ---- host / connection -------------------------------------------------------------

	private onHostStatus(status: HostStatus): void {
		this.set({ host: status });
		const key = status.state === "ready" && status.url ? `${status.generation}|${status.url}` : undefined;
		if (key === this.clientKey) return;
		this.teardownClient();
		if (key && status.url) void this.connect(status.url, status.token ?? undefined, key);
	}

	private teardownClient(): void {
		for (const chat of this.chats.values()) chat.dispose();
		this.chats.clear();
		this.recent = [];
		this.client?.close();
		this.client = undefined;
		this.clientKey = undefined;
		this.wasOpen = false;
		this.set((s) => ({
			connection: "none",
			chatsVersion: s.chatsVersion + 1,
			pairingRequests: [],
			pairing: undefined,
		}));
	}

	private async connect(url: string, token: string | undefined, key: string): Promise<void> {
		const client = new PierClient({
			url,
			...(token ? { token } : {}),
			client: { name: "pier-desktop", version: APP_VERSION, platform: navigator.platform || "desktop" },
			requestTimeoutMs: 60_000,
		});
		this.client = client;
		this.clientKey = key;
		const { connectError: _c, ...rest } = this.state;
		this.state = rest as AppState;
		client.onState((state) => {
			if (this.client !== client) return;
			this.set({ connection: state });
			if (state === "open") {
				if (this.wasOpen) void this.reloadAll();
				this.wasOpen = true;
			}
		});
		client.onEvent((frame) => {
			if (this.client === client && !frame.sessionId) this.onHostEvent(frame);
		});
		try {
			const hello = await client.connect();
			if (this.client !== client) return;
			this.set({ hostInfo: hello.host });
			await this.reloadAll();
		} catch (error) {
			if (this.client === client) this.set({ connectError: errorText(error) });
		}
	}

	private onHostEvent(frame: EventFrame): void {
		const event = frame.event;
		if (event.type === "workspace.changed") void this.loadWorkspaces();
		else if (event.type === "session.listChanged") this.scheduleRefresh(String(event.workspaceId));
		else if (event.type === "host.notice") {
			this.toast((event.level as Toast["level"]) ?? "info", String(event.message ?? ""));
		} else if (event.type === "remote.changed") {
			const remote = event.status as RemoteAccessStatus;
			this.set(remote.pairingActive ? { remote } : { remote, pairing: undefined });
		} else if (event.type === "device.changed") {
			this.scheduleRefresh(DEVICES_KEY);
		} else if (event.type === "pairing.request") {
			const request = event.request as PairingRequest;
			this.set((s) => ({
				pairingRequests: [...s.pairingRequests.filter((r) => r.id !== request.id), request],
				pairing: undefined,
			}));
		} else if (event.type === "pairing.resolved") {
			const requestId = String(event.requestId);
			const known = this.state.pairingRequests.find((r) => r.id === requestId);
			this.set((s) => ({ pairingRequests: s.pairingRequests.filter((r) => r.id !== requestId) }));
			const resolution = event.resolution as PairingResolution;
			if (known) {
				this.toast(
					resolution === "accepted" ? "info" : "warning",
					`${known.device.name}：${PAIRING_RESULT_TEXT[resolution] ?? resolution}`,
				);
			}
		}
	}

	private async reloadAll(): Promise<void> {
		void this.loadRemote();
		await this.loadWorkspaces();
		const { selectedSessionId, selectedWorkspaceId } = this.state;
		if (selectedSessionId && selectedWorkspaceId) {
			const known = this.state.sessions[selectedWorkspaceId]?.some((s) => s.id === selectedSessionId);
			if (!known) this.set({ selectedSessionId: undefined });
		}
	}

	async loadWorkspaces(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const { workspaces } = await client.request("workspace.list");
			let selected = this.state.selectedWorkspaceId;
			if (!selected || !workspaces.some((w) => w.id === selected)) selected = workspaces[0]?.id;
			const expanded = { ...this.state.expanded };
			if (selected && expanded[selected] === undefined) expanded[selected] = true;
			this.set({
				workspaces,
				workspacesLoaded: true,
				expanded,
				...(selected ? { selectedWorkspaceId: selected } : { selectedWorkspaceId: undefined }),
			});
			await Promise.all(workspaces.filter((w) => expanded[w.id]).map((w) => this.refreshSessions(w.id)));
		} catch (error) {
			this.toast("error", `加载工作区失败：${errorText(error)}`);
		}
	}

	private scheduleRefresh(workspaceId: string): void {
		clearTimeout(this.refreshTimers.get(workspaceId));
		this.refreshTimers.set(
			workspaceId,
			setTimeout(() => {
				this.refreshTimers.delete(workspaceId);
				if (workspaceId === DEVICES_KEY) void this.loadDevices();
				else void this.refreshSessions(workspaceId);
			}, 150),
		);
	}

	// ---- remote access and devices -----------------------------------------------------

	async loadRemote(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const [remote, { devices }] = await Promise.all([client.request("remote.status"), client.request("device.list")]);
			this.set({ remote, devices });
		} catch (error) {
			this.toast("error", `读取远程访问状态失败：${errorText(error)}`);
		}
	}

	private async loadDevices(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const { devices } = await client.request("device.list");
			this.set({ devices });
		} catch {
			// Transient; the next device.changed or reconnect refreshes it.
		}
	}

	async configureRemote(patch: { enabled?: boolean; port?: number }): Promise<RemoteAccessStatus | undefined> {
		const remote = await this.call("修改远程访问设置", (c) => c.request("remote.configure", patch));
		if (remote) this.set({ remote });
		return remote;
	}

	async startPairing(): Promise<void> {
		const pairing = await this.call("生成配对码", (c) => c.request("pairing.start"));
		if (pairing) this.set({ pairing });
	}

	async cancelPairing(): Promise<void> {
		this.set({ pairing: undefined });
		await this.call("取消配对", (c) => c.request("pairing.cancel"));
	}

	async respondPairing(requestId: string, accept: boolean): Promise<void> {
		this.set((s) => ({ pairingRequests: s.pairingRequests.filter((r) => r.id !== requestId) }));
		const result = await this.call("回复配对请求", (c) => c.request("pairing.respond", { requestId, accept }));
		if (result && !result.accepted) this.toast("warning", "配对请求已失效（设备已断开或超时）");
	}

	async revokeDevice(deviceId: string): Promise<void> {
		const result = await this.call("移除设备", (c) => c.request("device.revoke", { deviceId }));
		if (result) this.set((s) => ({ devices: s.devices.filter((d) => d.id !== deviceId) }));
	}

	async renameDevice(deviceId: string, name: string): Promise<void> {
		const result = await this.call("重命名设备", (c) => c.request("device.rename", { deviceId, name }));
		if (result) this.set((s) => ({ devices: s.devices.map((d) => (d.id === deviceId ? result.device : d)) }));
	}

	async refreshSessions(workspaceId: string): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const { sessions } = await client.request("session.list", { workspaceId });
			this.set((s) => ({ sessions: { ...s.sessions, [workspaceId]: sessions } }));
		} catch (error) {
			this.toast("error", `加载会话列表失败：${errorText(error)}`);
		}
	}

	restartHost(): void {
		void this.bridge.restartHost();
	}

	// ---- toasts ------------------------------------------------------------------------

	toast(level: Toast["level"], message: string): void {
		const id = this.nextToastId++;
		this.set((s) => ({ toasts: [...s.toasts, { id, level, message }].slice(-5) }));
		setTimeout(() => this.dismissToast(id), level === "error" ? 10_000 : 5_000);
	}

	dismissToast(id: number): void {
		this.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
	}

	private async call<T>(action: string, fn: (client: PierClient) => Promise<T>): Promise<T | undefined> {
		const client = this.client;
		if (!client) {
			this.toast("error", `${action}失败：尚未连接到 Pier Host`);
			return undefined;
		}
		try {
			return await fn(client);
		} catch (error) {
			this.toast("error", `${action}失败：${errorText(error)}`);
			return undefined;
		}
	}

	// ---- workspaces --------------------------------------------------------------------

	async addWorkspace(path: string, policy?: ApprovalPolicy): Promise<WorkspaceInfo | undefined> {
		const result = await this.call("添加工作区", (c) =>
			c.request("workspace.add", { path, ...(policy ? { policy } : {}) }),
		);
		if (!result) return undefined;
		await this.loadWorkspaces();
		this.set((s) => ({
			selectedWorkspaceId: result.workspace.id,
			expanded: { ...s.expanded, [result.workspace.id]: true },
		}));
		await this.refreshSessions(result.workspace.id);
		return result.workspace;
	}

	async removeWorkspace(workspaceId: string): Promise<void> {
		const result = await this.call("移除工作区", (c) => c.request("workspace.remove", { workspaceId }));
		if (!result) return;
		for (const [id, chat] of this.chats) {
			if (chat.workspaceId === workspaceId) this.dropChat(id);
		}
		if (this.state.selectedWorkspaceId === workspaceId) {
			this.set({ selectedWorkspaceId: undefined, selectedSessionId: undefined });
		}
		await this.loadWorkspaces();
	}

	async setPolicy(workspaceId: string, policy: ApprovalPolicy): Promise<void> {
		const result = await this.call("修改审批策略", (c) => c.request("workspace.setPolicy", { workspaceId, policy }));
		if (result) {
			this.set((s) => ({
				workspaces: s.workspaces.map((w) => (w.id === workspaceId ? result.workspace : w)),
			}));
		}
	}

	toggleExpanded(workspaceId: string): void {
		const open = !this.state.expanded[workspaceId];
		this.set((s) => ({ expanded: { ...s.expanded, [workspaceId]: open } }));
		if (open) void this.refreshSessions(workspaceId);
	}

	selectWorkspace(workspaceId: string): void {
		this.set((s) => ({
			selectedWorkspaceId: workspaceId,
			selectedSessionId: undefined,
			expanded: { ...s.expanded, [workspaceId]: true },
		}));
		if (!this.state.sessions[workspaceId]) void this.refreshSessions(workspaceId);
	}

	// ---- sessions ----------------------------------------------------------------------

	async createSession(workspaceId: string): Promise<void> {
		const result = await this.call("新建会话", (c) => c.request("session.create", { workspaceId }));
		if (!result) return;
		this.upsertSession(result.session);
		this.selectSession(result.session);
	}

	private upsertSession(session: SessionSummary): void {
		this.set((s) => {
			const list = s.sessions[session.workspaceId] ?? [];
			const rest = list.filter((x) => x.id !== session.id);
			return { sessions: { ...s.sessions, [session.workspaceId]: [session, ...rest] } };
		});
	}

	selectSession(session: SessionSummary): void {
		this.set((s) => ({
			selectedWorkspaceId: session.workspaceId,
			selectedSessionId: session.id,
			expanded: { ...s.expanded, [session.workspaceId]: true },
		}));
	}

	findSession(sessionId: string | undefined): SessionSummary | undefined {
		if (!sessionId) return undefined;
		for (const list of Object.values(this.state.sessions)) {
			const found = list?.find((s) => s.id === sessionId);
			if (found) return found;
		}
		return this.chats.get(sessionId)?.chat.session;
	}

	/** Live controller for a session (created and subscribed on first use). */
	chat(session: SessionSummary): ChatController | undefined {
		const client = this.client;
		if (!client || this.state.connection === "none") return undefined;
		let chat = this.chats.get(session.id);
		if (!chat) {
			chat = new ChatController(client, session, {
				onReplaced: (previousId, next) => this.onReplaced(previousId, next),
				onSettled: (c) => this.scheduleRefresh(c.workspaceId),
				onChange: () => this.set((s) => ({ chatsVersion: s.chatsVersion + 1 })),
				onError: (m) => this.toast("error", m),
			});
			this.chats.set(session.id, chat);
			void chat.start();
		}
		this.touch(session.id);
		return chat;
	}

	/** Live chat state for sidebar badges, when the session is subscribed. */
	liveChat(sessionId: string): ChatController | undefined {
		return this.chats.get(sessionId);
	}

	private touch(sessionId: string): void {
		this.recent = [sessionId, ...this.recent.filter((id) => id !== sessionId)];
		if (this.recent.length <= MAX_LIVE_CHATS) return;
		for (const id of [...this.recent].reverse()) {
			if (this.recent.length <= MAX_LIVE_CHATS) break;
			const chat = this.chats.get(id);
			if (id === this.state.selectedSessionId || chat?.busy) continue;
			this.dropChat(id);
		}
	}

	private dropChat(sessionId: string): void {
		this.chats.get(sessionId)?.dispose();
		this.chats.delete(sessionId);
		this.recent = this.recent.filter((id) => id !== sessionId);
	}

	private onReplaced(previousId: string, session: SessionSummary): void {
		const chat = this.chats.get(previousId);
		if (chat) {
			this.chats.delete(previousId);
			this.chats.set(session.id, chat);
			this.recent = this.recent.map((id) => (id === previousId ? session.id : id));
		}
		this.upsertSession(session);
		if (this.state.selectedSessionId === previousId) this.set({ selectedSessionId: session.id });
		this.scheduleRefresh(session.workspaceId);
	}

	async closeSession(session: SessionSummary, force = false): Promise<void> {
		const result = await this.call("关闭会话", (c) => c.request("session.close", { sessionId: session.id, force }));
		if (!result) return;
		this.dropChat(session.id);
		if (this.state.selectedSessionId === session.id) this.set({ selectedSessionId: undefined });
		await this.refreshSessions(session.workspaceId);
	}

	async renameSession(session: SessionSummary, name: string): Promise<void> {
		const result = await this.call("重命名", (c) => c.request("session.rename", { sessionId: session.id, name }));
		if (result) this.upsertSession(result.session);
	}

	async forkSession(session: SessionSummary, entryId: string): Promise<string | undefined> {
		const result = await this.call("分叉会话", (c) => c.request("session.fork", { sessionId: session.id, entryId }));
		if (!result) return undefined;
		if (result.selectedText) this.saveDraft(result.session.id, { text: result.selectedText, images: [] });
		this.upsertSession(result.session);
		this.selectSession(result.session);
		return result.selectedText;
	}

	// ---- drafts ------------------------------------------------------------------------

	draft(sessionId: string): Draft {
		return this.drafts.get(sessionId) ?? { text: "", images: [] };
	}

	saveDraft(sessionId: string, draft: Draft): void {
		if (!draft.text && !draft.images.length) this.drafts.delete(sessionId);
		else this.drafts.set(sessionId, draft);
	}

	// ---- misc --------------------------------------------------------------------------

	logs(): Promise<string[]> {
		return this.bridge.logs();
	}

	onLog(listener: (line: string) => void): () => void {
		return this.bridge.onLog(listener);
	}

	pickDirectory(): Promise<string | null> {
		return this.bridge.pickDirectory();
	}

	openExternal(url: string): void {
		void this.bridge.openExternal(url);
	}

	quit(): void {
		void this.bridge.quit();
	}
}

export const StoreContext = createContext<PierStore | null>(null);

export function useStore(): PierStore {
	const store = useContext(StoreContext);
	if (!store) throw new Error("PierStore missing");
	return store;
}

export function useAppState<T>(selector: (state: AppState) => T): T {
	const store = useStore();
	return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

const EMPTY_VIEW: ChatView | undefined = undefined;

export function useChatView(chat: ChatController | undefined): ChatView | undefined {
	return useSyncExternalStore(chat?.subscribe ?? noopSubscribe, chat ? chat.getView : () => EMPTY_VIEW);
}

function noopSubscribe(): () => void {
	return () => {};
}
