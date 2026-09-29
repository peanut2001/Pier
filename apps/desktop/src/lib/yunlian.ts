import type { CustomModel, CustomProvider, CustomProviderApi, ProviderInfo } from "@pier/protocol";

/** 云链API, a NewAPI relay offered as a built-in provider with browser sign-in. */
export const YUNLIAN_ID = "yunlian";
export const YUNLIAN_NAME = "云链API";
export const YUNLIAN_SITE = "https://api.yunnet.top";

/** Most models a custom provider may list (see `CustomProviderSchema`). */
const MAX_MODELS = 500;

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return undefined;
	}
}

/** Whether `provider` is the 云链API entry (also matches one added earlier by hand or by the NewAPI sign-in). */
export function isYunlianProvider(provider: Pick<ProviderInfo, "id" | "custom">): boolean {
	if (provider.id === YUNLIAN_ID) return true;
	const url = provider.custom?.baseUrl;
	return url !== undefined && hostOf(url) === hostOf(YUNLIAN_SITE);
}

/** Base URL of a NewAPI site for a wire API. */
export function newApiBaseUrl(siteUrl: string, api: CustomProviderApi): string {
	const root = siteUrl.replace(/\/+$/, "");
	switch (api) {
		case "anthropic-messages":
			return root;
		case "google-generative-ai":
			return `${root}/v1beta`;
		default:
			return `${root}/v1`;
	}
}

/**
 * The custom provider to save after a browser sign-in. Signing in again keeps the existing
 * entry's id, name, API type, Base URL and per-model settings, and adds the token's new models.
 */
export function yunlianProvider(
	models: ReadonlyArray<{ id: string; name?: string }>,
	existing?: CustomProvider,
	modelsError?: string,
): CustomProvider {
	const previous = new Map((existing?.models ?? []).map((m) => [m.id, m]));
	const seen = new Set<string>();
	const list: CustomModel[] = [];
	for (const model of models) {
		const id = model.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		list.push(previous.get(id) ?? { id, ...(model.name && model.name !== id ? { name: model.name } : {}) });
	}
	// The site could not list models this time: keep what was configured before.
	const kept = list.length ? list : (existing?.models ?? []);
	if (!kept.length) {
		throw new Error(modelsError ? `无法获取云链API的模型列表：${modelsError}` : "云链API 没有返回可用的模型");
	}
	const api = existing?.api ?? "openai-completions";
	return {
		id: existing?.id ?? YUNLIAN_ID,
		...(existing ? (existing.name ? { name: existing.name } : {}) : { name: YUNLIAN_NAME }),
		api,
		baseUrl: existing?.baseUrl ?? newApiBaseUrl(YUNLIAN_SITE, api),
		models: kept.slice(0, MAX_MODELS),
	};
}
