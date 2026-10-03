import type { ModelInfo, ThinkingLevel } from "@pier/protocol";

/** Every thinking level, lowest first, with the label the clients show. */
export const THINKING_LEVELS: ReadonlyArray<{ value: ThinkingLevel; label: string }> = [
	{ value: "off", label: "不思考" },
	{ value: "minimal", label: "极少" },
	{ value: "low", label: "低" },
	{ value: "medium", label: "中" },
	{ value: "high", label: "高" },
	{ value: "xhigh", label: "很高" },
	{ value: "max", label: "最高" },
];

const ORDER: ThinkingLevel[] = THINKING_LEVELS.map((l) => l.value);

export function thinkingLabel(level: string): string {
	return THINKING_LEVELS.find((l) => l.value === level)?.label ?? level;
}

/** Thinking levels a model supports, lowest first (all of them for hosts before protocol 1.19). */
export function supportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model?.reasoning) return ["off"];
	const levels = model.thinkingLevels?.filter((l) => ORDER.includes(l));
	return levels?.length ? [...levels].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)) : [...ORDER];
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
