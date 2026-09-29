import { ChatController, type ChatView } from "@pier/chat-state";
import {
	CLOSE_DEVICE_REVOKED,
	type ClientState,
	createSecureSocketFactory,
	type PairingPhase,
	PierClient,
	pairWithHost,
} from "@pier/client";
import { ChannelError, fromBase64Url, type KeyPair, PairingUriError, parsePairingUri, toBase64Url } from "@pier/crypto";
import type { EventFrame, HostInfo, SessionRunState, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { createContext, useContext, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { loadHosts, type PairedHost, removeHost, saveHost } from "./hosts.ts";
import {
	defaultDeviceName,
	deviceFingerprint,
	deviceModel,
	devicePlatform,
	loadDeviceKey,
	loadDeviceName,
	saveDeviceName,
} from "./identity.ts";

export const APP_VERSION = "0.2.3";

/** Live session subscriptions kept for quick back-and-forth navigation. */
const MAX_LIVE_CHATS = 4;

export interface HostView {
	hostId?: string;
	connection: ClientState | "none";
	/** Last connection problem, shown while (re)connecting. */
	error?: string;
	/** The host no longer knows this device (revoked or reset); pairing again is required. */
	revoked: boolean;
	info?: HostInfo;
	workspaces?: WorkspaceInfo[];
	sessions: Record<string, SessionSummary[] | undefined>;
	/** Which address the secure channel is using. */
	address?: string;
}

export interface Toast {
	id: number;
	level: "info" | "error";
	message: string;
}

export interface MobileState {
	ready: boolean;
	hosts: PairedHost[];
	deviceName: string;
	fingerprint: string;
	host: HostView;
	chatsVersion: number;
	toast?: Toast;
}

const EMPTY_HOST: HostView = { connection: "none", revoked: false, sessions: {} };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** User-facing text for pairing failures. */
export function pairingErrorText(error: unknown): string {
	if (error instanceof PairingUriError) return `二维码无效：${error.message}`;
	if (error instanceof ChannelError) {
		switch (error.code) {
			case "PAIRING_INVALID":
				return "配对码无效或已过期，请在电脑上重新生成二维码。";
			case "PAIRING_REJECTED":
				return "电脑上拒绝了这次配对。";
			case "PAIRING_TIMEOUT":
				return "电脑上没有及时确认，请重试。";
			case "BAD_HANDSHAKE":
				return `安全握手失败：${error.message}`;
			default:
				return error.message;
		}
	}
	return `无法连接到电脑：${errorText(error)}。请确认手机与电脑在同一网络，且电脑上已开启远程访问。`;
}

export class MobileStore {
	private state: MobileState = {
		ready: false,
		hosts: [],
		deviceName: "",
		fingerprint: "",
		host: EMPTY_HOST,
		chatsVersion: 0,
	};
	private readonly listeners = new Set<() => void>();
	private keyPair: KeyPair | undefined;
	private client: PierClient | undefined;
	private readonly chats = new Map<string, ChatController>();
	private recent: string[] = [];
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryAttempt = 0;
	private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private nextToastId = 1;
	private readonly drafts = new Map<string, string>();

	getState = (): MobileState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private set(patch: Partial<MobileState> | ((state: MobileState) => Partial<MobileState>)): void {
		const next = typeof patch === "function" ? patch(this.state) : patch;
		this.state = { ...this.state, ...next };
		for (const listener of [...this.listeners]) listener();
	}

	private setHost(patch: Partial<HostView> | ((host: HostView) => Partial<HostView>)): void {
		this.set((s) => ({ host: { ...s.host, ...(typeof patch === "function" ? patch(s.host) : patch) } }));
	}

	async init(): Promise<void> {
		if (this.state.ready) return;
		const [keyPair, deviceName, hosts] = await Promise.all([loadDeviceKey(), loadDeviceName(), loadHosts()]);
		this.keyPair = keyPair;
		this.set({ ready: true, hosts, deviceName, fingerprint: deviceFingerprint(keyPair) });
	}

	toast(level: Toast["level"], message: string): void {
		const id = this.nextToastId++;
		this.set({ toast: { id, level, message } });
		setTimeout(
			() => {
				if (this.state.toast?.id === id) this.set({ toast: undefined });
			},
			level === "error" ? 6000 : 3500,
		);
	}

	dismissToast(): void {
		this.set({ toast: undefined });
	}

	async setDeviceName(name: string): Promise<void> {
		const trimmed = name.trim() || defaultDeviceName();
		await saveDeviceName(trimmed);
		this.set({ deviceName: trimmed });
	}

	// ---- pairing -----------------------------------------------------------------------

	/** Pair from a scanned / pasted `pier://pair?...` link. Resolves to the host id. */
	async pair(uri: string, onPhase?: (phase: PairingPhase) => void): Promise<string> {
		const keyPair = this.keyPair;
		if (!keyPair) throw new Error("App is still starting");
		const info = parsePairingUri(uri);
		const model = deviceModel();
		const outcome = await pairWithHost({
			info,
			deviceKeyPair: keyPair,
			device: {
				name: this.state.deviceName || defaultDeviceName(),
				platform: devicePlatform(),
				...(model ? { model } : {}),
				appVersion: APP_VERSION,
			},
			...(onPhase ? { onPhase } : {}),
		});
		const host: PairedHost = {
			hostId: outcome.hostId,
			hostName: outcome.hostName,
			hostPublicKey: toBase64Url(outcome.hostPublicKey),
			addresses: outcome.addresses,
			deviceId: outcome.deviceId,
			pairedAt: new Date().toISOString(),
		};
		const hosts = [host, ...this.state.hosts.filter((h) => h.hostId !== host.hostId)];
		await saveHost(host, hosts);
		this.set({ hosts });
		// A re-pair of the active host clears the revoked state; connect right away.
		if (this.state.host.hostId === host.hostId) this.teardown();
		this.openHost(host.hostId);
		return host.hostId;
	}

	async forgetHost(hostId: string): Promise<void> {
		if (this.state.host.hostId === hostId) this.teardown();
		const hosts = this.state.hosts.filter((h) => h.hostId !== hostId);
		await removeHost(hostId, hosts);
		this.set({ hosts });
	}

	private async updateHost(hostId: string, patch: Partial<PairedHost>): Promise<void> {
		const current = this.state.hosts.find((h) => h.hostId === hostId);
		if (!current) return;
		const updated = { ...current, ...patch };
		const hosts = this.state.hosts.map((h) => (h.hostId === hostId ? updated : h));
		this.set({ hosts });
		await saveHost(updated, hosts).catch(() => undefined);
	}

	// ---- connection --------------------------------------------------------------------

	get activeClient(): PierClient | undefined {
		return this.client;
	}

	/** Connect to a paired host (no-op if it is already the active one). */
	openHost(hostId: string): void {
		if (this.state.host.hostId === hostId && this.client && this.client.state !== "closed") return;
		if (this.state.host.hostId === hostId && this.state.host.revoked) return;
		this.teardown();
		const host = this.state.hosts.find((h) => h.hostId === hostId);
		if (!host || !this.keyPair) return;
		this.set({ host: { ...EMPTY_HOST, hostId, connection: "connecting" } });
		this.connect(host);
	}

	private connect(host: PairedHost): void {
		const keyPair = this.keyPair;
		if (!keyPair) return;
		const client = new PierClient({
			url: `pier://${host.hostId}`,
			client: { name: "pier-mobile", version: APP_VERSION, platform: Platform.OS },
			coalesceMs: 50,
			requestTimeoutMs: 60_000,
			heartbeatMs: 25_000,
			reconnect: { initialDelayMs: 500, maxDelayMs: 10_000 },
			createWebSocket: createSecureSocketFactory({
				addresses: host.addresses,
				hostPublicKey: fromBase64Url(host.hostPublicKey),
				deviceKeyPair: keyPair,
				onConnected: (address) => {
					if (this.client !== client) return;
					this.setHost({ address });
					if (host.addresses[0] !== address) {
						void this.updateHost(host.hostId, {
							addresses: [address, ...host.addresses.filter((a) => a !== address)],
						});
					}
				},
			}),
		});
		this.client = client;
		client.onState((state) => {
			if (this.client !== client) return;
			this.setHost(state === "open" ? { connection: state, error: undefined } : { connection: state });
			if (state === "open") {
				this.retryAttempt = 0;
				void this.updateHost(host.hostId, { lastConnectedAt: new Date().toISOString() });
				void this.loadWorkspaces();
			}
		});
		client.onEvent((frame) => {
			if (this.client === client && !frame.sessionId) this.onHostEvent(frame);
		});
		client.onError((error) => {
			if (this.client !== client) return;
			if (client.terminalClose?.code === CLOSE_DEVICE_REVOKED) this.markRevoked();
			else this.setHost({ error: errorText(error) });
		});
		client
			.connect()
			.then((hello) => {
				if (this.client === client) this.setHost({ info: hello.host });
			})
			.catch((error: unknown) => {
				if (this.client !== client) return;
				if (client.terminalClose?.code === CLOSE_DEVICE_REVOKED) {
					this.markRevoked();
					return;
				}
				// The host may simply be offline or asleep: keep trying while the host is open.
				this.setHost({ connection: "reconnecting", error: errorText(error) });
				const delay = Math.min(15_000, 1000 * 2 ** this.retryAttempt);
				this.retryAttempt += 1;
				this.retryTimer = setTimeout(() => {
					this.retryTimer = undefined;
					if (this.client === client) this.connect(host);
				}, delay);
			});
	}

	private markRevoked(): void {
		this.client?.close();
		this.setHost({ revoked: true, connection: "closed", error: "这台设备已被电脑移除（或电脑重置了 Pier）。" });
	}

	/** Called when the app returns to the foreground: reconnect right away. */
	onForeground(): void {
		const client = this.client;
		if (!client) return;
		if (client.state === "reconnecting") client.reconnectNow();
		else if (this.retryTimer && this.state.host.hostId) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
			this.retryAttempt = 0;
			const host = this.state.hosts.find((h) => h.hostId === this.state.host.hostId);
			if (host) this.connect(host);
		}
	}

	retryNow(): void {
		this.onForeground();
	}

	private teardown(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.retryAttempt = 0;
		for (const chat of this.chats.values()) chat.dispose();
		this.chats.clear();
		this.recent = [];
		this.client?.close();
		this.client = undefined;
		this.set((s) => ({ host: EMPTY_HOST, chatsVersion: s.chatsVersion + 1 }));
	}

	private onHostEvent(frame: EventFrame): void {
		const event = frame.event;
		if (event.type === "workspace.changed") void this.loadWorkspaces();
		else if (event.type === "session.listChanged") this.scheduleRefresh(String(event.workspaceId));
		else if (event.type === "session.activity") {
			const workspaceId = String(event.workspaceId);
			const sessionId = String(event.sessionId);
			const list = this.state.host.sessions[workspaceId];
			if (!list?.some((s) => s.id === sessionId)) {
				this.scheduleRefresh(workspaceId);
				return;
			}
			const state = event.state as SessionRunState;
			const pendingUi = Number(event.pendingUi) || 0;
			this.setHost((h) => ({
				sessions: {
					...h.sessions,
					[workspaceId]: list.map((s) => (s.id === sessionId ? { ...s, state, pendingUi, active: true } : s)),
				},
			}));
		} else if (event.type === "host.notice") {
			this.toast(event.level === "error" ? "error" : "info", String(event.message ?? ""));
		}
	}

	async loadWorkspaces(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const { workspaces } = await client.request("workspace.list");
			if (this.client !== client) return;
			this.setHost({ workspaces });
			await Promise.all(workspaces.map((w) => this.refreshSessions(w.id)));
		} catch (error) {
			if (this.client === client) this.toast("error", `加载工作区失败：${errorText(error)}`);
		}
	}

	private scheduleRefresh(workspaceId: string): void {
		clearTimeout(this.refreshTimers.get(workspaceId));
		this.refreshTimers.set(
			workspaceId,
			setTimeout(() => {
				this.refreshTimers.delete(workspaceId);
				void this.refreshSessions(workspaceId);
			}, 200),
		);
	}

	async refreshSessions(workspaceId: string): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const { sessions } = await client.request("session.list", { workspaceId });
			if (this.client !== client) return;
			this.setHost((h) => ({ sessions: { ...h.sessions, [workspaceId]: sessions } }));
		} catch {
			// Transient; refreshed again on the next event or reconnect.
		}
	}

	async createSession(workspaceId: string): Promise<SessionSummary | undefined> {
		const client = this.client;
		if (!client) return undefined;
		try {
			const { session } = await client.request("session.create", { workspaceId });
			this.setHost((h) => ({
				sessions: { ...h.sessions, [workspaceId]: [session, ...(h.sessions[workspaceId] ?? [])] },
			}));
			return session;
		} catch (error) {
			this.toast("error", `新建会话失败：${errorText(error)}`);
			return undefined;
		}
	}

	findSession(sessionId: string): SessionSummary | undefined {
		for (const list of Object.values(this.state.host.sessions)) {
			const found = list?.find((s) => s.id === sessionId);
			if (found) return found;
		}
		return this.chats.get(sessionId)?.chat.session;
	}

	/** Live controller for a session (subscribed on first use). */
	chat(session: SessionSummary): ChatController | undefined {
		const client = this.client;
		if (!client) return undefined;
		let chat = this.chats.get(session.id);
		if (!chat) {
			chat = new ChatController(client, session, {
				onReplaced: (previousId, next) => {
					const existing = this.chats.get(previousId);
					if (existing) {
						this.chats.delete(previousId);
						this.chats.set(next.id, existing);
					}
					this.scheduleRefresh(next.workspaceId);
				},
				onSettled: (c) => this.scheduleRefresh(c.workspaceId),
				onChange: () => this.set((s) => ({ chatsVersion: s.chatsVersion + 1 })),
				onError: (message) => this.toast("error", message),
			});
			this.chats.set(session.id, chat);
			void chat.start();
		}
		this.recent = [session.id, ...this.recent.filter((id) => id !== session.id)];
		while (this.recent.length > MAX_LIVE_CHATS) {
			const id = this.recent.pop();
			if (!id) break;
			this.chats.get(id)?.dispose();
			this.chats.delete(id);
		}
		return chat;
	}

	draft(sessionId: string): string {
		return this.drafts.get(sessionId) ?? "";
	}

	saveDraft(sessionId: string, text: string): void {
		if (text) this.drafts.set(sessionId, text);
		else this.drafts.delete(sessionId);
	}
}

export const StoreContext = createContext<MobileStore | null>(null);

export function useStore(): MobileStore {
	const store = useContext(StoreContext);
	if (!store) throw new Error("MobileStore missing");
	return store;
}

export function useMobileState<T>(selector: (state: MobileState) => T): T {
	const store = useStore();
	return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useChatView(chat: ChatController | undefined): ChatView | undefined {
	return useSyncExternalStore(chat?.subscribe ?? noop, chat ? chat.getView : () => undefined);
}

function noop(): () => void {
	return () => {};
}
