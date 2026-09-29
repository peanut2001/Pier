import { ChatController, type ChatView } from "@pier/chat-state";
import { type ClientState, PierClient } from "@pier/client";
import type {
	ApprovalPolicy,
	AuthMethod,
	AuthNotice,
	AuthPromptInfo,
	CustomModel,
	CustomProvider,
	CustomProviderApi,
	DefaultModelRef,
	DeviceInfo,
	EventFrame,
	ExtensionListResult,
	ExtensionPackageInfo,
	ExtensionReloadSummary,
	ExtensionResourceInfo,
	ExtensionResourceType,
	ExtensionScope,
	ExtensionUpdateInfo,
	HostInfo,
	MethodName,
	MethodParams,
	MethodResult,
	ModelInfo,
	PairingRequest,
	PairingResolution,
	ProviderInfo,
	ProviderListResult,
	RemoteAccessStatus,
	SessionSummary,
	WorkspaceFileContent,
	WorkspaceFilesResult,
	WorkspaceFileWriteResult,
	WorkspaceInfo,
} from "@pier/protocol";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Bridge, HostStatus, UpdateStatus } from "./bridge.ts";
import { fileToken } from "./composer-text.ts";
import { isYunlianProvider, YUNLIAN_SITE, yunlianGroupOf, yunlianProvider } from "./yunlian.ts";

export const APP_VERSION = "0.2.6";

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

/** An interactive provider sign-in shown in the login dialog. */
export interface AuthFlowState {
	/** Undefined until `provider.login` answered. */
	flowId?: string;
	providerId: string;
	providerName: string;
	method: AuthMethod;
	notices: AuthNotice[];
	prompt?: AuthPromptInfo;
	/** Set when the sign-in failed. */
	error?: string;
}

/** The 云链API browser sign-in shown in its dialog. */
export interface YunlianLoginState {
	/** The authorization page opened in the browser (undefined while starting). */
	authorizeUrl?: string;
	/** Approved in the browser; saving the provider. */
	saving?: boolean;
	/** Set when the sign-in failed. */
	error?: string;
}

/** Pages of the settings screen. */
export type SettingsSection =
	| "account"
	| "general"
	| "models"
	| "workspaces"
	| "extensions"
	| "remote"
	| "logs"
	| "about";

/** Progress of the running extension install / remove / update, as reported by the host. */
export interface ExtensionProgressState {
	action: string;
	phase: "start" | "progress" | "complete" | "error";
	source: string;
	message?: string;
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
	/**
	 * The blank "new chat" screen is open. No session exists yet: sending the first message
	 * creates one in `workspaceId` and switches to it.
	 */
	newChat?: { workspaceId?: string };
	toasts: Toast[];
	/** Bumped whenever a live chat changes, so the sidebar can show running / approval badges. */
	chatsVersion: number;
	remote?: RemoteAccessStatus;
	devices: DeviceInfo[];
	/** Devices waiting for the user to allow pairing. */
	pairingRequests: PairingRequest[];
	/** The pairing code currently shown, if any. */
	pairing?: { uri: string; expiresAt: string; addresses: string[] };
	/** Model providers and credentials (undefined until loaded). */
	providers?: ProviderListResult;
	auth?: AuthFlowState;
	yunlian?: YunlianLoginState;
	update: UpdateStatus;
	/** The settings screen is open on this page (undefined while closed). */
	settings?: SettingsSection;
	/** The left-hand sidebar (workspaces and sessions) is shown. */
	sidebar: boolean;
	/** The right-hand workspace file panel is shown. */
	filesPanel: boolean;
	/** Width of the file panel in pixels. */
	filesPanelWidth: number;
	/** Bumped per workspace when its files may have changed (an agent run finished). */
	filesVersion: Record<string, number>;
	/**
	 * The workspace file shown in the preview dialog. `composerKey` is the composer that the
	 * dialog's "insert" button targets, when there is one.
	 */
	filePreview?: { workspaceId: string; path: string; composerKey?: string } | undefined;
	/** Bumped when pi extension or package settings changed, so the extensions page reloads. */
	extensionsVersion: number;
	extensionProgress?: ExtensionProgressState | undefined;
}

