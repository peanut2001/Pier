import { normalizeUpdateMirror, updateDownloadUrl } from "@pier/client";
import { Directory, File, Paths } from "expo-file-system";
import { startActivityAsync } from "expo-intent-launcher";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { getItem, setItem } from "./storage.ts";
import { APP_VERSION } from "./store.ts";
import {
	ANDROID_UPDATE_MANIFEST_URL,
	type AndroidUpdate,
	apkFileName,
	apkFileVersion,
	compareVersions,
	parseAndroidUpdate,
} from "./update-manifest.ts";

/**
 * In-app updates for the Android app (the APK attached to GitHub releases).
 *
 * Pier checks `latest-android.json` from the newest GitHub release shortly after launch and,
 * while the app keeps running, again when it returns to the foreground at most every few
 * hours. The user decides when to update: the APK is downloaded into the app's cache, its
 * size and digest are checked against the manifest, and it is handed to the system package
 * installer. Android itself verifies the APK signature and only replaces the installed app
 * with an APK signed by the same Pier release key, so a tampered download cannot be
 * installed over it. Installing needs the user's confirmation; the first time, Android also
 * asks to allow Pier to install apps.
 *
 * iOS (no signed builds yet), the web build and development builds cannot update themselves.
 */

export type UpdateState =
	/** iOS, web, or a development build. */
	| "unsupported"
	/** Not checked yet. */
	| "idle"
	| "checking"
	| "upToDate"
	/** A newer version is available (`update`). */
	| "available"
	| "downloading"
	/** The APK for `update` is downloaded and verified. */
	| "ready"
	/** The system installer is open. */
	| "installing"
	/** The last check, download, or install failed (`error`). If `update` is set, it can be retried. */
	| "error";

export interface UpdateStatus {
	state: UpdateState;
	currentVersion: string;
	/** Why updates are unavailable (state `unsupported`). */
	unsupportedReason?: string;
	autoCheck: boolean;
	mirrorPrefix: string;
	update?: AndroidUpdate;
	/** The user chose not to be reminded of this version. */
	skippedVersion?: string;
	downloaded: number;
	total?: number;
	error?: string;
	/** Unix time (ms) of the last successful check. */
	lastChecked?: number;
}

interface Settings {
	autoCheck: boolean;
	mirrorPrefix: string;
	skippedVersion?: string;
}

const SETTINGS_KEY = "pier.updater";
const FIRST_CHECK_DELAY_MS = 4_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After a failed automatic check. */
const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 200;
const APK_MIME = "application/vnd.android.package-archive";
const FLAG_GRANT_READ_URI_PERMISSION = 1;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function unsupportedReason(): string | undefined {
	if (Platform.OS === "ios") return "iOS 版暂不支持应用内更新。";
	if (Platform.OS !== "android") return "只有 Android 版支持应用内更新。";
	if (__DEV__) return "开发版本不支持应用内更新。";
	return undefined;
}

