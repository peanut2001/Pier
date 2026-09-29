import { describe, expect, it } from "vitest";
import { isYunlianProvider, newApiBaseUrl, YUNLIAN_ID, yunlianProvider } from "../src/lib/yunlian.ts";

describe("云链API provider", () => {
	it("recognises the built-in id and entries pointing at the site", () => {
		expect(isYunlianProvider({ id: YUNLIAN_ID })).toBe(true);
		const custom = { api: "openai-completions" as const, models: [], hasConfiguredKey: true };
		expect(
			isYunlianProvider({
				id: "api.yunnet.top",
				custom: { ...custom, id: "api.yunnet.top", baseUrl: "https://API.yunnet.top/v1" },
			}),
		).toBe(true);
		expect(
			isYunlianProvider({ id: "other", custom: { ...custom, id: "other", baseUrl: "https://api.example.com/v1" } }),
		).toBe(false);
		expect(isYunlianProvider({ id: "openai" })).toBe(false);
	});

	it("builds a new provider from the authorized token's models", () => {
		expect(
			yunlianProvider([{ id: "gpt-5" }, { id: "claude-opus-5", name: "Claude" }, { id: "gpt-5" }, { id: " " }]),
		).toEqual({
			id: "yunlian",
			name: "云链API",
			api: "openai-completions",
			baseUrl: "https://api.yunnet.top/v1",
			models: [{ id: "gpt-5" }, { id: "claude-opus-5", name: "Claude" }],
		});
	});

	it("keeps the existing entry's settings when signing in again", () => {
		const existing = {
			id: "api.yunnet.top",
			api: "anthropic-messages" as const,
			baseUrl: "https://api.yunnet.top",
			models: [{ id: "claude-opus-5", reasoning: true, contextWindow: 200_000 }, { id: "old" }],
		};
		expect(yunlianProvider([{ id: "claude-opus-5" }, { id: "new-model" }], existing)).toEqual({
			id: "api.yunnet.top",
			api: "anthropic-messages",
			baseUrl: "https://api.yunnet.top",
			models: [{ id: "claude-opus-5", reasoning: true, contextWindow: 200_000 }, { id: "new-model" }],
		});
		// No model list this time: keep the configured models.
		expect(yunlianProvider([], existing, "timeout").models).toEqual(existing.models);
	});

	it("fails when no models are available for a new provider", () => {
		expect(() => yunlianProvider([], undefined, "HTTP 401")).toThrow("HTTP 401");
		expect(() => yunlianProvider([])).toThrow("没有返回可用的模型");
	});

	it("derives Base URLs per wire API", () => {
		expect(newApiBaseUrl("https://api.yunnet.top/", "openai-responses")).toBe("https://api.yunnet.top/v1");
		expect(newApiBaseUrl("https://api.yunnet.top", "anthropic-messages")).toBe("https://api.yunnet.top");
		expect(newApiBaseUrl("https://api.yunnet.top", "google-generative-ai")).toBe("https://api.yunnet.top/v1beta");
	});
});