const PAIRING_RESULT_TEXT: Record<PairingResolution, string> = {
	accepted: "已配对",
	rejected: "已拒绝配对",
	expired: "配对请求已超时",
	cancelled: "设备取消了配对",
};

const SELECTION_KEY = "pier.selection";
/** Draft key of the new-chat composer (session ids are UUIDs, so no clash). */
export const NEW_CHAT_DRAFT = "#new-chat";
const FILES_PANEL_KEY = "pier.filesPanel";
const SIDEBAR_KEY = "pier.sidebar";
export const FILES_PANEL_MIN_WIDTH = 220;
export const FILES_PANEL_MAX_WIDTH = 560;
const FILES_PANEL_DEFAULT_WIDTH = 280;

function clampPanelWidth(width: number): number {
	if (!Number.isFinite(width)) return FILES_PANEL_DEFAULT_WIDTH;
	return Math.round(Math.min(FILES_PANEL_MAX_WIDTH, Math.max(FILES_PANEL_MIN_WIDTH, width)));
}
/** Refresh-timer keys for the device and provider lists (workspace ids are UUIDs, so no clash). */
const DEVICES_KEY = "#devices";
const PROVIDERS_KEY = "#providers";

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
	/** Sessions created from the new-chat screen whose draft is sent as soon as they load. */
	private readonly autoSend = new Set<string>();
	private nextToastId = 1;
	private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private wasOpen = false;
	/** Sign-in events that arrived before `provider.login` answered with their flow id. */
	private authBacklog: EventFrame[] = [];
	private openedAuthUrls = new Set<string>();
	private authSeq = 0;
	private yunlianSeq = 0;
	/** The pending 云链API authorization on the host, if any. */
	private yunlianFlow: string | undefined;
	/** The update version already announced with a toast. */
	private announcedUpdate: string | undefined;
	/** Mounted composers, by session, that accept text inserted from elsewhere (the file panel). */
	private readonly composerInserts = new Map<string, (path: string, directory: boolean) => void>();

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
		const panel = (() => {
			try {
				return JSON.parse(localStorage.getItem(FILES_PANEL_KEY) ?? "{}") as { open?: boolean; width?: number };
			} catch {
				return {};
			}
		})();
		const sidebar = (() => {
			try {
				return JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? "{}") as { open?: boolean };
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
			update: { state: "idle", currentVersion: APP_VERSION, autoCheck: true, downloaded: 0 },
			sidebar: sidebar.open !== false,
			filesPanel: panel.open === true,
			filesPanelWidth: clampPanelWidth(panel.width ?? FILES_PANEL_DEFAULT_WIDTH),
			filesVersion: {},
			extensionsVersion: 0,
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
		if ("sidebar" in next) {
			localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ open: this.state.sidebar }));
		}
		if ("filesPanel" in next || "filesPanelWidth" in next) {
			localStorage.setItem(
				FILES_PANEL_KEY,
				JSON.stringify({ open: this.state.filesPanel, width: this.state.filesPanelWidth }),
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
		const offUpdate = this.bridge.updates.onStatus((status) => this.onUpdateStatus(status));
		const offOpen = this.bridge.updates.onOpen(() => this.openSettings("about"));
		void this.bridge.updates.status().then((status) => this.onUpdateStatus(status));
		return () => {
			off();
			offUpdate();
			offOpen();
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
			auth: undefined,
			yunlian: undefined,
		}));
		this.yunlianSeq++;
		this.yunlianFlow = undefined;
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
		else if (event.type === "session.activity") {
			// A run that ends (or pauses for an answer) has likely written files.
			if (event.state === "idle" || Number(event.pendingUi) > 0) this.bumpFiles(String(event.workspaceId));
		} else if (event.type === "host.notice") {
			this.toast((event.level as Toast["level"]) ?? "info", String(event.message ?? ""));
		} else if (event.type === "remote.changed") {
			const remote = event.status as RemoteAccessStatus;
			this.set(remote.pairingActive ? { remote } : { remote, pairing: undefined });
		} else if (event.type === "device.changed") {
			this.scheduleRefresh(DEVICES_KEY);
		} else if (event.type === "provider.changed") {
			this.scheduleRefresh(PROVIDERS_KEY);
		} else if (event.type === "extension.changed") {
			this.set((s) => ({ extensionsVersion: s.extensionsVersion + 1 }));
		} else if (event.type === "extension.progress") {
			const { type: _type, ...progress } = event as unknown as ExtensionProgressState & { type: string };
			this.set({ extensionProgress: progress });
		} else if (event.type.startsWith("auth.")) {
			this.onAuthEvent(frame);
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
		void this.loadProviders();
		await this.loadWorkspaces();
		const { selectedSessionId, selectedWorkspaceId } = this.state;
		if (selectedSessionId && selectedWorkspaceId) {
			const known = this.state.sessions[selectedWorkspaceId]?.some((s) => s.id === selectedSessionId);
			if (!known) this.set({ selectedSessionId: undefined });
		}
	}

	/** Keep the new-chat target pointing at an existing workspace. */
	private fixNewChatTarget(workspaces: WorkspaceInfo[]): Partial<AppState> {
		const newChat = this.state.newChat;
		if (!newChat || workspaces.some((w) => w.id === newChat.workspaceId)) return {};
		const fallback = workspaces.find((w) => w.id === this.state.selectedWorkspaceId) ?? workspaces[0];
		return { newChat: fallback ? { workspaceId: fallback.id } : {} };
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
				...this.fixNewChatTarget(workspaces),
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
				else if (workspaceId === PROVIDERS_KEY) void this.loadProviders();
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

	// ---- models and providers -----------------------------------------------------------

	async loadProviders(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const providers = await client.request("provider.list");
			if (this.client === client) this.set({ providers });
		} catch (error) {
			if (this.state.settings === "models") this.toast("error", `读取模型配置失败：${errorText(error)}`);
		}
	}

	openModels(): void {
		this.openSettings("models");
	}

	/** Models with usable credentials. */
	async availableModels(): Promise<ModelInfo[]> {
		const client = this.client;
		if (!client) return [];
		return (await client.request("model.list")).models;
	}

	async setDefaultModel(provider: string, modelId: string): Promise<void> {
		const result = await this.call("设置默认模型", (c) => c.request("model.setDefault", { provider, modelId }));
		if (result) void this.loadProviders();
	}

	async startLogin(provider: ProviderInfo, method: AuthMethod): Promise<void> {
		const client = this.client;
		if (!client) return;
		if (this.state.auth?.flowId) void this.cancelLogin();
		const seq = ++this.authSeq;
		this.authBacklog = [];
		this.set({ auth: { providerId: provider.id, providerName: provider.name, method, notices: [] } });
		try {
			const { flowId } = await client.request("provider.login", { providerId: provider.id, method });
			if (seq !== this.authSeq || !this.state.auth || this.state.auth.flowId) {
				// Closed (or replaced) while starting: stop the orphaned sign-in.
				await client.request("provider.loginCancel", { flowId }).catch(() => undefined);
				return;
			}
			this.set((s) => (s.auth ? { auth: { ...s.auth, flowId } } : {}));
			const backlog = this.authBacklog.filter((f) => f.event.flowId === flowId);
			this.authBacklog = [];
			for (const frame of backlog) this.onAuthEvent(frame);
		} catch (error) {
			if (seq === this.authSeq) this.set((s) => (s.auth ? { auth: { ...s.auth, error: errorText(error) } } : {}));
		}
	}

	private onAuthEvent(frame: EventFrame): void {
		const event = frame.event;
		const auth = this.state.auth;
		if (!auth) return;
		if (!auth.flowId) {
			this.authBacklog.push(frame);
			return;
		}
		if (event.flowId !== auth.flowId) return;
		if (event.type === "auth.prompt") {
			this.set({ auth: { ...auth, prompt: event.prompt as AuthPromptInfo } });
		} else if (event.type === "auth.promptClosed") {
			if (auth.prompt?.id === event.promptId) {
				const { prompt: _p, ...rest } = auth;
				this.set({ auth: rest });
			}
		} else if (event.type === "auth.notice") {
			const notice = event.notice as AuthNotice;
			if (notice.type === "auth_url" && !this.openedAuthUrls.has(notice.url)) {
				this.openedAuthUrls.add(notice.url);
				this.openExternal(notice.url);
			}
			this.set({ auth: { ...auth, notices: [...auth.notices, notice].slice(-20) } });
		} else if (event.type === "auth.done") {
			if (event.ok) {
				const defaultModel = event.defaultModel as DefaultModelRef | undefined;
				this.set({ auth: undefined });
				this.toast(
					"info",
					`${auth.method === "oauth" ? "已登录" : "已保存 API Key："}${auth.providerName}${
						defaultModel ? `，默认模型设为 ${defaultModel.modelId}` : ""
					}`,
				);
			} else if (event.cancelled) {
				this.set({ auth: undefined });
			} else {
				const { prompt: _p, ...rest } = auth;
				this.set({ auth: { ...rest, error: String(event.error ?? "登录失败") } });
			}
			void this.loadProviders();
		}
	}

	async answerAuthPrompt(value: string): Promise<void> {
		const auth = this.state.auth;
		if (!auth?.flowId || !auth.prompt) return;
		const promptId = auth.prompt.id;
		const { prompt: _p, ...rest } = auth;
		this.set({ auth: rest });
		await this.call("提交", (c) =>
			c.request("provider.loginRespond", { flowId: auth.flowId as string, promptId, value }),
		);
	}

	async cancelLogin(): Promise<void> {
		const auth = this.state.auth;
		this.authSeq++;
		this.set({ auth: undefined });
		if (auth?.flowId && !auth.error) {
			const client = this.client;
			await client?.request("provider.loginCancel", { flowId: auth.flowId }).catch(() => undefined);
		}
	}

	async logoutProvider(provider: ProviderInfo): Promise<void> {
		const result = await this.call("移除凭据", (c) => c.request("provider.logout", { providerId: provider.id }));
		if (result) {
			this.toast("info", result.removed ? `已移除 ${provider.name} 的凭据` : `${provider.name} 没有可移除的凭据`);
			void this.loadProviders();
		}
	}

	/** Save a custom endpoint. Throws so the form can show the error next to the fields. */
	async saveCustomProvider(
		provider: CustomProvider,
		key: { apiKey?: string | undefined; apiKeyRef?: string | undefined },
		create: boolean,
	): Promise<void> {
		const client = this.client;
		if (!client) throw new Error("尚未连接到 Pier Host");
		const result = await client.request("provider.saveCustom", {
			provider,
			...(key.apiKeyRef ? { apiKeyRef: key.apiKeyRef } : key.apiKey ? { apiKey: key.apiKey } : {}),
			create,
		});
		this.toast(
			"info",
			`已保存 ${result.provider.name}${result.defaultModel ? `，默认模型设为 ${result.defaultModel.modelId}` : ""}`,
		);
		await this.loadProviders();
	}

	async removeCustomProvider(provider: ProviderInfo): Promise<void> {
		const result = await this.call("删除服务商", (c) =>
			c.request("provider.removeCustom", { providerId: provider.id }),
		);
		if (result?.removed) {
			this.toast("info", `已删除 ${provider.name}`);
			void this.loadProviders();
		}
	}

	/** Models offered by an endpoint. Throws with the host's message. */
	async probeModels(params: {
		api: CustomProviderApi;
		baseUrl: string;
		apiKey?: string;
		apiKeyRef?: string;
		providerId?: string;
	}): Promise<CustomModel[]> {
		const client = this.client;
		if (!client) throw new Error("尚未连接到 Pier Host");
		return (await client.request("provider.probeModels", params, { timeoutMs: 30_000 })).models;
	}

	// ---- 云链API sign-in (NewAPI app authorization in the browser) ------------------------

	/**
	 * Sign in to 云链API: open its authorization page in the browser and, once the user approves,
	 * save (or refresh) the provider with the new token and every model it can use.
	 */
	async loginYunlian(): Promise<void> {
		const client = this.client;
		if (!client) {
			this.toast("error", "尚未连接到 Pier Host");
			return;
		}
		this.cancelYunlian();
		const seq = ++this.yunlianSeq;
		const current = () => seq === this.yunlianSeq;
		this.set({ yunlian: {} });
		try {
			const started = await client.request("newapi.authorizeStart", { baseUrl: YUNLIAN_SITE }, { timeoutMs: 45_000 });
			if (!current()) {
				// Closed while starting: stop the orphaned authorization.
				void client.request("newapi.authorizeCancel", { flowId: started.flowId }).catch(() => undefined);
				return;
			}
			this.yunlianFlow = started.flowId;
			this.set({ yunlian: { authorizeUrl: started.authorizeUrl } });
			this.openExternal(started.authorizeUrl);
			const result = await client.request(
				"newapi.authorizeWait",
				{ flowId: started.flowId },
				{ timeoutMs: 11 * 60_000 },
			);
			if (!current()) return;
			this.yunlianFlow = undefined;
			this.set({ yunlian: { authorizeUrl: started.authorizeUrl, saving: true } });
			const existing = this.state.providers?.providers.find(
				(p) => p.custom && isYunlianProvider(p) && yunlianGroupOf(p) === undefined,
			)?.custom;
			const provider = yunlianProvider(result.models, existing, result.modelsError);
			await this.saveCustomProvider(provider, { apiKeyRef: result.keyRef }, !existing);
			if (current()) this.set({ yunlian: undefined });
		} catch (error) {
			if (current()) {
				this.yunlianFlow = undefined;
				this.set({ yunlian: { error: errorText(error) } });
			}
		}
	}

	/** Call a personal-center method (`account.*`). Throws with the host's message. */
	account<M extends Extract<MethodName, `account.${string}`>>(
		method: M,
		params: MethodParams<M>,
		timeoutMs = 45_000,
	): Promise<MethodResult<M>> {
		const client = this.client;
		if (!client) return Promise.reject(new Error("尚未连接到 Pier Host"));
		return (client.request as (m: M, p: MethodParams<M>, o: { timeoutMs: number }) => Promise<MethodResult<M>>)(
			method,
			params,
			{ timeoutMs },
		);
	}

	/** Close the 云链API sign-in, abandoning a pending authorization. */
	cancelYunlian(): void {
		this.yunlianSeq++;
		const flowId = this.yunlianFlow;
		this.yunlianFlow = undefined;
		if (flowId) void this.client?.request("newapi.authorizeCancel", { flowId }).catch(() => undefined);
		if (this.state.yunlian) this.set({ yunlian: undefined });
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

	// ---- pi extensions and packages -----------------------------------------------------

	/** List extensions and packages (user settings, plus a workspace's project settings); rejects with the host's error. */
	async listExtensions(workspaceId?: string): Promise<ExtensionListResult> {
		const client = this.client;
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("extension.list", workspaceId ? { workspaceId } : {});
	}

	/** Tell the user about sessions that still run the old extensions. */
	private reportReload(done: string, reload: ExtensionReloadSummary): void {
		const parts = [done];
		if (reload.reloaded) parts.push(`已重新加载 ${reload.reloaded} 个打开的会话`);
		if (reload.pending) parts.push(`${reload.pending} 个会话正在运行，完成后在会话中执行 /reload 生效`);
		if (reload.failed) parts.push(`${reload.failed} 个会话重新加载失败（详见日志）`);
		this.toast(reload.failed ? "warning" : "info", parts.join("；"));
	}

	private async extensionOperation<T extends { reload: ExtensionReloadSummary }>(
		action: string,
		done: string,
		fn: (client: PierClient) => Promise<T>,
	): Promise<T | undefined> {
		this.set({ extensionProgress: undefined });
		const result = await this.call(action, fn);
		this.set({ extensionProgress: undefined });
		if (result) this.reportReload(done, result.reload);
		return result;
	}

	async installExtension(
		source: string,
		scope: ExtensionScope,
		workspaceId?: string,
	): Promise<ExtensionPackageInfo | undefined | false> {
		const result = await this.extensionOperation("安装", `已安装 ${source}`, (c) =>
			c.request(
				"extension.install",
				{ source, scope, ...(workspaceId ? { workspaceId } : {}) },
				{ timeoutMs: 15 * 60_000 },
			),
		);
		return result ? result.package : false;
	}

	async removeExtensionPackage(pkg: ExtensionPackageInfo, workspaceId?: string): Promise<boolean> {
		const result = await this.extensionOperation("移除", `已移除 ${pkg.name ?? pkg.source}`, (c) =>
			c.request(
				"extension.remove",
				{ source: pkg.source, scope: pkg.scope, ...(workspaceId ? { workspaceId } : {}) },
				{ timeoutMs: 5 * 60_000 },
			),
		);
		return result?.removed ?? false;
	}

	async updateExtensions(source?: string, workspaceId?: string): Promise<boolean> {
		const result = await this.extensionOperation("更新", source ? `已更新 ${source}` : "已更新所有扩展包", (c) =>
			c.request(
				"extension.update",
				{ ...(source ? { source } : {}), ...(workspaceId ? { workspaceId } : {}) },
				{ timeoutMs: 15 * 60_000 },
			),
		);
		return result !== undefined;
	}

	async checkExtensionUpdates(workspaceId?: string): Promise<ExtensionUpdateInfo[] | undefined> {
		const result = await this.call("检查更新", (c) =>
			c.request("extension.checkUpdates", workspaceId ? { workspaceId } : {}, { timeoutMs: 5 * 60_000 }),
		);
		return result?.updates;
	}

	async setExtensionEnabled(
		resource: ExtensionResourceInfo,
		enabled: boolean,
		workspaceId?: string,
	): Promise<ExtensionResourceInfo | undefined> {
		const result = await this.extensionOperation(
			enabled ? "启用" : "停用",
			`已${enabled ? "启用" : "停用"} ${resource.name}`,
			(c) =>
				c.request("extension.setEnabled", {
					type: resource.type as ExtensionResourceType,
					path: resource.path,
					enabled,
					...(workspaceId ? { workspaceId } : {}),
				}),
		);
		return result?.resource;
	}

	async deleteExtension(resource: ExtensionResourceInfo, workspaceId?: string): Promise<boolean> {
		const result = await this.extensionOperation(
			"删除",
			resource.source === "auto" ? `已删除 ${resource.name}（已移到 Pier 回收站）` : `已从配置中移除 ${resource.name}`,
			(c) => c.request("extension.delete", { path: resource.path, ...(workspaceId ? { workspaceId } : {}) }),
		);
		return result?.deleted ?? false;
	}

	// ---- workspaces --------------------------------------------------------------------

	toggleSidebar(open = !this.state.sidebar): void {
		if (open !== this.state.sidebar) this.set({ sidebar: open });
	}

	toggleFilesPanel(open = !this.state.filesPanel): void {
		if (open !== this.state.filesPanel) this.set({ filesPanel: open });
	}

	setFilesPanelWidth(width: number): void {
		const filesPanelWidth = clampPanelWidth(width);
		if (filesPanelWidth !== this.state.filesPanelWidth) this.set({ filesPanelWidth });
	}

	/** List one directory of a workspace; rejects with the host's error. */
	async listFiles(workspaceId: string, path: string): Promise<WorkspaceFilesResult> {
		const client = this.client;
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("workspace.files", path ? { workspaceId, path } : { workspaceId });
	}

	/** Read one workspace file for preview; rejects with the host's error. */
	async readFile(workspaceId: string, path: string): Promise<WorkspaceFileContent> {
		const client = this.client;
		if (!client) throw new Error("尚未连接到 Pier Host");
		return client.request("workspace.readFile", { workspaceId, path });
	}

	/**
	 * Overwrite a workspace file with text; rejects with the host's error (`CONFLICT` when the
	 * file changed since `expectedModifiedAt`). Refreshes the file panel on success.
	 */
	async writeFile(
		workspaceId: string,
		path: string,
		text: string,
		expectedModifiedAt?: string,
	): Promise<WorkspaceFileWriteResult> {
		const client = this.client;
		if (!client) throw new Error("尚未连接到 Pier Host");
		const result = await client.request("workspace.writeFile", {
			workspaceId,
			path,
			text,
			...(expectedModifiedAt ? { expectedModifiedAt } : {}),
		});
		this.bumpFiles(workspaceId);
		return result;
	}

	bumpFiles(workspaceId: string): void {
		this.set((s) => ({ filesVersion: { ...s.filesVersion, [workspaceId]: (s.filesVersion[workspaceId] ?? 0) + 1 } }));
	}

	openFilePreview(workspaceId: string, path: string, composerKey?: string): void {
		this.set({ filePreview: { workspaceId, path, ...(composerKey ? { composerKey } : {}) } });
	}

	closeFilePreview(): void {
		if (this.state.filePreview) this.set({ filePreview: undefined });
	}

	/** Called by a mounted composer; returns the unregister function. */
	registerComposer(sessionId: string, insert: (path: string, directory: boolean) => void): () => void {
		this.composerInserts.set(sessionId, insert);
		return () => {
			if (this.composerInserts.get(sessionId) === insert) this.composerInserts.delete(sessionId);
		};
	}

	/**
	 * Insert a workspace file (or directory) chip at the cursor of the session's composer, or
	 * append it to the saved draft when that composer is not on screen.
	 */
	insertFileIntoComposer(sessionId: string, path: string, directory = false): void {
		const insert = this.composerInserts.get(sessionId);
		if (insert) {
			insert(path, directory);
			return;
		}
		const draft = this.draft(sessionId);
		const sep = draft.text && !/\s$/.test(draft.text) ? " " : "";
		this.saveDraft(sessionId, { ...draft, text: `${draft.text}${sep}${fileToken(path, directory)} ` });
	}

	async addWorkspace(path: string, policy?: ApprovalPolicy): Promise<WorkspaceInfo | undefined> {
		const result = await this.call("添加工作区", (c) =>
			c.request("workspace.add", { path, ...(policy ? { policy } : {}) }),
		);
		if (!result) return undefined;
		await this.loadWorkspaces();
		this.set((s) => ({
			selectedWorkspaceId: result.workspace.id,
			expanded: { ...s.expanded, [result.workspace.id]: true },
			...(s.newChat ? { newChat: { workspaceId: result.workspace.id } } : {}),
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
			newChat: undefined,
			expanded: { ...s.expanded, [workspaceId]: true },
		}));
		if (!this.state.sessions[workspaceId]) void this.refreshSessions(workspaceId);
	}

	// ---- new chat ----------------------------------------------------------------------

	/**
	 * Open the blank new-chat screen. The session is only created when the first message is
	 * sent, so opening it and walking away leaves no empty session behind.
	 */
	startNewChat(workspaceId?: string): void {
		const { workspaces, selectedWorkspaceId } = this.state;
		const target =
			workspaces.find((w) => w.id === workspaceId) ??
			workspaces.find((w) => w.id === selectedWorkspaceId) ??
			workspaces[0];
		this.set({ newChat: target ? { workspaceId: target.id } : {}, selectedSessionId: undefined });
	}

	setNewChatWorkspace(workspaceId: string): void {
		if (this.state.newChat) this.set({ newChat: { workspaceId } });
	}

	/**
	 * Send the new-chat draft: create a session in the chosen workspace, open it, and let its
	 * composer send the draft once the session has loaded (so slash commands and failures behave
	 * exactly as in any other session). Resolves to whether the session was created.
	 */
	async sendNewChat(draft: Draft): Promise<boolean> {
		const workspaceId = this.state.newChat?.workspaceId;
		if (!workspaceId) {
			this.toast("warning", "请先选择一个工作区");
			return false;
		}
		const result = await this.call("新建会话", (c) => c.request("session.create", { workspaceId }));
		if (!result) return false;
		const session = result.session;
		this.drafts.delete(NEW_CHAT_DRAFT);
		this.saveDraft(session.id, draft);
		this.autoSend.add(session.id);
		this.upsertSession(session);
		this.selectSession(session);
		return true;
	}

	/** Whether the session's draft should be sent right away (asked once, by its composer). */
	takeAutoSend(sessionId: string): boolean {
		return this.autoSend.delete(sessionId);
	}

	// ---- sessions ----------------------------------------------------------------------

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
			newChat: undefined,
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

	/**
	 * Delete a session (the host moves its file to `~/.pier/trash/sessions`). `force` aborts a
	 * running agent first. Resolves to whether it was deleted.
	 */
	async deleteSession(session: SessionSummary, force = false): Promise<boolean> {
		const result = await this.call("删除会话", (c) =>
			c.request("session.delete", { workspaceId: session.workspaceId, sessionId: session.id, force }),
		);
		if (!result) return false;
		this.dropChat(session.id);
		this.drafts.delete(session.id);
		this.autoSend.delete(session.id);
		this.set((s) => ({
			sessions: {
				...s.sessions,
				[session.workspaceId]: (s.sessions[session.workspaceId] ?? []).filter((x) => x.id !== session.id),
			},
			...(s.selectedSessionId === session.id ? { selectedSessionId: undefined } : {}),
		}));
		await this.refreshSessions(session.workspaceId);
		return true;
	}

	async renameSession(session: SessionSummary, name: string): Promise<void> {
		const result = await this.call("重命名", (c) => c.request("session.rename", { sessionId: session.id, name }));
		if (result) this.upsertSession(result.session);
	}

	/** Fork into a new session and open it. Resolves to whether it succeeded. */
	async forkSession(session: SessionSummary, entryId: string): Promise<boolean> {
		const result = await this.call("分叉会话", (c) => c.request("session.fork", { sessionId: session.id, entryId }));
		if (!result) return false;
		if (result.selectedText) this.saveDraft(result.session.id, { text: result.selectedText, images: [] });
		this.upsertSession(result.session);
		this.selectSession(result.session);
		return true;
	}

	// ---- drafts ------------------------------------------------------------------------

	draft(sessionId: string): Draft {
		return this.drafts.get(sessionId) ?? { text: "", images: [] };
	}

	saveDraft(sessionId: string, draft: Draft): void {
		if (!draft.text && !draft.images.length) this.drafts.delete(sessionId);
		else this.drafts.set(sessionId, draft);
	}

	// ---- updates -----------------------------------------------------------------------

	private onUpdateStatus(status: UpdateStatus): void {
		const announce =
			status.state === "available" &&
			status.version &&
			status.version !== this.announcedUpdate &&
			this.state.settings !== "about";
		this.set({ update: status });
		if (announce && status.version) {
			this.announcedUpdate = status.version;
			this.toast("info", `Pier v${status.version} 已发布，可在“设置 → 关于与更新”中安装`);
		}
	}

	// ---- settings screen ---------------------------------------------------------------

	openSettings(section: SettingsSection = "general"): void {
		if (section === "about" && this.state.update.version) this.announcedUpdate = this.state.update.version;
		this.set({ settings: section });
		if (section === "models" || section === "account") void this.loadProviders();
	}

	closeSettings(): void {
		this.set({ settings: undefined });
	}

	async checkForUpdates(): Promise<UpdateStatus> {
		try {
			const status = await this.bridge.updates.check();
			this.set({ update: status });
			return status;
		} catch (error) {
			this.toast("error", `检查更新失败：${errorText(error)}`);
			return this.state.update;
		}
	}

	/** Download, install, and relaunch. The updater reports failures through its status. */
	async installUpdate(): Promise<void> {
		try {
			await this.bridge.updates.install();
		} catch (error) {
			if (this.state.update.state !== "error") this.toast("error", errorText(error));
		}
	}

	async setUpdateAutoCheck(enabled: boolean): Promise<void> {
		try {
			this.set({ update: await this.bridge.updates.setAutoCheck(enabled) });
		} catch (error) {
			this.toast("error", `保存更新设置失败：${errorText(error)}`);
		}
	}

	/** Sessions that are working or waiting for an answer; installing an update stops them. */
	async busySessionCount(): Promise<number> {
		const client = this.client;
		if (!client) return 0;
		const lists = await Promise.all(
			this.state.workspaces.map((w) =>
				client.request("session.list", { workspaceId: w.id }).then(
					(r) => r.sessions,
					() => this.state.sessions[w.id] ?? [],
				),
			),
		);
		return lists
			.flat()
			.filter((s) => s.state === "streaming" || s.state === "retrying" || s.state === "compacting" || s.pendingUi)
			.length;
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

	/** Whether local paths can be shown in the system file manager (desktop app only). */
	get canRevealPaths(): boolean {
		return Boolean(this.bridge.revealPath);
	}

	revealPath(path: string): void {
		const reveal = this.bridge.revealPath;
		if (!reveal) return;
		reveal(path).catch((error: unknown) =>
			this.toast("error", `无法在文件管理器中显示：${error instanceof Error ? error.message : String(error)}`),
		);
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
