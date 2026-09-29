import { describe, expect, it } from "vitest";
import { PackageCatalog, parseGalleryPage, parseNpmSearch } from "../src/pi/package-catalog.ts";
import { startTestHost } from "./helpers.ts";

/** Two cards in the markup pi.dev/packages renders (trimmed). */
function galleryPage(count: string, cards = true): string {
	const card = (name: string, types: string, extra: string) => `
<article class="surface-panel content-card" data-package-card="true" data-package-name="${name}" data-package-search="${name} demo" data-package-types="${types}" data-package-downloads="1197959" data-package-date="1790621401084" data-package-sort-name="${name}">
<div class="packages-card-body"><h3 class="packages-name"><a href="/packages/${name}?name=web" data-package-link="true" data-package-path="/packages/${name}">${name}</a></h3>
<p class="packages-desc">MCP adapter &amp; tools for &lt;pi&gt;</p>
${extra}
<div class="packages-links" aria-label="Links"><a href="https://www.npmjs.com/package/${name}" target="_blank" rel="noopener"><svg><path d="M0 0"></path></svg> npm</a><a href="https://github.com/example/${name.replace("@", "").replace("/", "-")}" target="_blank" rel="noopener"><svg></svg> repo</a><a href="https://github.com/earendil-works/pi/issues/new?template=package-report.yml&amp;package-name=${encodeURIComponent(name)}&amp;package-version=0.33.0" target="_blank"><svg></svg> report</a></div>
<div class="packages-install"><code><span class="prefix">$</span> pi install npm:${name}</code><button type="button" data-copy="true" data-copy-text="pi install npm:${name}">Copy</button></div></div></article>`;
	return `<html><body><section><span class="packages-count">${count}</span>${
		cards
			? card(
					"pi-mcp-adapter",
					"extension prompt",
					'<div class="packages-meta"><span>nicopreme</span><span>1.2M/mo</span><span>21h ago</span></div>',
				) +
				card("@scope/pi-theme", "", '<div class="packages-meta"><span>3.1K/mo</span><span>2d ago</span></div>') +
				card("bad name!", "extension", "")
			: '<p class="packages-empty">No packages match this filter.</p>'
	}</section></body></html>`;
}

describe("pi package catalog", () => {
	it("parses gallery cards", () => {
		const result = parseGalleryPage(galleryPage("1-50 / 234 (of 5607)"), 1);
		expect(result).toMatchObject({ origin: "pi.dev", total: 234, page: 1, pageSize: 50, hasMore: true });
		expect(result.packages).toHaveLength(2);
		expect(result.packages[0]).toEqual({
			name: "pi-mcp-adapter",
			source: "npm:pi-mcp-adapter",
			description: "MCP adapter & tools for <pi>",
			version: "0.33.0",
			author: "nicopreme",
			types: ["extension", "prompt"],
			monthlyDownloads: 1197959,
			publishedAt: new Date(1790621401084).toISOString(),
			npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
			repositoryUrl: "https://github.com/example/pi-mcp-adapter",
			galleryUrl: "https://pi.dev/packages/pi-mcp-adapter",
		});
		expect(result.packages[1]).toMatchObject({ name: "@scope/pi-theme", source: "npm:@scope/pi-theme", types: [] });
		expect(result.packages[1]?.author).toBeUndefined();
	});

	it("reports the last page and empty results", () => {
		expect(parseGalleryPage(galleryPage("201-234 / 234 (of 5607)"), 5).hasMore).toBe(false);
		const empty = parseGalleryPage(galleryPage("0 / 5607", false), 1);
		expect(empty).toMatchObject({ total: 0, hasMore: false, packages: [] });
		expect(() => parseGalleryPage("<html>maintenance</html>", 1)).toThrow();
	});

	it("parses the npm registry search", () => {
		const result = parseNpmSearch(
			{
				total: 120,
				objects: [
					{
						package: {
							name: "pi-web-access",
							version: "0.33.0",
							description: "Web search",
							date: "2026-09-28T04:22:32.715Z",
							publisher: { username: "nicopreme" },
							links: { npm: "https://www.npmjs.com/package/pi-web-access", repository: "git+ssh://x" },
						},
						downloads: { monthly: 459058 },
					},
					{ package: { name: "../evil" } },
				],
			},
			2,
		);
		expect(result).toMatchObject({ origin: "npm", total: 120, page: 2, hasMore: true });
		expect(result.packages).toEqual([
			{
				name: "pi-web-access",
				source: "npm:pi-web-access",
				types: [],
				npmUrl: "https://www.npmjs.com/package/pi-web-access",
				description: "Web search",
				version: "0.33.0",
				author: "nicopreme",
				publishedAt: "2026-09-28T04:22:32.715Z",
				monthlyDownloads: 459058,
			},
		]);
	});

	it("queries the gallery, caches results, and falls back to npm", async () => {
		const urls: string[] = [];
		let galleryUp = true;
		const fetchStub = (async (input: URL | string) => {
			const url = new URL(String(input));
			urls.push(url.href);
			if (url.host === "gallery.test") {
				if (!galleryUp) return new Response("down", { status: 503 });
				return new Response(galleryPage("51-100 / 234 (of 5607)"), { status: 200 });
			}
			return Response.json({ total: 1, objects: [{ package: { name: "pi-web-access" } }] });
		}) as typeof fetch;
		const catalog = new PackageCatalog({
			fetch: fetchStub,
			galleryUrl: "https://gallery.test/packages",
			npmSearchUrl: "https://npm.test/-/v1/search",
		});

		const first = await catalog.search({ query: " web ", type: "extension", sort: "recent", page: 2 });
		expect(first.origin).toBe("pi.dev");
		expect(first.packages[0]?.galleryUrl).toBe("https://gallery.test/packages/pi-mcp-adapter");
		expect(urls).toEqual(["https://gallery.test/packages?name=web&type=extension&sort=recent&page=2"]);
		await catalog.search({ query: "web", type: "extension", sort: "recent", page: 2 });
		expect(urls).toHaveLength(1);

		galleryUp = false;
		const fallback = await catalog.search({ query: "web" });
		expect(fallback).toMatchObject({ origin: "npm", total: 1, hasMore: false });
		expect(fallback.notice).toContain("HTTP 503");
		expect(urls.slice(1)).toEqual([
			"https://gallery.test/packages?name=web",
			"https://npm.test/-/v1/search?text=keywords%3Api-package+web&size=50",
		]);
	});

	it("fails when neither source answers", async () => {
		const catalog = new PackageCatalog({
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		await expect(catalog.search()).rejects.toMatchObject({ code: "INTERNAL" });
	});

	it("is served by extension.search", async () => {
		const t = await startTestHost({
			packageCatalog: {
				fetch: (async () => new Response(galleryPage("1-3 / 3"), { status: 200 })) as typeof fetch,
			},
		});
		try {
			const client = await t.connect();
			const result = await client.request("extension.search", { query: "mcp" });
			expect(result).toMatchObject({ origin: "pi.dev", total: 3, hasMore: false });
			expect(result.packages.map((p) => p.name)).toEqual(["pi-mcp-adapter", "@scope/pi-theme"]);
		} finally {
			await t.close();
		}
	});
});
