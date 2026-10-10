import { describe, expect, it } from "vitest";
import { normalizeUpdateMirror, updateDownloadUrl } from "../src/update-route.ts";

describe("update routes", () => {
	it("uses the selected route for manifests and release assets", () => {
		for (const path of [
			"latest/download/latest.json",
			"latest/download/latest-android.json",
			"download/v1.2.3/pier-mobile-v1.2.3-android.apk",
		]) {
			const original = `https://github.com/yiranxiaohui/Pier/releases/${path}`;
			expect(updateDownloadUrl(original, "")).toBe(original);
			expect(updateDownloadUrl(original, " https://mirror.example/proxy/// ")).toBe(
				`https://mirror.example/proxy/${original}`,
			);
		}
	});

	it("preserves custom endpoints and already mirrored addresses", () => {
		for (const original of [
			"https://updates.example/latest.json",
			"https://mirror.example/https://github.com/o/r/a",
			"https://github.com.evil.example/o/r/a",
		]) {
			expect(updateDownloadUrl(original, "https://mirror.example/")).toBe(original);
		}
	});

	it("accepts HTTPS prefixes and rejects ambiguous or credential-bearing addresses", () => {
		expect(normalizeUpdateMirror("  ")).toBe("");
		expect(normalizeUpdateMirror(" https://mirror.example/proxy ")).toBe("https://mirror.example/proxy/");
		for (const prefix of [
			"http://mirror.example",
			"file:///tmp",
			"example.com",
			"https://user:pass@mirror.example",
			"https://mirror.example/?token=x",
			"https://mirror.example/#x",
			"https://mirror.example/a b",
			"https://mirror.example\\proxy",
		]) {
			expect(() => normalizeUpdateMirror(prefix), prefix).toThrow(/HTTPS/);
		}
	});
});
