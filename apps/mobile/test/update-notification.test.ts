import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
	platform: { OS: "android", Version: 33 },
	available: true,
	native: { show: vi.fn(), dismiss: vi.fn() },
	check: vi.fn(),
	request: vi.fn(),
	loadNative: vi.fn(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: mock.loadNative }));
vi.mock("react-native", () => ({
	Platform: mock.platform,
	PermissionsAndroid: {
		PERMISSIONS: { POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS" },
		check: mock.check,
		request: mock.request,
	},
}));

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	mock.platform.OS = "android";
	mock.platform.Version = 33;
	mock.available = true;
	mock.loadNative.mockImplementation(() => (mock.available ? mock.native : null));
	mock.check.mockResolvedValue(false);
	mock.request.mockResolvedValue("granted");
});

afterEach(() => vi.useRealTimers());

describe("Android update notification", () => {
	it("requests permission on Android 13+ only when downloading starts", async () => {
		const notification = await import("../src/update-notification.ts");
		expect(mock.check).not.toHaveBeenCalled();
		expect(mock.request).not.toHaveBeenCalled();
		await notification.prepareUpdateNotification();
		expect(mock.check).toHaveBeenCalledWith("android.permission.POST_NOTIFICATIONS");
		expect(mock.request).toHaveBeenCalledWith("android.permission.POST_NOTIFICATIONS");
		mock.check.mockResolvedValue(true);
		await notification.prepareUpdateNotification();
		expect(mock.request).toHaveBeenCalledOnce();
	});

	it("does not request permission on older Android versions", async () => {
		mock.platform.Version = 32;
		const notification = await import("../src/update-notification.ts");
		await notification.prepareUpdateNotification();
		notification.showUpdateNotification("1.2.3", "downloading", 0, 42);
		expect(mock.check).not.toHaveBeenCalled();
		expect(mock.native.show).toHaveBeenCalledWith("1.2.3", "downloading", 0, 42);
	});

	it.each(["ios", "web", "missing module"])("is optional on %s", async (platform) => {
		if (platform === "missing module") mock.available = false;
		else mock.platform.OS = platform;
		const notification = await import("../src/update-notification.ts");
		await notification.prepareUpdateNotification();
		notification.showUpdateNotification("1.2.3", "ready");
		notification.dismissUpdateNotification();
		expect(mock.check).not.toHaveBeenCalled();
		expect(mock.native.show).not.toHaveBeenCalled();
		expect(mock.native.dismiss).not.toHaveBeenCalled();
		if (platform !== "missing module") expect(mock.loadNative).not.toHaveBeenCalled();
	});

	it("throttles progress to once per second while reporting state changes immediately", async () => {
		vi.useFakeTimers();
		const notification = await import("../src/update-notification.ts");
		notification.showUpdateNotification("1.2.3", "downloading", 0, 42);
		vi.advanceTimersByTime(200);
		notification.showUpdateNotification("1.2.3", "downloading", 10, 42);
		vi.advanceTimersByTime(800);
		notification.showUpdateNotification("1.2.3", "downloading", 21, 42);
		notification.showUpdateNotification("1.2.3", "ready");
		expect(mock.native.show.mock.calls).toEqual([
			["1.2.3", "downloading", 0, 42],
			["1.2.3", "downloading", 21, 42],
			["1.2.3", "ready", 0, 0],
		]);
		notification.dismissUpdateNotification();
		notification.showUpdateNotification("1.2.3", "downloading", 0, 42);
		expect(mock.native.dismiss).toHaveBeenCalledOnce();
		expect(mock.native.show).toHaveBeenCalledTimes(4);
	});

	it("allows denied permission and notification errors without failing the updater", async () => {
		const notification = await import("../src/update-notification.ts");
		mock.request.mockResolvedValueOnce("denied");
		await expect(notification.prepareUpdateNotification()).resolves.toBeUndefined();
		mock.check.mockRejectedValueOnce(new Error("permissions unavailable"));
		await expect(notification.prepareUpdateNotification()).resolves.toBeUndefined();
		mock.native.show.mockImplementationOnce(() => {
			throw new Error("notifications unavailable");
		});
		mock.native.dismiss.mockImplementationOnce(() => {
			throw new Error("notifications unavailable");
		});
		expect(() => notification.showUpdateNotification("1.2.3", "error")).not.toThrow();
		expect(() => notification.dismissUpdateNotification()).not.toThrow();
	});
});
