/**
 * Search the pi package gallery (https://pi.dev/packages, `extension.search`, 1.20).
 *
 * The gallery lists npm packages with the `pi-package` keyword and is rendered on the server:
 * every result is an `<article data-package-card>` carrying its data in attributes, so the
 * host reads those rather than scraping visible text. When the gallery cannot be reached or
 * its markup changes, the npm registry search for `keywords:pi-package` stands in (without
 * type filters or sorting).
 */
import {
	type ExtensionCatalogPackage,
	type ExtensionCatalogResult,
	type ExtensionCatalogSort,
	type ExtensionCatalogType,
	ExtensionCatalogTypeSchema,
	PierProtocolError,
} from "@pier/protocol";

export const GALLERY_URL = "https://pi.dev/packages";
export const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
/** Results per page of the gallery (the npm fallback uses the same size). */
export const CATALOG_PAGE_SIZE = 50;

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 64;
/** Refuse pages larger than this (a gallery page is about 200 KB). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface CatalogQuery {
	query?: string;
	type?: ExtensionCatalogType;
	sort?: ExtensionCatalogSort;
	page?: number;
}

export interface PackageCatalogOptions {
	fetch?: typeof fetch;
	userAgent?: string;
	log?: (message: string) => void;
	galleryUrl?: string;
	npmSearchUrl?: string;
	now?: () => number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] === "#") {
			const code =
				entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[entity.toLowerCase()] ?? match;
	});
}

/** Visible text of an HTML fragment. */
function textOf(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

function attributes(tag: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
		result.set((match[1] ?? "").toLowerCase(), decodeEntities(match[2] ?? ""));
	}
	return result;
}

function httpUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function npmPackageUrl(name: string): string {
	return `https://www.npmjs.com/package/${name}`;
}

/** Valid npm package names only (they end up in `npm:<name>` install sources). */
const NPM_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;

function catalogTypes(value: string | undefined): ExtensionCatalogType[] {
	const types = new Set<ExtensionCatalogType>();
	for (const word of (value ?? "").split(/[\s,]+/)) {
		const parsed = ExtensionCatalogTypeSchema.safeParse(word.toLowerCase());
		if (parsed.success) types.add(parsed.data);
	}
	return [...types];
}

/** One `<article data-package-card>` of the gallery. */
function parseCard(openTag: string, body: string, galleryUrl: string): ExtensionCatalogPackage | undefined {
	const attrs = attributes(openTag);
	const name = attrs.get("data-package-name")?.trim();
	if (!name || !NPM_NAME.test(name)) return undefined;
	const pkg: ExtensionCatalogPackage = {
		name,
		source: `npm:${name}`,
		types: catalogTypes(attrs.get("data-package-types")),
		npmUrl: npmPackageUrl(name),
	};

	const description = /<p\b[^>]*class="[^"]*\bpackages-desc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1];
	if (description && textOf(description)) pkg.description = textOf(description);

	const downloads = Number(attrs.get("data-package-downloads"));
	if (attrs.get("data-package-downloads") && Number.isFinite(downloads) && downloads >= 0) {
		pkg.monthlyDownloads = downloads;
	}
	const date = Number(attrs.get("data-package-date"));
	if (Number.isFinite(date) && date > 0) pkg.publishedAt = new Date(date).toISOString();

	// Meta: author, "1.2M/mo", "21h ago" (the author may be missing).
	const meta = /<div\b[^>]*class="[^"]*\bpackages-meta\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(body)?.[1];
	if (meta) {
		const first = /<span\b[^>]*>([\s\S]*?)<\/span>/.exec(meta)?.[1];
		const author = first ? textOf(first) : "";
		if (author && !/\/mo$/i.test(author) && !/\bago$/i.test(author) && !/^just now$/i.test(author)) {
			pkg.author = author;
		}
	}

	// Install command: `pi install npm:<name>`.
	const copy = /data-copy-text="pi install ([^"]+)"/.exec(body)?.[1];
	if (copy) {
		const source = decodeEntities(copy).trim();
		if (source === `npm:${name}`) pkg.source = source;
	}

	for (const link of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
		const linkAttrs = attributes(link[1] ?? "");
		const href = linkAttrs.get("href") ?? "";
		const label = textOf(link[2] ?? "").toLowerCase();
		if (linkAttrs.has("data-package-link")) {
			const path = linkAttrs.get("data-package-path") ?? href.split("?")[0];
			if (path) {
				try {
					pkg.galleryUrl = new URL(path, galleryUrl).href;
				} catch {
					// ignore
				}
			}
			continue;
		}
		const url = httpUrl(href);
		if (!url) continue;
		if (label === "npm" && /^https:\/\/www\.npmjs\.com\//.test(url)) pkg.npmUrl = url;
		else if (label === "repo" || label === "repository" || label === "homepage") pkg.repositoryUrl ??= url;
		else if (label === "report") {
			const version = new URL(url).searchParams.get("package-version");
			if (version && /^[\w.+-]{1,64}$/.test(version)) pkg.version = version;
		}
	}
	return pkg;
}

