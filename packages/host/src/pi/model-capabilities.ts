/**
 * Capabilities of models listed by relays and custom endpoints.
 *
 * `GET /models` only returns ids, so a custom endpoint's models would all look like plain text
 * models without thinking levels. pi ships a catalog of the models its built-in providers offer;
 * relays usually use the same ids (sometimes with a vendor prefix or a date suffix), so the
 * catalog tells whether a model reasons, accepts images, and how large its context is. Ids the
 * catalog does not know fall back to name patterns for the reasoning and image flags only.
 */

/** What is known about a model. Absent fields are unknown. */
export interface ModelCapabilities {
	reasoning?: boolean;
	images?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

/** A catalog model (pi's `Model`, reduced to what is needed here). */
export interface CatalogModel {
	provider: string;
	id: string;
	reasoning?: boolean;
	input?: readonly string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** Providers whose catalog entry for a model is the most authoritative, best first. */
const PROVIDER_RANK = [
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"xai",
	"mistral",
	"moonshotai",
	"zai",
	"minimax",
	"xiaomi",
	"openrouter",
	"vercel-ai-gateway",
];

function rank(provider: string): number {
	const index = PROVIDER_RANK.indexOf(provider);
	return index === -1 ? PROVIDER_RANK.length : index;
}

/** Lowercase id without a vendor path (`anthropic/…`, `models/…`) or a `:variant` tag. */
function baseId(id: string): string {
	let value = id.trim().toLowerCase();
	const slash = value.lastIndexOf("/");
	if (slash !== -1) value = value.slice(slash + 1);
	const colon = value.indexOf(":");
	if (colon !== -1) value = value.slice(0, colon);
	return value;
}

const DATE_SUFFIX = /(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2}|-\d{4}|-latest)$/;
const THINKING_SUFFIX = /[-_](?:thinking|think|reasoning)$/;
const NO_THINKING_SUFFIX = /[-_](?:no-?thinking|non-?thinking|nothink)$/;

/** Ids to look up for `id`, most specific first. */
function candidates(id: string): string[] {
	const out: string[] = [];
	const add = (value: string) => {
		if (value && !out.includes(value)) out.push(value);
	};
	const base = baseId(id);
	for (const variant of [base, base.replace(THINKING_SUFFIX, "").replace(NO_THINKING_SUFFIX, "")]) {
		for (const value of [variant, variant.replace(DATE_SUFFIX, "")]) {
			add(value);
			// `claude-sonnet-4.5` and `claude-sonnet-4-5` name the same model.
			add(value.replace(/(\d)\.(\d)/g, "$1-$2"));
			add(value.replace(/(\d)-(\d)(?!\d)/g, "$1.$2"));
		}
	}
	return out;
}

/**
 * Reasoning by name, for ids the catalog does not know. Only well-known reasoning families;
 * anything else stays unknown.
 */
const REASONING_NAME =
	/(?:^|[-_.])(?:thinking|reasoner|reasoning|r1)(?:$|[-_.])|^o[1-9](?:$|-)|^gpt-5|^gpt-oss|^claude-(?:opus|sonnet|haiku)-(?:4|[5-9])|^claude-[a-z]+-(?:[5-9])|^claude-3-7|^gemini-(?:2\.5|[3-9])|^qwq|^glm-(?:4\.[5-9]|[5-9])|^grok-(?:3-mini|[4-9])|^deepseek-(?:v3\.[1-9]|v[4-9])|^minimax-m[1-9]|^kimi-k2[.-]?(?:5|thinking)/;
const NOT_REASONING_NAME = /(?:no-?thinking|non-?thinking|nothink|instruct|embedding|tts|whisper|image|audio)/;
const IMAGES_NAME =
	/^claude-|^gpt-4o|^gpt-4\.1|^gpt-5|^o[34](?:$|-)|^gemini-|^grok-(?:[4-9]|vision)|vision|[-_]vl(?:$|[-_])/;
const NOT_IMAGES_NAME = /(?:embedding|tts|whisper|audio|codex-mini)/;

function byName(id: string): ModelCapabilities {
	const base = baseId(id);
	const out: ModelCapabilities = {};
	if (NO_THINKING_SUFFIX.test(base)) out.reasoning = false;
	else if (REASONING_NAME.test(base) && !NOT_REASONING_NAME.test(base)) out.reasoning = true;
	if (IMAGES_NAME.test(base) && !NOT_IMAGES_NAME.test(base)) out.images = true;
	return out;
}

/** Looks up model capabilities in a catalog of known models. */
export class ModelCapabilityIndex {
	private readonly byId = new Map<string, CatalogModel>();

