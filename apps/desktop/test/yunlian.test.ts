import { describe, expect, it } from "vitest";
import {
	findYunlianGroupProvider,
	formatQuota,
	isYunlianProvider,
	legacyYunlianGroupId,
	newApiBaseUrl,
	relayProvider,
	YUNLIAN_ID,
	yunlianGroupId,
	yunlianGroupOf,
	yunlianProvider,
} from "../src/lib/yunlian.ts";

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
			models: [
				{ id: "claude-opus-5", reasoning: true, contextWindow: 200_000 },
				{ id: "new-model", api: "openai-completions" },
			],
		});
		// No model list this time: keep the configured models.
		expect(yunlianProvider([], existing, "timeout").models).toEqual(existing.models);
	});

	it("calls each model with the wire API the site detected", () => {
		const provider = yunlianProvider([
			{ id: "gpt-5", api: "openai-completions" },
			{ id: "claude-opus-5", api: "anthropic-messages" },
			{ id: "other" },
		]);
		expect(provider.api).toBe("openai-completions");
		expect(provider.models).toEqual([
			{ id: "gpt-5" },
			{ id: "claude-opus-5", api: "anthropic-messages" },
			{ id: "other" },
		]);

		// Re-importing applies what the site says now and keeps other per-model settings.
		const existing = {
			id: "yunlian",
			api: "openai-completions" as const,
			baseUrl: "https://api.yunnet.top/v1",
			models: [
				{ id: "claude-opus-5", reasoning: true },
				{ id: "gpt-5" },
				{ id: "manual", api: "openai-responses" as const },
			],
		};
		expect(
			yunlianProvider([{ id: "claude-opus-5", api: "anthropic-messages" }, { id: "gpt-5" }, { id: "manual" }], existing)
				.models,
		).toEqual([
			{ id: "claude-opus-5", reasoning: true, api: "anthropic-messages" },
			{ id: "gpt-5" },
			{ id: "manual", api: "openai-responses" },
		]);
		// On an Anthropic provider, Claude models need no override.
		expect(
			yunlianProvider(
				[
					{ id: "claude-opus-5", api: "anthropic-messages" },
					{ id: "gpt-5", api: "openai-completions" },
				],
				{
					...existing,
					api: "anthropic-messages",
					baseUrl: "https://api.yunnet.top",
				},
			).models,
		).toEqual([
			{ id: "claude-opus-5", reasoning: true },
			{ id: "gpt-5", api: "openai-completions" },
		]);
	});

	it("makes a group of Claude models an Anthropic Messages provider", () => {
		const claude = [
			{ id: "claude-opus-5", api: "anthropic-messages" as const },
			{ id: "claude-sonnet-5", api: "anthropic-messages" as const },
		];
		const target = { id: "yunlian-claude", name: "云链API · Claude", siteUrl: "https://api.yunnet.top" };
		expect(relayProvider(target, claude)).toEqual({
			id: "yunlian-claude",
			name: "云链API · Claude",
			api: "anthropic-messages",
			baseUrl: "https://api.yunnet.top",
			models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
		});

		// Saved by an earlier release as Chat Completions with per-model overrides: switched over.
		const saved = {
			id: "yunlian-claude",
			name: "云链API · Claude",
			api: "openai-completions" as const,
			baseUrl: "https://api.yunnet.top/v1/",
			models: [
				{ id: "claude-opus-5", api: "anthropic-messages" as const, reasoning: true },
				{ id: "claude-sonnet-5", api: "anthropic-messages" as const },
			],
		};
		expect(relayProvider(target, claude, saved)).toEqual({
			id: "yunlian-claude",
			name: "云链API · Claude",
			api: "anthropic-messages",
			baseUrl: "https://api.yunnet.top",
			models: [{ id: "claude-opus-5", reasoning: true }, { id: "claude-sonnet-5" }],
		});
		// Even when the site cannot list models this time.
		expect(relayProvider(target, [], saved, "timeout").api).toBe("anthropic-messages");

		// A Base URL changed by hand keeps the provider's API.
		const proxied = { ...saved, baseUrl: "https://proxy.example.com/v1" };
		expect(relayProvider(target, claude, proxied)).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://proxy.example.com/v1",
			models: [
				{ id: "claude-opus-5", api: "anthropic-messages" },
				{ id: "claude-sonnet-5", api: "anthropic-messages" },
			],
		});
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