/** The gallery's "1-50 / 234 (of 5607)" (or "0 / 5607" when nothing matches). */
function parseCount(html: string): { from: number; to: number; total: number } | undefined {
	const match = /class="[^"]*\bpackages-count\b[^"]*"[^>]*>([^<]*)</.exec(html);
	if (!match) return undefined;
	const text = decodeEntities(match[1] ?? "").trim();
	const range = /^(\d+)\s*[-–]\s*(\d+)\s*\/\s*(\d+)/.exec(text);
	if (range) return { from: Number(range[1]), to: Number(range[2]), total: Number(range[3]) };
	if (/^0\s*\/\s*\d+/.test(text)) return { from: 0, to: 0, total: 0 };
	return undefined;
}

/** Parse a gallery page; throws when it does not look like one (so the npm search stands in). */
export function parseGalleryPage(html: string, page: number, galleryUrl = GALLERY_URL): ExtensionCatalogResult {
	const packages: ExtensionCatalogPackage[] = [];
	const seen = new Set<string>();
	for (const match of html.matchAll(/(<article\b[^>]*\bdata-package-card="true"[^>]*>)([\s\S]*?)<\/article>/g)) {
		const pkg = parseCard(match[1] ?? "", match[2] ?? "", galleryUrl);
		if (pkg && !seen.has(pkg.name)) {
			seen.add(pkg.name);
			packages.push(pkg);
		}
	}
	const count = parseCount(html);
	if (!count && !packages.length) throw new Error("页面中没有找到扩展包列表");
	const total = count ? count.total : packages.length;
	const hasMore = count ? count.to > 0 && count.to < count.total : false;
	return { origin: "pi.dev", packages, total, page, pageSize: CATALOG_PAGE_SIZE, hasMore };
}

interface NpmSearchObject {
	package?: {
		name?: unknown;
		version?: unknown;
		description?: unknown;
		date?: unknown;
		publisher?: { username?: unknown };
		author?: { name?: unknown };
		links?: { npm?: unknown; repository?: unknown; homepage?: unknown };
	};
	downloads?: { monthly?: unknown };
}

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

export function parseNpmSearch(json: unknown, page: number): ExtensionCatalogResult {
	const body = json as { objects?: unknown; total?: unknown } | null;
	if (!body || !Array.isArray(body.objects)) throw new Error("npm registry 返回的格式无法识别");
	const packages: ExtensionCatalogPackage[] = [];
	for (const object of body.objects as NpmSearchObject[]) {
		const info = object?.package;
		const name = str(info?.name);
		if (!info || !name || !NPM_NAME.test(name)) continue;
		const pkg: ExtensionCatalogPackage = {
			name,
			source: `npm:${name}`,
			types: [],
			npmUrl: httpUrl(str(info.links?.npm)) ?? npmPackageUrl(name),
		};
		const description = str(info.description);
		if (description) pkg.description = description;
		const version = str(info.version);
		if (version) pkg.version = version;
		const author = str(info.author?.name) ?? str(info.publisher?.username);
		if (author) pkg.author = author;
		const repository = httpUrl(str(info.links?.repository)) ?? httpUrl(str(info.links?.homepage));
		if (repository) pkg.repositoryUrl = repository;
		const date = str(info.date);
		if (date && !Number.isNaN(Date.parse(date))) pkg.publishedAt = new Date(date).toISOString();
		const monthly = object.downloads?.monthly;
		if (typeof monthly === "number" && Number.isFinite(monthly)) pkg.monthlyDownloads = monthly;
		packages.push(pkg);
	}
	const total = typeof body.total === "number" && Number.isFinite(body.total) ? body.total : packages.length;
	return {
		origin: "npm",
		packages,
		total,
		page,
		pageSize: CATALOG_PAGE_SIZE,
		hasMore: page * CATALOG_PAGE_SIZE < total && packages.length > 0,
	};
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") return "请求超时";
		const cause = (error as { cause?: unknown }).cause;
		if (cause instanceof Error && cause.message) return `${error.message}（${cause.message}）`;
		return error.message;
	}
	return String(error);
}

