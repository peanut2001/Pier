import { type ModelInfo, type PiSettingsResult, type ThinkingLevel, ThinkingLevelSchema } from "@pier/protocol";

/**
 * The model and thinking level a new pi session starts with, worked out from the pi settings
 * of its workspace, for hosts before protocol 1.19 whose `model.list` does not report them.
 * Mirrors pi's resolution: the project settings override the user's; the configured default
 * model when it is available (listed), otherwise the first available model; then that model's
 * own thinking level or the default level.
 */
export function newSessionDefaultsFromSettings(
	models: ModelInfo[],
	settings: PiSettingsResult | undefined,
): { current?: ModelInfo; thinkingLevel?: ThinkingLevel } {
	const files = [settings?.project?.settings, settings?.user.settings];
	const setting = (key: string): unknown => files.find((s) => s && s[key] !== undefined)?.[key];
	const provider = setting("defaultProvider");
	const modelId = setting("defaultModel");
	const current =
		(typeof provider === "string" && typeof modelId === "string"
			? models.find((m) => m.provider === provider && m.id === modelId)
			: undefined) ?? models[0];
	if (!current) return {};
	const key = `${current.provider}/${current.id}`;
	const perModel = files
		.map((s) => s?.modelThinkingLevels)
		.map((levels) => (levels && typeof levels === "object" ? (levels as Record<string, unknown>)[key] : undefined))
		.find((level) => level !== undefined);
	const level = ThinkingLevelSchema.safeParse(perModel ?? setting("defaultThinkingLevel"));
	return level.success ? { current, thinkingLevel: level.data } : { current };
}