describe("personal center helpers", () => {
	it("maps groups to provider ids", () => {
		expect(yunlianGroupId("vip")).toBe("yunlian-vip");
		expect(yunlianGroupId("Claude Max")).toMatch(/^yunlian-claude-max-[a-z0-9]+$/);
		expect(yunlianGroupId("企业")).toMatch(/^yunlian-g-[a-z0-9]+$/);
		expect(yunlianGroupId("企业")).not.toBe(yunlianGroupId("默认"));
		const long = "x".repeat(80);
		for (const id of [yunlianGroupId(long), yunlianGroupId(`${long}企业`)]) {
			expect(id.length).toBeLessThanOrEqual(64);
			expect(id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
		}
		const custom = { api: "openai-completions" as const, baseUrl: "https://api.yunnet.top/v1", models: [] };
		expect(
			yunlianGroupOf({ id: "yunlian-vip", custom: { ...custom, id: "yunlian-vip", hasConfiguredKey: true } }),
		).toBe("vip");
		expect(yunlianGroupOf({ id: "yunlian", custom: { ...custom, id: "yunlian", hasConfiguredKey: true } })).toBe(
			undefined,
		);
		expect(isYunlianProvider({ id: "yunlian-vip" })).toBe(true);
	});

	it("gives groups whose slugs collide separate providers", () => {
		const groups = ["Claude", "claude企业级", "claude"];
		expect(new Set(groups.map(yunlianGroupId)).size).toBe(groups.length);
		// Up to 0.2.11 all three mapped to `yunlian-claude`.
		expect(new Set(groups.map(legacyYunlianGroupId))).toEqual(new Set(["yunlian-claude"]));
	});

	it("finds providers saved under the old ids", () => {
		const saved = (id: string, name: string) => [id, { id, name }] as const;
		const site = "云链API";
		const old = new Map([
			saved("yunlian-claude", "云链API · Claude"),
			saved("yunlian-claude-max", "云链API · Claude Max"),
		]);
		const groups = ["Claude", "claude企业级", "Claude Max"];
		expect(findYunlianGroupProvider(old, "Claude", groups, site)?.id).toBe("yunlian-claude");
		expect(findYunlianGroupProvider(old, "claude企业级", groups, site)).toBeUndefined();
		expect(findYunlianGroupProvider(old, "Claude Max", groups, site)?.id).toBe("yunlian-claude-max");
		// Without a colliding group the old id is used whatever its name.
		const renamed = new Map([saved("yunlian-claude", "My relay")]);
		expect(findYunlianGroupProvider(renamed, "Claude", ["Claude"], site)?.id).toBe("yunlian-claude");
		// A provider under the new id wins.
		const both = new Map([...old, saved(yunlianGroupId("claude企业级"), "云链API · claude企业级")]);
		expect(findYunlianGroupProvider(both, "claude企业级", groups, site)?.id).toBe(yunlianGroupId("claude企业级"));
		expect(findYunlianGroupProvider(both, "Claude", groups, site)?.id).toBe("yunlian-claude");
		// `claude` now owns `yunlian-claude`, but not while it holds the old `Claude` provider.
		const cased = ["Claude", "claude"];
		expect(findYunlianGroupProvider(old, "claude", cased, site)).toBeUndefined();
		expect(findYunlianGroupProvider(old, "Claude", cased, site)?.id).toBe("yunlian-claude");
	});

	it("builds a group provider", () => {
		expect(
			relayProvider({ id: "yunlian-vip", name: "云链API · vip", siteUrl: "https://api.yunnet.top" }, [{ id: "m" }]),
		).toEqual({
			id: "yunlian-vip",
			name: "云链API · vip",
			api: "openai-completions",
			baseUrl: "https://api.yunnet.top/v1",
			models: [{ id: "m" }],
		});
	});

	it("formats quota like the site", () => {
		expect(formatQuota(3_500_000, { perUnit: 500_000, type: "USD" })).toBe("$7.00");
		expect(formatQuota(3_500_000, { perUnit: 500_000, type: "CNY", usdRate: 7 })).toBe("¥49.00");
		expect(formatQuota(1_000, { perUnit: 500_000, type: "USD" })).toBe("$0.0020");
		expect(formatQuota(500_000, { perUnit: 500_000, type: "CUSTOM", customSymbol: "€", customRate: 0.9 })).toBe(
			"€0.90",
		);
		expect(formatQuota(1_234_567, { perUnit: 500_000, type: "TOKENS" })).toBe("1,234,567");
		expect(formatQuota(-500_000, { perUnit: 500_000, type: "USD" })).toBe("-$1.00");
	});
});