export class PackageCatalog {
	private readonly fetchImpl: typeof fetch;
	private readonly galleryUrl: string;
	private readonly npmSearchUrl: string;
	private readonly now: () => number;
	private readonly cache = new Map<string, { at: number; result: Promise<ExtensionCatalogResult> }>();

	constructor(private readonly options: PackageCatalogOptions = {}) {
		this.fetchImpl = options.fetch ?? fetch;
		this.galleryUrl = options.galleryUrl ?? GALLERY_URL;
		this.npmSearchUrl = options.npmSearchUrl ?? NPM_SEARCH_URL;
		this.now = options.now ?? Date.now;
	}

	search(params: CatalogQuery = {}): Promise<ExtensionCatalogResult> {
		const query = (params.query ?? "").trim();
		const page = Math.max(1, Math.floor(params.page ?? 1));
		const sort = params.sort ?? "downloads";
		const key = JSON.stringify([query.toLowerCase(), params.type ?? "", sort, page]);
		const now = this.now();
		const cached = this.cache.get(key);
		if (cached && now - cached.at < CACHE_TTL_MS) return cached.result;
		const result = this.fetchResult(query, params.type, sort, page);
		this.cache.delete(key);
		this.cache.set(key, { at: now, result });
		result.catch(() => {
			if (this.cache.get(key)?.result === result) this.cache.delete(key);
		});
		while (this.cache.size > CACHE_LIMIT) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		return result;
	}

	private async fetchResult(
		query: string,
		type: ExtensionCatalogType | undefined,
		sort: ExtensionCatalogSort,
		page: number,
	): Promise<ExtensionCatalogResult> {
		let galleryError: string;
		try {
			const url = new URL(this.galleryUrl);
			if (query) url.searchParams.set("name", query);
			if (type) url.searchParams.set("type", type);
			if (sort !== "downloads") url.searchParams.set("sort", sort);
			if (page > 1) url.searchParams.set("page", String(page));
			const html = await this.get(url, "text/html");
			return parseGalleryPage(html, page, this.galleryUrl);
		} catch (error) {
			galleryError = errorText(error);
			this.options.log?.(`pi package gallery unavailable, using the npm registry: ${galleryError}`);
		}
		try {
			const url = new URL(this.npmSearchUrl);
			url.searchParams.set("text", query ? `keywords:pi-package ${query}` : "keywords:pi-package");
			url.searchParams.set("size", String(CATALOG_PAGE_SIZE));
			if (page > 1) url.searchParams.set("from", String((page - 1) * CATALOG_PAGE_SIZE));
			const json: unknown = JSON.parse(await this.get(url, "application/json"));
			const result = parseNpmSearch(json, page);
			const notice = `无法访问 pi 官方扩展仓库（${galleryError}），已改用 npm registry 搜索${
				type || sort !== "downloads" ? "，类型筛选与排序不可用" : ""
			}`;
			return { ...result, notice };
		} catch (error) {
			throw new PierProtocolError(
				"INTERNAL",
				`无法访问 pi 扩展仓库：${galleryError}；npm registry 也无法访问：${errorText(error)}`,
			);
		}
	}

	private async get(url: URL, accept: string): Promise<string> {
		const response = await this.fetchImpl(url, {
			headers: {
				accept,
				...(this.options.userAgent ? { "user-agent": this.options.userAgent } : {}),
			},
			redirect: "follow",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`${url.host} 返回 HTTP ${response.status}`);
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error(`${url.host} 返回的内容过大`);
		const text = await response.text();
		if (text.length > MAX_BODY_BYTES) throw new Error(`${url.host} 返回的内容过大`);
		return text;
	}
}
