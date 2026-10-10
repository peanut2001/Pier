import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock("../src/storage.ts", () => storage);

beforeEach(() => {
	vi.resetModules();
	storage.getItem.mockReset().mockResolvedValue(null);
	storage.setItem.mockReset().mockResolvedValue(undefined);
});

describe("device theme preference", () => {
	it.each(["light", "dark", "system", null, "invalid"])("restores %s safely", async (saved) => {
		storage.getItem.mockResolvedValue(saved);
		const theme = await import("../src/theme-preference.ts");
		await theme.initThemePreference();
		expect(theme.getThemePreference()).toBe(saved === "light" || saved === "dark" ? saved : "system");
		expect(storage.getItem).toHaveBeenCalledWith("pier.theme");
	});

	it("does not replace a choice with a late startup read", async () => {
		let finishRead!: (value: string) => void;
		storage.getItem.mockReturnValue(new Promise<string>((resolve) => (finishRead = resolve)));
		const theme = await import("../src/theme-preference.ts");
		const initializing = theme.initThemePreference();
		await theme.setThemePreference("light");
		finishRead("dark");
		await initializing;
		expect(theme.getThemePreference()).toBe("light");
	});

	it("applies immediately and writes quick changes in order", async () => {
		let finishWrite!: () => void;
		storage.setItem.mockImplementationOnce(() => new Promise<void>((resolve) => (finishWrite = resolve)));
		const theme = await import("../src/theme-preference.ts");
		const first = theme.setThemePreference("dark");
		const second = theme.setThemePreference("light");
		expect(theme.getThemePreference()).toBe("light");
		await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
		finishWrite();
		await Promise.all([first, second]);
		expect(storage.setItem.mock.calls).toEqual([
			["pier.theme", "dark"],
			["pier.theme", "light"],
		]);
	});

	it("recovers from unavailable storage and allows saving again after failure", async () => {
		storage.getItem.mockRejectedValueOnce(new Error("unavailable"));
		const theme = await import("../src/theme-preference.ts");
		await theme.initThemePreference();
		expect(theme.getThemePreference()).toBe("system");
		storage.setItem.mockRejectedValueOnce(new Error("full"));
		await expect(theme.setThemePreference("dark")).rejects.toThrow("full");
		expect(theme.getThemePreference()).toBe("system");
		await theme.setThemePreference("light");
		expect(theme.getThemePreference()).toBe("light");
	});
});
