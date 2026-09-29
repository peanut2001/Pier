import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type CatalogModel,
	fillModelEntry,
	fillModelsJsonProviders,
	ModelCapabilityIndex,
} from "../src/pi/model-capabilities.ts";

const CATALOG: CatalogModel[] = [
	{
		provider: "openrouter",
		id: "anthropic/claude-sonnet-4-5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 32_000,
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{ provider: "openai", id: "gpt-4o", reasoning: false, input: ["text", "image"], contextWindow: 128_000 },
	{ provider: "deepseek", id: "deepseek-v3.2", reasoning: true, input: ["text"], contextWindow: 128_000 },
];

describe("ModelCapabilityIndex", () => {
	const index = new ModelCapabilityIndex(CATALOG);

	it("prefers the first-party catalog entry", () => {
		expect(index.lookup("claude-sonnet-4-5")).toEqual({
			reasoning: true,
			images: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		expect(index.lookup("gpt-4o")).toEqual({ reasoning: false, images: true, contextWindow: 128_000 });
	});

	it("matches relay spellings of catalog ids", () => {
		for (const id of [
			"Claude-Sonnet-4-5",
			"anthropic/claude-sonnet-4-5",
			"claude-sonnet-4-5-20250929",
			"claude-sonnet-4.5",
			"deepseek-v3-2",
		]) {
			expect(index.lookup(id).reasoning, id).toBe(true);
		}
		expect(index.lookup("claude-sonnet-4-5-thinking").reasoning).toBe(true);
		expect(index.lookup("claude-sonnet-4-5-nothinking")).toMatchObject({ reasoning: false, images: true });
		expect(index.lookup("gpt-4o-2024-08-06")).toMatchObject({ reasoning: false, images: true });
	});

	it("falls back to well-known names and leaves the rest unknown", () => {
		expect(index.lookup("claude-opus-4-7")).toEqual({ reasoning: true, images: true });
		expect(index.lookup("o3-mini")).toEqual({ reasoning: true, images: true });
		expect(index.lookup("deepseek-reasoner")).toEqual({ reasoning: true });
		expect(index.lookup("qwen3-coder-instruct")).toEqual({});
		expect(index.lookup("my-model")).toEqual({});
	});

	it("fills only unknown fields", () => {
		expect(index.fill({ id: "claude-sonnet-4-5", reasoning: false, contextWindow: 100 })).toEqual({
			id: "claude-sonnet-4-5",
			reasoning: false,
			images: true,
			contextWindow: 100,
			maxTokens: 64_000,
		});
		expect(index.fill({ id: "my-model", name: "Mine" })).toEqual({ id: "my-model", name: "Mine" });
	});

	it("fills models.json entries without overriding present settings", () => {
		const entry = { id: "claude-sonnet-4-5", input: ["text"], compat: { x: 1 } };
		expect(fillModelEntry(index, entry)).toEqual({
			id: "claude-sonnet-4-5",
			input: ["text"],
			compat: { x: 1 },
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const explicit = { id: "claude-sonnet-4-5", reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1 };
		expect(fillModelEntry(index, explicit)).toBe(explicit);
		const unknown = { id: "my-model" };
		expect(fillModelEntry(index, unknown)).toBe(unknown);

		const providers = {
			relay: { api: "openai-completions", models: [{ id: "claude-sonnet-4-5" }, unknown] },
			openai: { models: [{ id: "gpt-4o" }] },
			empty: { api: "openai-completions" },
		};
		const result = fillModelsJsonProviders(index, providers, new Set(["openai"]));
		expect(result?.filled).toBe(1);
		expect(result?.providers.relay?.models).toEqual([
			{ id: "claude-sonnet-4-5", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000 },
			unknown,
		]);
		expect(result?.providers.openai).toBe(providers.openai);
		expect(fillModelsJsonProviders(index, { relay: { models: [unknown] } }, new Set())).toBeUndefined();
	});

	it("knows the models relays commonly offer from pi's catalog", async () => {
		const root = mkdtempSync(join(tmpdir(), "pier-capabilities-"));
		try {
			const runtime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: join(root, "models.json"),
				refreshOnCreate: false,
			});
			const real = new ModelCapabilityIndex(getBuiltinProviders().flatMap((id) => runtime.getModels(id)));
			expect(real.size).toBeGreaterThan(100);
			expect(real.lookup("claude-opus-4-5")).toMatchObject({ reasoning: true, images: true });
			expect(real.lookup("gpt-5")).toMatchObject({ reasoning: true });
			expect(real.lookup("gemini-2.5-pro")).toMatchObject({ reasoning: true });
			expect(real.lookup("gpt-4o")).toMatchObject({ reasoning: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
