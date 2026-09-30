import type { ModelInfo, PiSettingsResult } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import { newSessionDefaultsFromSettings } from "../src/lib/new-session-defaults.ts";

const model = (provider: string, id: string): ModelInfo => ({ provider, id, name: id, reasoning: true }) as ModelInfo;
const models = [model("gpt", "gpt-6"), model("claude", "opus"), model("claude", "sonnet")];

const settings = (user: Record<string, unknown>, project?: Record<string, unknown>): PiSettingsResult => ({
	agentDir: "/home/me/.pi/agent",
	user: { scope: "user", path: "/home/me/.pi/agent/settings.json", exists: true, text: "", settings: user },
	...(project
		? {
				project: {
					scope: "project",
					path: "/work/.pi/settings.json",
					exists: true,
					text: "",
					settings: project,
					workspaceId: "w",
				},
			}
		: {}),
});

describe("new-session defaults from pi settings (hosts before 1.19)", () => {
	it("uses the configured default model and thinking level", () => {
		const result = newSessionDefaultsFromSettings(
			models,
			settings({ defaultProvider: "claude", defaultModel: "opus", defaultThinkingLevel: "high" }),
		);
		expect(result).toEqual({ current: models[1], thinkingLevel: "high" });
	});

	it("lets project settings and per-model levels win", () => {
		const result = newSessionDefaultsFromSettings(
			models,
			settings(
				{
					defaultProvider: "claude",
					defaultModel: "opus",
					defaultThinkingLevel: "high",
					modelThinkingLevels: { "claude/sonnet": "low" },
				},
				{ defaultModel: "sonnet" },
			),
		);
		expect(result).toEqual({ current: models[2], thinkingLevel: "low" });
	});

	it("falls back to the first available model when the default is unavailable", () => {
		expect(newSessionDefaultsFromSettings(models, settings({ defaultProvider: "x", defaultModel: "y" }))).toEqual({
			current: models[0],
		});
		expect(newSessionDefaultsFromSettings([], settings({}))).toEqual({});
	});

	it("ignores unknown thinking levels", () => {
		expect(newSessionDefaultsFromSettings(models, settings({ defaultThinkingLevel: "huge" }))).toEqual({
			current: models[0],
		});
	});
});
