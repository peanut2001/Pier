import {
	type AccountQuotaDisplay,
	type CustomModel,
	type CustomProvider,
	type CustomProviderApi,
	type NewApiModel,
	type ProviderInfo,
	YUNLIAN_SITE_URL,
} from "@pier/protocol";

/** 云链API, a NewAPI relay offered as a built-in provider and the personal center's site. */
export const YUNLIAN_ID = "yunlian";
export const YUNLIAN_NAME = "云链API";
export const YUNLIAN_SITE = YUNLIAN_SITE_URL;
/** Prefix of the providers the personal center configures, one per group. */
const GROUP_PREFIX = `${YUNLIAN_ID}-`;

/** Most models a custom provider may list (see `CustomProviderSchema`). */
const MAX_MODELS = 500;

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return undefined;
	}
}

/**
 * Whether `provider` uses 云链API: the browser sign-in entry, a group configured in the personal
 * center, or one added earlier by hand or by the NewAPI sign-in.
 */
export function isYunlianProvider(provider: Pick<ProviderInfo, "id" | "custom">): boolean {
	if (provider.id === YUNLIAN_ID || provider.id.startsWith(GROUP_PREFIX)) return true;
	const url = provider.custom?.baseUrl;
	return url !== undefined && hostOf(url) === hostOf(YUNLIAN_SITE);
}

/** The group a personal-center provider was configured for, if it is one. */
export function yunlianGroupOf(provider: Pick<ProviderInfo, "id" | "custom">): string | undefined {
	return provider.custom && provider.id.startsWith(GROUP_PREFIX) ? provider.id.slice(GROUP_PREFIX.length) : undefined;
}

/** Provider id for a group, e.g. `yunlian-vip`. */
export function yunlianGroupId(group: string): string {
	const slug =
		group
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^[-._]+|[-._]+$/g, "")
			.slice(0, 48) ||
		// Non-ASCII group names (e.g. 企业) still need a stable, valid id.
		[...group]
			.map((c) => c.codePointAt(0)?.toString(36))
			.join("")
			.slice(0, 48) ||
		"default";
	return `${GROUP_PREFIX}${slug}`;
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
 * The custom provider to save for a token's models. Saving again keeps the existing entry's
 * name, API type, Base URL and per-model settings, and adds the token's new models.
 *
 * Each model is called with the wire API the site detected for it (e.g. Anthropic Messages for
 * Claude models), stored per model when it differs from the provider's; models the site gave no
 * preference for keep their previous API.
 */
export function relayProvider(
	target: { id: string; name: string; siteUrl: string },
	models: ReadonlyArray<NewApiModel>,
	existing?: CustomProvider,
	modelsError?: string,
): CustomProvider {
	const api = existing?.api ?? "openai-completions";
	const previous = new Map((existing?.models ?? []).map((m) => [m.id, m]));
	const seen = new Set<string>();
	const list: CustomModel[] = [];
	for (const model of models) {
		const id = model.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const { api: previousApi, ...kept } = previous.get(id) ?? {
			id,
			...(model.name && model.name !== id ? { name: model.name } : {}),
		};
		const modelApi = model.api ?? previousApi;
		list.push({ ...kept, ...(modelApi && modelApi !== api ? { api: modelApi } : {}) });
	}
	// The site could not list models this time: keep what was configured before.
	const kept = list.length ? list : (existing?.models ?? []);
	if (!kept.length) {
		throw new Error(
			modelsError ? `无法获取${target.name}的模型列表：${modelsError}` : `${target.name} 没有返回可用的模型`,
		);
	}
	return {
		id: existing?.id ?? target.id,
		...(existing ? (existing.name ? { name: existing.name } : {}) : { name: target.name }),
		api,
		baseUrl: existing?.baseUrl ?? newApiBaseUrl(target.siteUrl, api),
		models: kept.slice(0, MAX_MODELS),
	};
}

/** The browser sign-in entry (`yunlian`) for the approved token's models. */
export function yunlianProvider(
	models: ReadonlyArray<NewApiModel>,
	existing?: CustomProvider,
	modelsError?: string,
): CustomProvider {
	return relayProvider({ id: YUNLIAN_ID, name: YUNLIAN_NAME, siteUrl: YUNLIAN_SITE }, models, existing, modelsError);
}

/** An amount of quota the way the site shows it (`$1.23`, `¥8.61`, or raw tokens). */
export function formatQuota(quota: number, display: AccountQuotaDisplay): string {
	if (display.type === "TOKENS") return Math.round(quota).toLocaleString("zh-CN");
	const usd = quota / (display.perUnit || 500_000);
	let value = usd;
	let symbol = "$";
	if (display.type === "CNY") {
		value = usd * (display.usdRate ?? 7);
		symbol = "¥";
	} else if (display.type === "CUSTOM") {
		value = usd * (display.customRate ?? 1);
		symbol = display.customSymbol ?? "¤";
	}
	const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
	return `${value < 0 ? "-" : ""}${symbol}${Math.abs(value).toLocaleString("zh-CN", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	})}`;
}