	constructor(models: Iterable<CatalogModel>) {
		for (const model of models) {
			const key = baseId(model.id);
			const current = this.byId.get(key);
			if (!current || rank(model.provider) < rank(current.provider)) this.byId.set(key, model);
		}
	}

	get size(): number {
		return this.byId.size;
	}

	/** Capabilities of `id`, from the catalog or, failing that, from its name. */
	lookup(id: string): ModelCapabilities {
		const base = baseId(id);
		const model = candidates(id)
			.map((key) => this.byId.get(key))
			.find(Boolean);
		if (!model) return byName(id);
		const out: ModelCapabilities = {
			reasoning: model.reasoning === true,
			images: (model.input ?? []).includes("image"),
			...(typeof model.contextWindow === "number" && model.contextWindow > 0
				? { contextWindow: model.contextWindow }
				: {}),
			...(typeof model.maxTokens === "number" && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
		};
		// Relays expose thinking and non-thinking variants of one model under suffixed ids.
		if (THINKING_SUFFIX.test(base)) out.reasoning = true;
		else if (NO_THINKING_SUFFIX.test(base)) out.reasoning = false;
		return out;
	}

	/** `model` with its unknown (undefined) capability fields filled in. */
	fill<T extends { id: string } & ModelCapabilities>(model: T): T {
		const known = this.lookup(model.id);
		const out = { ...model };
		if (out.reasoning === undefined && known.reasoning !== undefined) out.reasoning = known.reasoning;
		if (out.images === undefined && known.images !== undefined) out.images = known.images;
		if (out.contextWindow === undefined && known.contextWindow !== undefined) out.contextWindow = known.contextWindow;
		if (out.maxTokens === undefined && known.maxTokens !== undefined) out.maxTokens = known.maxTokens;
		return out;
	}
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill the capability fields a models.json model entry leaves out (`reasoning`, `input`,
 * `contextWindow`, `maxTokens`). Fields that are present, including `reasoning: false`, are
 * kept. Returns the entry unchanged (same object) when nothing is known to add.
 */
export function fillModelEntry(index: ModelCapabilityIndex, entry: Json): Json {
	if (typeof entry.id !== "string" || !entry.id) return entry;
	const known = index.lookup(entry.id);
	const next: Json = { ...entry };
	let changed = false;
	if (entry.reasoning === undefined && known.reasoning === true) {
		next.reasoning = true;
		changed = true;
	}
	if (entry.input === undefined && known.images === true) {
		next.input = ["text", "image"];
		changed = true;
	}
	if (entry.contextWindow === undefined && known.contextWindow !== undefined) {
		next.contextWindow = known.contextWindow;
		changed = true;
	}
	if (entry.maxTokens === undefined && known.maxTokens !== undefined) {
		next.maxTokens = known.maxTokens;
		changed = true;
	}
	return changed ? next : entry;
}

/**
 * models.json providers with unknown capability fields of their models filled in. Built-in
 * provider overrides (`skip`) and entries without a model list are left alone. Returns undefined
 * when nothing changed.
 */
export function fillModelsJsonProviders(
	index: ModelCapabilityIndex,
	providers: Record<string, Json>,
	skip: ReadonlySet<string>,
): { providers: Record<string, Json>; filled: number } | undefined {
	let filled = 0;
	const next: Record<string, Json> = { ...providers };
	for (const [id, provider] of Object.entries(providers)) {
		if (skip.has(id) || !isObject(provider) || !Array.isArray(provider.models)) continue;
		let changed = false;
		const models = provider.models.map((model) => {
			if (!isObject(model)) return model;
			const out = fillModelEntry(index, model);
			if (out !== model) {
				changed = true;
				filled++;
			}
			return out;
		});
		if (changed) next[id] = { ...provider, models };
	}
	return filled ? { providers: next, filled } : undefined;
}
