import {
	type AccountQuotaDisplay,
	type CustomModel,
	type CustomProvider,
	type CustomProviderApi,
	type NewApiModel,
	type ProviderInfo,
	YUNLIAN_LINES,
	YUNLIAN_SITE_URL,
} from "@pier/protocol";

/** 云链API, a NewAPI relay offered as a built-in provider and the personal center's site. */
export const YUNLIAN_ID = "yunlian";
export const YUNLIAN_NAME = "云链API";
export const YUNLIAN_SITE = YUNLIAN_SITE_URL;
/** Hosts of every line of 云链API (`api.yunnet.top`, `api.syixn.com`). */
const YUNLIAN_HOSTS = new Set(YUNLIAN_LINES.map((line) => new URL(line.url).host.toLowerCase()));
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
	const host = url === undefined ? undefined : hostOf(url);
	return host !== undefined && YUNLIAN_HOSTS.has(host);
}

/**
 * Every address of the site at `siteUrl`: all lines when it is one of 云链API's, which reach the
 * same site and accept the same keys. `siteUrl` comes first.
 */
export function siteAddresses(siteUrl: string): string[] {
	const host = hostOf(siteUrl);
	if (host === undefined || !YUNLIAN_HOSTS.has(host)) return [siteUrl];
	return [siteUrl, ...YUNLIAN_LINES.map((line) => line.url).filter((url) => hostOf(url) !== host)];
}

/** The group a personal-center provider was configured for, if it is one. */
export function yunlianGroupOf(provider: Pick<ProviderInfo, "id" | "custom">): string | undefined {
	return provider.custom && provider.id.startsWith(GROUP_PREFIX) ? provider.id.slice(GROUP_PREFIX.length) : undefined;
}

function groupSlug(group: string): string {
	return group
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-._]+|[-._]+$/g, "")
		.slice(0, 48);
}

/** FNV-1a of the group name, so ids stay distinct when the slug drops characters. */
function groupHash(group: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(group)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	return hash.toString(36);
}

/**
 * Provider id for a group, e.g. `yunlian-vip`. Names that are not already a valid slug (upper
 * case, spaces, non-ASCII, too long) get a hash suffix, so `Claude`, `claude` and `claude企业级`
 * never share a provider.
 */
export function yunlianGroupId(group: string): string {
	const slug = groupSlug(group);
	if (slug && slug === group) return `${GROUP_PREFIX}${slug}`;
	return `${GROUP_PREFIX}${slug || "g"}-${groupHash(group)}`;
}

/** The id releases up to 0.2.11 used for a group; distinct groups could share it. */
export function legacyYunlianGroupId(group: string): string {
	const slug =
		groupSlug(group) ||
		[...group]
			.map((c) => c.codePointAt(0)?.toString(36))
			.join("")
			.slice(0, 48) ||
		"default";
	return `${GROUP_PREFIX}${slug}`;
}

/**
 * The provider configured for `group`. Providers saved under the old id are still found, unless
 * another listed group shares that id and the provider is not named after this group.
 */
