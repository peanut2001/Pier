import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { CUSTOM_PROVIDER_APIS, type CustomModel, type CustomProvider, type CustomProviderApi } from "@pier/protocol";

/**
 * Reading and editing pi's `models.json` for custom endpoints.
 *
 * Only the fields Pier's form knows about are changed; everything else in the file
 * (other providers, headers, compat, modelOverrides, extra model fields) is kept.
 */

type Json = Record<string, unknown>;

export interface ModelsJsonDocument {
	providers: Record<string, Json>;
	[key: string]: unknown;
}

/** Strip `//` line comments and trailing commas, leaving string literals untouched (same as pi). */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail: string | undefined) => tail ?? (m[0] === '"' ? m : ""));
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LoadedModelsJson {
	doc: ModelsJsonDocument;
	/** Original file text, or undefined when the file does not exist. */
	raw: string | undefined;
	/** The file uses comments or trailing commas, which a rewrite drops. */
	hasComments: boolean;
}

/** Load models.json. Throws a readable error when it exists but cannot be parsed. */
export function loadModelsJson(path: string): LoadedModelsJson {
	if (!existsSync(path)) return { doc: { providers: {} }, raw: undefined, hasComments: false };
	const raw = readFileSync(path, "utf8");
	const text = raw.replace(/^\uFEFF/, "");
	if (!text.trim()) return { doc: { providers: {} }, raw, hasComments: false };
	const stripped = stripJsonComments(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch (error) {
		throw new Error(
			`models.json 不是有效的 JSON（${error instanceof Error ? error.message : String(error)}），请先手动修复：${path}`,
		);
	}
	if (!isObject(parsed)) throw new Error(`models.json 的顶层必须是对象：${path}`);
	const providers = parsed.providers;
	if (providers !== undefined && !isObject(providers)) throw new Error(`models.json 的 providers 必须是对象：${path}`);
	const doc: ModelsJsonDocument = { ...parsed, providers: {} };
	for (const [id, value] of Object.entries(providers ?? {})) {
		if (isObject(value)) doc.providers[id] = value;
	}
	return { doc, raw, hasComments: stripped !== text };
}

/** Write models.json atomically (0600, since it may contain API keys). Backs up files with comments first. */
export function writeModelsJson(path: string, loaded: LoadedModelsJson, doc: ModelsJsonDocument): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (loaded.raw !== undefined && loaded.hasComments) {
		const backup = `${path}.bak`;
		if (!existsSync(backup)) copyFileSync(path, backup);
	}
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// Best effort (e.g. Windows).
	}
	renameSync(tmp, path);
}

/** Restore models.json to `raw` (removing it when it did not exist before). */
export function restoreModelsJson(path: string, raw: string | undefined): void {
	if (raw === undefined) {
		rmSync(path, { force: true });
		return;
	}
	writeFileSync(path, raw, { mode: 0o600 });
}

function asCustomApi(value: unknown): CustomProviderApi | undefined {
	return (CUSTOM_PROVIDER_APIS as readonly string[]).includes(value as string)
		? (value as CustomProviderApi)
		: undefined;
}

/**
 * The editable view of a models.json provider, or undefined when it is not a plain custom
 * endpoint (no base URL, an unsupported API, per-model APIs, or no models).
 */
export function toCustomProvider(
	id: string,
	entry: Json,
): (CustomProvider & { hasConfiguredKey: boolean }) | undefined {
	const api = asCustomApi(entry.api);
	const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
	const rawModels = Array.isArray(entry.models) ? entry.models.filter(isObject) : [];
	if (!api || !baseUrl || !rawModels.length) return undefined;
	const models: CustomModel[] = [];
	for (const model of rawModels) {
		if (typeof model.id !== "string" || !model.id) continue;
		if (model.api !== undefined && model.api !== api) return undefined;
		models.push({
			id: model.id,
			...(typeof model.name === "string" && model.name !== model.id ? { name: model.name } : {}),
			...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
			...(Array.isArray(model.input) ? { images: model.input.includes("image") } : {}),
			...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
			...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
		});
	}
	if (!models.length) return undefined;
	return {
		id,
		...(typeof entry.name === "string" ? { name: entry.name } : {}),
		api,
		baseUrl,
		models,
		hasConfiguredKey: entry.apiKey !== undefined,
	};
}

/** Merge a custom provider from the form into an existing models.json entry. */
export function mergeCustomProvider(previous: Json | undefined, provider: CustomProvider): Json {
	const next: Json = { ...(previous ?? {}) };
	if (provider.name && provider.name !== provider.id) next.name = provider.name;
	else delete next.name;
	next.api = provider.api;
	next.baseUrl = provider.baseUrl.replace(/\/+$/, "");
	const oldModels = new Map<string, Json>();
	for (const model of Array.isArray(previous?.models) ? previous.models : []) {
		if (isObject(model) && typeof model.id === "string") oldModels.set(model.id, model);
	}
	const seen = new Set<string>();
	next.models = provider.models
		.filter((model) => {
			if (seen.has(model.id)) return false;
			seen.add(model.id);
			return true;
		})
		.map((model) => {
			const out: Json = { ...(oldModels.get(model.id) ?? {}), id: model.id };
			delete out.api;
			if (model.name && model.name !== model.id) out.name = model.name;
			else delete out.name;
			// `false` is kept so a model the user marked as non-reasoning is not filled in again.
			if (model.reasoning !== undefined) out.reasoning = model.reasoning;
			else delete out.reasoning;
			out.input = model.images ? ["text", "image"] : ["text"];
			if (model.contextWindow) out.contextWindow = model.contextWindow;
			else delete out.contextWindow;
			if (model.maxTokens) out.maxTokens = model.maxTokens;
			else delete out.maxTokens;
			return out;
		});
	return next;
}
