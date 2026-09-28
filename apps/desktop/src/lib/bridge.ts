/**
 * Bridge between the UI and its shell.
 *
 * In the Tauri app the Rust side owns the Pier Host sidecar and reports its status.
 * In a plain browser (UI development, automated tests) the UI connects to an already
 * running host given by `?url=ws://127.0.0.1:<port>&token=<token>`.
 */

export type HostState = "starting" | "ready" | "restarting" | "failed" | "stopped";

export interface HostStatus {
	state: HostState;
	url?: string | null;
	token?: string | null;
	pid?: number | null;
	version?: string | null;
	protocolVersion?: string | null;
	error?: string | null;
	restarts: number;
	generation: number;
}

export interface Bridge {
	kind: "tauri" | "browser";
	status(): Promise<HostStatus>;
	onStatus(listener: (status: HostStatus) => void): () => void;
	logs(): Promise<string[]>;
	onLog(listener: (line: string) => void): () => void;
	restartHost(): Promise<void>;
	/** Ask the user for a directory. Resolves to an absolute path, or null when cancelled. */
	pickDirectory(): Promise<string | null>;
	openExternal(url: string): Promise<void>;
	quit(): Promise<void>;
	updates: UpdateBridge;
}

export type UpdateState =
	| "unsupported"
	| "idle"
	| "checking"
	| "upToDate"
	| "available"
	| "downloading"
	| "installing"
	| "error";

/** Mirrors `UpdateStatus` in `src-tauri/src/updater.rs`. */
export interface UpdateStatus {
	state: UpdateState;
	currentVersion: string;
	autoCheck: boolean;
	/** The available (or still pending, after a failed install) update. */
	version?: string | null;
	notes?: string | null;
	date?: string | null;
	downloaded: number;
	total?: number | null;
	error?: string | null;
	/** Unix time (ms) of the last successful check. */
	lastChecked?: number | null;
}

export interface UpdateBridge {
	status(): Promise<UpdateStatus>;
	onStatus(listener: (status: UpdateStatus) => void): () => void;
	/** The tray menu asks for the update dialog. */
	onOpen(listener: () => void): () => void;
	check(): Promise<UpdateStatus>;
	/** Download, install, and relaunch. Rejects with the reason when it fails. */
	install(): Promise<void>;
	setAutoCheck(enabled: boolean): Promise<UpdateStatus>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function tauriBridge(): Bridge {
	const core = import("@tauri-apps/api/core");
	const event = import("@tauri-apps/api/event");
	const listen = <T>(name: string, listener: (payload: T) => void) => {
		let unlisten: (() => void) | undefined;
		let disposed = false;
		void event.then(({ listen }) =>
			listen<T>(name, (e) => listener(e.payload)).then((fn) => {
				if (disposed) fn();
				else unlisten = fn;
			}),
		);
		return () => {
			disposed = true;
			unlisten?.();
		};
	};
	return {
		kind: "tauri",
		status: async () => (await core).invoke<HostStatus>("host_status"),
		onStatus: (listener) => listen<HostStatus>("pier://host-status", listener),
		logs: async () => (await core).invoke<string[]>("host_logs"),
		onLog: (listener) => listen<string>("pier://host-log", listener),
		restartHost: async () => (await core).invoke("host_restart"),
		pickDirectory: async () => {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const result = await open({ directory: true, multiple: false, title: "选择工作区目录" });
			return typeof result === "string" ? result : null;
		},
		openExternal: async (url) => {
			const { openUrl } = await import("@tauri-apps/plugin-opener");
			await openUrl(url);
		},
		quit: async () => (await core).invoke("quit_app"),
		updates: {
			status: async () => (await core).invoke<UpdateStatus>("update_status"),
			onStatus: (listener) => listen<UpdateStatus>("pier://update-status", listener),
			onOpen: (listener) => listen<null>("pier://update-open", () => listener()),
			check: async () => (await core).invoke<UpdateStatus>("update_check"),
			install: async () => (await core).invoke("update_install"),
			setAutoCheck: async (enabled) => (await core).invoke<UpdateStatus>("update_set_auto_check", { enabled }),
		},
	};
}

function browserBridge(): Bridge {
	const params = new URLSearchParams(window.location.search);
	const url = params.get("url") ?? import.meta.env.VITE_PIER_URL ?? null;
	const token = params.get("token") ?? import.meta.env.VITE_PIER_TOKEN ?? null;
	const status: HostStatus = url
		? { state: "ready", url, token, restarts: 0, generation: 1 }
		: {
				state: "stopped",
				error: "浏览器模式：请在地址后附加 ?url=ws://127.0.0.1:<端口>&token=<token>（见 ~/.pier/run/host.json）",
				restarts: 0,
				generation: 0,
			};
	return {
		kind: "browser",
		status: async () => status,
		onStatus: () => () => {},
		logs: async () => ["浏览器模式下没有 Host 日志；Host 由外部进程运行。"],
		onLog: () => () => {},
		restartHost: async () => window.location.reload(),
		pickDirectory: async () => window.prompt("工作区目录的绝对路径")?.trim() || null,
		openExternal: async (target) => {
			window.open(target, "_blank", "noopener,noreferrer");
		},
		quit: async () => window.close(),
		updates: params.get("updates") === "demo" ? demoUpdates() : unsupportedUpdates,
	};
}

const unsupported: UpdateStatus = {
	state: "unsupported",
	currentVersion: "dev",
	autoCheck: false,
	downloaded: 0,
};

const unsupportedUpdates: UpdateBridge = {
	status: async () => unsupported,
	onStatus: () => () => {},
	onOpen: () => () => {},
	check: async () => unsupported,
	install: async () => {
		throw new Error("浏览器模式不支持自动更新");
	},
	setAutoCheck: async () => unsupported,
};

/** `?updates=demo`: a fake update feed for working on the update UI in a browser. */
function demoUpdates(): UpdateBridge {
	const listeners = new Set<(status: UpdateStatus) => void>();
	let status: UpdateStatus = { state: "idle", currentVersion: "0.1.0", autoCheck: true, downloaded: 0 };
	const set = (patch: Partial<UpdateStatus>) => {
		status = { ...status, ...patch };
		for (const listener of listeners) listener(status);
		return status;
	};
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	return {
		status: async () => status,
		onStatus: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onOpen: () => () => {},
		check: async () => {
			set({ state: "checking" });
			await sleep(800);
			return set({
				state: "available",
				version: "9.9.9",
				date: new Date().toISOString(),
				notes:
					"### Added\n\n- **Auto update** for the desktop app.\n- Faster session loading.\n\n### Fixed\n\n- Reconnects after sleep.",
				error: null,
				lastChecked: Date.now(),
			});
		},
		install: async () => {
			const total = 48 * 1024 * 1024;
			for (let downloaded = 0; downloaded <= total; downloaded += total / 20) {
				set({ state: "downloading", downloaded, total });
				await sleep(120);
			}
			set({ state: "installing" });
			await sleep(1000);
			const error = "安装更新失败：浏览器演示模式不会真正安装";
			set({ state: "error", error });
			throw new Error(error);
		},
		setAutoCheck: async (enabled) => set({ autoCheck: enabled }),
	};
}

export const bridge: Bridge = isTauri ? tauriBridge() : browserBridge();
