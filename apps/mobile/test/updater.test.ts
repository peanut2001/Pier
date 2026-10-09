import { UPDATE_ROUTES } from "@pier/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubGlobal("__DEV__", false));

const mock = vi.hoisted(() => ({
	settings: JSON.stringify({ autoCheck: false }),
	downloaded: false,
	md5: "a".repeat(32),
	getItem: vi.fn(),
	setItem: vi.fn(),
	download: vi.fn(),
	install: vi.fn(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../src/store.ts", () => ({ APP_VERSION: "1.0.0" }));
vi.mock("../src/storage.ts", () => ({ getItem: mock.getItem, setItem: mock.setItem }));
vi.mock("expo-intent-launcher", () => ({ startActivityAsync: mock.install }));
vi.mock("expo-file-system", () => ({
	Paths: { cache: "cache" },
	Directory: class {
		exists = false;
		create() {}
		list() {
			return [];
		}
	},
	File: class {
		static downloadFileAsync = mock.download;
		contentUri = "content://pier/update.apk";
		get exists() {
			return mock.downloaded;
		}
		get size() {
			return 42;
		}
		get md5() {
			return mock.md5;
		}
		delete() {
			mock.downloaded = false;
		}
	},
}));

import { ANDROID_UPDATE_MANIFEST_URL } from "../src/update-manifest.ts";
import { MobileUpdater } from "../src/updater.ts";

const manifest = {
	version: "1.2.3",
	url: "https://github.com/yiranxiaohui/Pier/releases/download/v1.2.3/pier-mobile-v1.2.3-android.apk",
	size: 42,
	sha256: "b".repeat(64),
	md5: "a".repeat(32),
};

beforeEach(() => {
	vi.stubGlobal("__DEV__", false);
	vi.clearAllMocks();
	mock.settings = JSON.stringify({ autoCheck: false });
	mock.downloaded = false;
	mock.md5 = manifest.md5;
	mock.getItem.mockImplementation(async () => mock.settings);
	mock.setItem.mockImplementation(async (_key: string, value: string) => {
		mock.settings = value;
	});
	mock.download.mockImplementation(async () => {
		mock.downloaded = true;
	});
	mock.install.mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => manifest })),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("mobile update routes", () => {
	it.each(UPDATE_ROUTES.filter((route) => route.prefix))(
		"saves and uses the $label preset for checks and downloads",
		async (route) => {
			const updater = new MobileUpdater();
			await updater.init();
			await updater.setMirror(route.prefix);
			await vi.waitFor(() => expect(updater.getStatus().state).toBe("available"));
			expect(fetch).toHaveBeenLastCalledWith(`${route.prefix}${ANDROID_UPDATE_MANIFEST_URL}`, expect.anything());
			await updater.install();
			expect(mock.download).toHaveBeenCalledWith(
				`${route.prefix}${manifest.url}`,
				expect.anything(),
				expect.anything(),
			);
			const restored = new MobileUpdater();
			await restored.init();
			expect(restored.getStatus().mirrorPrefix).toBe(route.prefix);
		},
	);

	it("loads old settings with GitHub direct and retains other preferences", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		expect(updater.getStatus()).toMatchObject({ autoCheck: false, mirrorPrefix: "" });
		await updater.check();
		expect(fetch).toHaveBeenCalledWith(ANDROID_UPDATE_MANIFEST_URL, expect.anything());
	});

	it("uses the saved route for both the manifest and APK and preserves it across preference changes", async () => {
		mock.settings = JSON.stringify({
			autoCheck: false,
			mirrorPrefix: "https://mirror.example/",
			skippedVersion: "1.1.0",
		});
		const updater = new MobileUpdater();
		await updater.init();
		await updater.check();
		expect(fetch).toHaveBeenCalledWith(`https://mirror.example/${ANDROID_UPDATE_MANIFEST_URL}`, expect.anything());
		await updater.install();
		expect(mock.download).toHaveBeenCalledWith(
			`https://mirror.example/${manifest.url}`,
			expect.anything(),
			expect.anything(),
		);
		expect(mock.install).toHaveBeenCalledOnce();
		await updater.setAutoCheck(false);
		await updater.skip("1.2.3");
		expect(JSON.parse(mock.settings)).toEqual({
			autoCheck: false,
			mirrorPrefix: "https://mirror.example/",
			skippedVersion: "1.2.3",
		});
	});

	it("switches from a failed direct check to a mirror and can switch back", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		vi.mocked(fetch).mockRejectedValueOnce(new Error("unreachable"));
		await updater.check();
		expect(updater.getStatus().state).toBe("error");
		await updater.setMirror(" https://mirror.example/proxy ");
		await vi.waitFor(() => expect(updater.getStatus().state).toBe("available"));
		expect(fetch).toHaveBeenLastCalledWith(
			`https://mirror.example/proxy/${ANDROID_UPDATE_MANIFEST_URL}`,
			expect.anything(),
		);
		await updater.setMirror("");
		await vi.waitFor(() => expect(updater.getStatus().state).toBe("available"));
		expect(fetch).toHaveBeenLastCalledWith(ANDROID_UPDATE_MANIFEST_URL, expect.anything());
		expect(JSON.parse(mock.settings).mirrorPrefix).toBe("");
	});

	it("still rejects a damaged APK downloaded through a mirror", async () => {
		mock.settings = JSON.stringify({ autoCheck: false, mirrorPrefix: "https://mirror.example/" });
		const updater = new MobileUpdater();
		await updater.init();
		await updater.check();
		mock.md5 = "0".repeat(32);
		await updater.install();
		expect(updater.getStatus()).toMatchObject({ state: "error", error: expect.stringContaining("校验失败") });
		expect(mock.downloaded).toBe(false);
		expect(mock.install).not.toHaveBeenCalled();
	});

	it("rejects route changes while a check is active", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		let finish!: (response: unknown) => void;
		vi.mocked(fetch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}) as Promise<Response>,
		);
		const checking = updater.check();
		await expect(updater.setMirror("https://mirror.example/")).rejects.toThrow("等待");
		finish({ ok: true, json: async () => manifest });
		await checking;
		expect(updater.getStatus().mirrorPrefix).toBe("");
	});

	it("rejects route changes during a download", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		await updater.check();
		let finish!: () => void;
		mock.download.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = () => {
						mock.downloaded = true;
						resolve();
					};
				}),
		);
		const installing = updater.install();
		expect(updater.getStatus().state).toBe("downloading");
		await expect(updater.setMirror("https://mirror.example/")).rejects.toThrow("等待");
		finish();
		await installing;
		expect(mock.install).toHaveBeenCalledOnce();
	});

	it("keeps the current route when saving settings fails", async () => {
		const updater = new MobileUpdater();
		await updater.init();
		mock.setItem.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(updater.setMirror("https://mirror.example/")).rejects.toThrow("storage unavailable");
		expect(updater.getStatus().mirrorPrefix).toBe("");
		expect(fetch).not.toHaveBeenCalled();
		await updater.check();
		expect(updater.getStatus().state).toBe("available");
	});

	it("retains preferences when a stored route is invalid and rejects invalid new routes", async () => {
		mock.settings = JSON.stringify({
			autoCheck: false,
			mirrorPrefix: "http://mirror.example/",
			skippedVersion: "1.1.0",
		});
		const updater = new MobileUpdater();
		await updater.init();
		expect(updater.getStatus()).toMatchObject({ autoCheck: false, mirrorPrefix: "", skippedVersion: "1.1.0" });
		await expect(updater.setMirror("http://mirror.example/")).rejects.toThrow("HTTPS");
		expect(mock.setItem).not.toHaveBeenCalled();
	});
});
