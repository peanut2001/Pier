import type { ModelInfo, ThinkingLevel } from "@pier/protocol";

/** Every thinking level, lowest first, displayed using its original value. */
export const THINKING_LEVELS: ReadonlyArray<{ value: ThinkingLevel; label: string }> = [
	{ value: "off", label: "off" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max" },
	{ value: "ultra", label: "ultra" },
];

const ORDER: ThinkingLevel[] = THINKING_LEVELS.map((l) => l.value);

export function thinkingLabel(level: string): string {
	return level;
}

/** Thinking levels a model supports, lowest first. Ultra must be explicitly advertised. */
export function supportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model?.reasoning) return ["off"];
	const levels = model.thinkingLevels?.filter((l) => ORDER.includes(l));
	return levels?.length
		? [...levels].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
		: ORDER.filter((level) => level !== "ultra");
}

/** The level the host would use for `level` on a model supporting `levels` (pi's clamping). */
export function clampThinking(level: string, levels: readonly ThinkingLevel[]): ThinkingLevel {
	if (levels.includes(level as ThinkingLevel)) return level as ThinkingLevel;
	const index = ORDER.indexOf(level as ThinkingLevel);
	if (index >= 0) {
		const higher = ORDER.slice(index).find((l) => levels.includes(l));
		if (higher) return higher;
		const lower = ORDER.slice(0, index)
			.reverse()
			.find((l) => levels.includes(l));
		if (lower) return lower;
	}
	return levels[0] ?? "off";
}