export function findYunlianGroupProvider<P extends { id: string; name: string }>(
	providers: ReadonlyMap<string, P>,
	group: string,
	groups: ReadonlyArray<string>,
	siteName: string,
): P | undefined {
	const named = (provider: P, name: string) => provider.name === `${siteName} · ${name}`;
	const current = providers.get(yunlianGroupId(group));
	if (current) {
		// e.g. `yunlian-claude` saved for `Claude` by an older release, now the id of `claude`.
		const takenBy = groups.some(
			(other) => other !== group && legacyYunlianGroupId(other) === current.id && named(current, other),
		);
		return takenBy ? undefined : current;
	}
	const legacyId = legacyYunlianGroupId(group);
	const legacy = providers.get(legacyId);
	if (!legacy) return undefined;
	const shared = groups.some((other) => other !== group && legacyYunlianGroupId(other) === legacyId);
	if (!shared) return legacy;
	// Only the group the provider was first saved for owns it (the name is kept on later saves).
	return named(legacy, group) ? legacy : undefined;
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

function sameUrl(a: string, b: string): boolean {
	return a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The API most models use. Ties keep `current`, then prefer Chat Completions, then the API seen
 * first.
 */
function mainApi(apis: ReadonlyArray<CustomProviderApi>, current: CustomProviderApi | undefined): CustomProviderApi {
	const counts = new Map<CustomProviderApi, number>();
	for (const api of apis) counts.set(api, (counts.get(api) ?? 0) + 1);
	const most = Math.max(0, ...counts.values());
	const top = [...counts].filter(([, n]) => n === most).map(([api]) => api);
	if (current && (top.includes(current) || !top.length)) return current;
	if (top.includes("openai-completions") || !top.length) return "openai-completions";
	return top[0] as CustomProviderApi;
}

/**
 * The custom provider to save for a token's models. Saving again keeps the existing entry's
 * name and per-model settings, and adds the token's new models.
 *
 * Each model is called with the wire API the site detected for it (e.g. Anthropic Messages for
 * Claude models); models the site gave no preference for keep their previous API, and new ones
 * use Chat Completions. The provider takes the API most of its models use (a Claude group is an
 * Anthropic Messages provider), with its Base URL derived for it, and only the other models store
 * their own API. A Base URL the user changed by hand keeps the provider's API and Base URL.
 */
export function relayProvider(
	target: { id: string; name: string; siteUrl: string },
	models: ReadonlyArray<NewApiModel>,
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
		const old = previous.get(id);
		const { api: previousApi, ...kept } = old ?? {
			id,
			...(model.name && model.name !== id ? { name: model.name } : {}),
		};
		const api = model.api ?? (old ? (previousApi ?? existing?.api) : undefined) ?? "openai-completions";
		list.push({ ...kept, api });
	}
	// The site could not list models this time: keep what was configured before.
	const resolved = list.length
		? list
		: (existing?.models ?? []).map((m) => ({ ...m, api: m.api ?? existing?.api ?? "openai-completions" }));
	if (!resolved.length) {
		throw new Error(
			modelsError ? `无法获取${target.name}的模型列表：${modelsError}` : `${target.name} 没有返回可用的模型`,
		);
	}
	const limited = resolved.slice(0, MAX_MODELS);
	// A Base URL other than the one derived for the provider's API was set by hand. One derived
	// from another line of the site moves to `target.siteUrl`.
	const custom =
		existing !== undefined &&
		!siteAddresses(target.siteUrl).some((site) => sameUrl(existing.baseUrl, newApiBaseUrl(site, existing.api)));
	const api = custom
		? existing.api
		: mainApi(
				limited.map((m) => m.api as CustomProviderApi),
				existing?.api,
			);
	return {
		id: existing?.id ?? target.id,
		...(existing ? (existing.name ? { name: existing.name } : {}) : { name: target.name }),
		api,
		baseUrl: custom ? existing.baseUrl : newApiBaseUrl(target.siteUrl, api),
		models: limited.map(({ api: modelApi, ...model }) => (modelApi === api ? model : { ...model, api: modelApi })),
	};
}

/** The browser sign-in entry (`yunlian`) for the approved token's models, on the line at `siteUrl`. */
export function yunlianProvider(
	models: ReadonlyArray<NewApiModel>,
	existing?: CustomProvider,
	modelsError?: string,
	siteUrl: string = YUNLIAN_SITE,
): CustomProvider {
	return relayProvider({ id: YUNLIAN_ID, name: YUNLIAN_NAME, siteUrl }, models, existing, modelsError);
}

/**
 * The 云链API providers to move to the line at `siteUrl`: those whose Base URL was derived from
 * another line (ones changed by hand are left alone), with the Base URL of the new line.
 */
export function movedToLine(
	providers: ReadonlyArray<Pick<ProviderInfo, "id" | "custom">>,
	siteUrl: string,
): CustomProvider[] {
	const moved: CustomProvider[] = [];
	for (const provider of providers) {
		const custom = provider.custom;
		if (!custom || !isYunlianProvider(provider)) continue;
		const target = newApiBaseUrl(siteUrl, custom.api);
		if (sameUrl(custom.baseUrl, target)) continue;
		const derived = siteAddresses(siteUrl).some((site) => sameUrl(custom.baseUrl, newApiBaseUrl(site, custom.api)));
		if (!derived) continue;
		const { hasConfiguredKey: _key, ...rest } = custom as CustomProvider & { hasConfiguredKey?: boolean };
		moved.push({ ...rest, baseUrl: target });
	}
	return moved;
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
