import type { ModelInfo } from "@pier/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	clampThinking,
	loadArgumentOptions,
	type SlashTarget,
	supportedThinkingLevels,
	thinkingLabel,
} from "../src/index.ts";

const opus: ModelInfo = {
	provider: "claude",
	id: "claude-opus-5-5",
	name: "claude-opus-5-5",
	reasoning: true,
	input: ["text"],
	thinkingLevels: ["max", "low", "medium", "high", "xhigh"],
};

describe("thinking levels", () => {
	it("follows the levels the model supports, lowest first", () => {
		expect(supportedThinkingLevels(opus)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(supportedThinkingLevels({ ...opus, thinkingLevels: undefined })).toHaveLength(7);
		expect(supportedThinkingLevels({ ...opus, reasoning: false })).toEqual(["off"]);
		expect(supportedThinkingLevels(undefined)).toEqual(["off"]);
	});

	it("clamps like pi: the next supported level up, else down", () => {
		const levels = supportedThinkingLevels(opus);
		expect(clampThinking("high", levels)).toBe("high");
		expect(clampThinking("off", levels)).toBe("low");
		expect(clampThinking("max", ["off", "low"])).toBe("low");
		expect(clampThinking("weird", levels)).toBe("low");
	});

	it("displays the original thinking level", () => {
		expect(thinkingLabel("xhigh")).toBe("xhigh");
		expect(thinkingLabel("custom")).toBe("custom");
	});

	it("offers only the model's levels for /thinking", async () => {
		const target = {
			chat: { model: opus, thinkingLevel: "off", runState: "idle" },
			listModels: async () => ({ models: [opus] }),
			setModel: vi.fn(),
			setThinking: vi.fn(),
			compact: vi.fn(),
			forkPoints: async () => ({ points: [] }),
			rename: vi.fn(),
			reload: vi.fn(),
		} satisfies SlashTarget;
		const options = await loadArgumentOptions(target, "thinking");
		expect(options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(options.find((o) => o.selected)?.value).toBe("low");
	});
});