async function fetchManifest(mirrorPrefix: string, controller: AbortController): Promise<AndroidUpdate> {
	if (controller.signal.aborted) throw new Error("检查已取消");
	let stop!: (error: Error) => void;
	const stopped = new Promise<never>((_, reject) => {
		stop = reject;
	});
	const onAbort = () => stop(new Error("检查已取消"));
	controller.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		// Reject our wait even if the native fetch ignores abort or the response body stalls.
		stop(new Error("连接超时，请切换更新线路后重试"));
		controller.abort();
	}, CHECK_TIMEOUT_MS);
	try {
		const request = async () => {
			const response = await fetch(updateDownloadUrl(ANDROID_UPDATE_MANIFEST_URL, mirrorPrefix), {
				headers: { Accept: "application/json", "Cache-Control": "no-cache" },
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return parseAndroidUpdate(await response.json());
		};
		return await Promise.race([request(), stopped]);
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", onAbort);
	}
}

export class MobileUpdater {
	private status: UpdateStatus;
	private readonly listeners = new Set<() => void>();
	private initialized = false;
	private download: AbortController | undefined;
	private checking: { controller: AbortController; previous: UpdateStatus } | undefined;
	private savingMirror = false;
	/** Earliest time (ms) of the next automatic check; 0 until the first one is scheduled. */
	private nextAutoCheck = 0;

	constructor() {
		const reason = unsupportedReason();
		this.status = {
			state: reason ? "unsupported" : "idle",
			currentVersion: APP_VERSION,
			...(reason ? { unsupportedReason: reason } : {}),
			autoCheck: true,
			mirrorPrefix: "",
			downloaded: 0,
		};
	}

	getStatus = (): UpdateStatus => this.status;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private set(patch: Partial<UpdateStatus>): void {
		this.status = { ...this.status, ...patch };
		for (const listener of [...this.listeners]) listener();
	}

	get supported(): boolean {
		return this.status.state !== "unsupported";
	}

	private get busy(): boolean {
		const { state } = this.status;
		return this.savingMirror || state === "checking" || state === "downloading" || state === "installing";
	}

	/** Load the settings, drop stale downloads, and schedule the first automatic check. */
	async init(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		const settings = await this.loadSettings();
		this.set({
			autoCheck: settings.autoCheck,
			mirrorPrefix: settings.mirrorPrefix,
			...(settings.skippedVersion ? { skippedVersion: settings.skippedVersion } : {}),
		});
		if (!this.supported) return;
		this.removeDownloads((version) => compareVersions(version, APP_VERSION) <= 0);
		if (settings.autoCheck) {
			this.nextAutoCheck = Date.now() + FIRST_CHECK_DELAY_MS;
			setTimeout(() => {
				if (this.status.autoCheck) void this.check(true);
			}, FIRST_CHECK_DELAY_MS);
		}
	}

	/** Check again when the app returns to the foreground and the last check is old enough. */
	onForeground(): void {
		if (!this.initialized || !this.status.autoCheck || !this.supported || this.busy) return;
		if (!this.nextAutoCheck || Date.now() < this.nextAutoCheck) return;
		void this.check(true);
	}

	/** Check the release manifest. `auto` checks keep a known update when they fail. */
	async check(auto = false): Promise<void> {
		if (!this.supported || this.busy) return;
		const previous = this.status;
		const request = { controller: new AbortController(), previous };
		this.checking = request;
		this.set({ state: "checking", error: undefined });
		this.nextAutoCheck = Date.now() + CHECK_INTERVAL_MS;
		try {
			const update = await fetchManifest(this.status.mirrorPrefix, request.controller);
			if (this.checking !== request) return;
			const lastChecked = Date.now();
			if (compareVersions(update.version, APP_VERSION) <= 0) {
				this.set({ state: "upToDate", update: undefined, downloaded: 0, total: undefined, lastChecked });
				this.removeDownloads(() => true);
				return;
			}
			const ready = this.verified(update);
			this.set({ state: ready ? "ready" : "available", update, downloaded: 0, total: undefined, lastChecked });
			this.removeDownloads((version) => version !== update.version);
		} catch (error) {
			if (this.checking !== request) return;
			this.nextAutoCheck = Date.now() + RETRY_INTERVAL_MS;
			if (auto && previous.update) {
				this.set({ state: previous.state === "ready" ? "ready" : "available" });
				return;
			}
			this.set({ state: "error", error: `检查更新失败：${errorText(error)}` });
		} finally {
			if (this.checking === request) this.checking = undefined;
		}
	}

	/** Stop waiting immediately; late results from this request cannot change the current state. */
	cancelCheck(): void {
		const request = this.checking;
		if (!request) return;
		this.checking = undefined;
		request.controller.abort();
		const { state, update, error, downloaded, total } = request.previous;
		this.set({ state, update, error, downloaded, total });
	}

	/** Download (unless already downloaded) and verify the update, then open the system installer. */
	async install(): Promise<void> {
		const update = this.status.update;
		if (!update || this.busy) return;
		const file = this.apkFile(update.version);
		if (!this.verified(update) && !(await this.fetchApk(update, file))) return;
		this.set({ state: "installing", error: undefined });
		try {
			await startActivityAsync("android.intent.action.VIEW", {
				data: file.contentUri,
				type: APK_MIME,
				flags: FLAG_GRANT_READ_URI_PERMISSION,
			});
			// Back from the installer without being replaced: cancelled or failed; allow a retry.
			this.set({ state: "ready" });
		} catch (error) {
			this.set({ state: "error", error: `无法打开系统安装程序：${errorText(error)}` });
		}
	}

	/** Stop a running download. */
	cancel(): void {
		this.download?.abort();
	}

	async setAutoCheck(enabled: boolean): Promise<void> {
		this.set({ autoCheck: enabled });
		if (!enabled) this.cancelCheck();
		await this.saveSettings();
		if (enabled && this.supported && (this.status.state === "idle" || this.status.state === "error")) {
			void this.check(true);
		}
	}

	async setMirror(prefix: string): Promise<void> {
		if (this.savingMirror || this.status.state === "downloading" || this.status.state === "installing") {
			throw new Error("请等待当前更新操作结束后再切换线路");
		}
		const mirrorPrefix = normalizeUpdateMirror(prefix);
		this.savingMirror = true;
		try {
			const { autoCheck, skippedVersion } = this.status;
			await setItem(SETTINGS_KEY, JSON.stringify({ autoCheck, skippedVersion, mirrorPrefix }));
			this.cancelCheck();
			this.set({ mirrorPrefix });
		} finally {
			this.savingMirror = false;
		}
		void this.check();
	}

	/** Stop reminding about this version (or remind again with `undefined`). */
	async skip(version: string | undefined): Promise<void> {
		this.set({ skippedVersion: version });
		await this.saveSettings();
	}

	private async fetchApk(update: AndroidUpdate, file: File): Promise<boolean> {
		const controller = new AbortController();
		this.download = controller;
		this.set({ state: "downloading", downloaded: 0, total: update.size, error: undefined });
		let lastProgress = 0;
		try {
			const dir = this.downloadDir();
			dir.create({ intermediates: true, idempotent: true });
			this.removeDownloads(() => true);
			await File.downloadFileAsync(updateDownloadUrl(update.url, this.status.mirrorPrefix), file, {
				idempotent: true,
				signal: controller.signal,
				onProgress: ({ bytesWritten, totalBytes }) => {
					const now = Date.now();
					if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
					lastProgress = now;
					this.set({ downloaded: bytesWritten, total: totalBytes > 0 ? totalBytes : update.size });
				},
			});
			if (!this.verified(update)) {
				throw new Error(`安装包校验失败（大小 ${file.size} 字节，应为 ${update.size} 字节），请重试`);
			}
			this.set({ state: "ready", downloaded: update.size, total: update.size });
			return true;
		} catch (error) {
			this.deleteQuietly(file);
			if (isAbort(error) || controller.signal.aborted) {
				this.set({ state: "available", downloaded: 0, total: undefined });
			} else {
				this.set({ state: "error", error: `下载更新失败：${errorText(error)}` });
			}
			return false;
		} finally {
			if (this.download === controller) this.download = undefined;
		}
	}

	private downloadDir(): Directory {
		return new Directory(Paths.cache, "updates");
	}

	private apkFile(version: string): File {
		return new File(this.downloadDir(), apkFileName(version));
	}

	/** The APK for `update` is in the cache with the expected size and digest. */
	private verified(update: AndroidUpdate): boolean {
		try {
			const file = this.apkFile(update.version);
			return file.exists && file.size === update.size && file.md5?.toLowerCase() === update.md5;
		} catch {
			return false;
		}
	}

	/** Delete downloaded APKs (and leftovers) whose version matches `stale`. */
	private removeDownloads(stale: (version: string) => boolean): void {
		try {
			const dir = this.downloadDir();
			if (!dir.exists) return;
			for (const entry of dir.list()) {
				const version = entry instanceof File ? apkFileVersion(entry.name) : undefined;
				if (version === undefined || stale(version)) this.deleteQuietly(entry);
			}
		} catch {
			// The cache is best effort; Android may also clear it on its own.
		}
	}

	private deleteQuietly(entry: File | Directory): void {
		try {
			if (entry.exists) entry.delete();
		} catch {
			// Ignore: a stale file is replaced by the next download.
		}
	}

	private async loadSettings(): Promise<Settings> {
		try {
			const raw = await getItem(SETTINGS_KEY);
			const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
			let mirrorPrefix = "";
			try {
				if (typeof parsed.mirrorPrefix === "string") mirrorPrefix = normalizeUpdateMirror(parsed.mirrorPrefix);
			} catch {
				// A damaged route setting must not reset the user's other update preferences.
			}
			return {
				autoCheck: parsed.autoCheck !== false,
				mirrorPrefix,
				...(typeof parsed.skippedVersion === "string" ? { skippedVersion: parsed.skippedVersion } : {}),
			};
		} catch {
			return { autoCheck: true, mirrorPrefix: "" };
		}
	}

	private async saveSettings(): Promise<void> {
		const { autoCheck, mirrorPrefix, skippedVersion } = this.status;
		const settings: Settings = { autoCheck, mirrorPrefix, ...(skippedVersion ? { skippedVersion } : {}) };
		await setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => undefined);
	}
}

export const updater = new MobileUpdater();

export function useUpdateStatus(): UpdateStatus {
	return useSyncExternalStore(updater.subscribe, updater.getStatus);
}

/** An update the home screen should point out (not skipped by the user). */
export function pendingUpdate(status: UpdateStatus): AndroidUpdate | undefined {
	const { update, state, skippedVersion } = status;
	if (!update || update.version === skippedVersion) return undefined;
	return state === "unsupported" || state === "upToDate" ? undefined : update;
}
