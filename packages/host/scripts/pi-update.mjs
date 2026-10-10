#!/usr/bin/env node
/**
 * Keep the pi SDK that Pier Host compiles into its sidecar up to date (see
 * `.github/workflows/pi-update.yml`). Pier pins every pi package to one exact version in
 * `packages/host/package.json`; a new pi reaches users through a Pier release and the in-app
 * updater.
 *
 *   check  [--version <x.y.z>]   Compare the pinned version with npm's `latest` (or the given
 *                                version) and print `current`, `target`, `update`; also written
 *                                to $GITHUB_OUTPUT when set. Fails if a pi package lacks the target.
 *   apply  --version <x.y.z>     Pin every pi package in packages/host/package.json to the version
 *                                (run `bun install` afterwards to refresh bun.lock).
 *   notes  --from <x.y.z> --to <x.y.z> [--out <file>]
 *                                Pull-request body: pi's CHANGELOG entries after `from` up to `to`,
 *                                read from the installed package, with breaking changes listed first.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const hostRoot = resolve(here, "..");
const repoRoot = resolve(hostRoot, "../..");
const MANIFEST = join(hostRoot, "package.json");

/** pi packages Pier depends on directly; they are released together under one version. */
export const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
const REGISTRY = (process.env.NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compare two `x.y.z` versions: negative, zero, or positive. */
export function compareVersions(a, b) {
	const pa = parseStable(a);
	const pb = parseStable(b);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	return 0;
}

function parseStable(version) {
	const match = STABLE.exec(version);
	if (!match) throw new Error(`Not a stable x.y.z version: ${version}`);
	return match.slice(1, 4).map(Number);
}

/** The single exact version every pi package is pinned to in the host manifest. */
export function pinnedVersion(manifest) {
	const versions = new Set(PI_PACKAGES.map((name) => manifest.dependencies?.[name]));
	if (versions.size !== 1) {
		throw new Error(`pi packages must share one version, found: ${[...versions].join(", ")}`);
	}
	const [version] = versions;
	if (typeof version !== "string" || !STABLE.test(version)) {
		throw new Error(`pi must be pinned to an exact x.y.z version, found: ${version}`);
	}
	return version;
}

/** Rewrite the pinned pi versions in the manifest text, keeping its formatting. */
export function pinVersion(text, version) {
	parseStable(version);
	let result = text;
	for (const name of PI_PACKAGES) {
		const pattern = new RegExp(`("${name.replace(/[/.-]/g, "\\$&")}"\\s*:\\s*)"[^"]*"`);
		if (!pattern.test(result)) throw new Error(`${name} is not a dependency in ${MANIFEST}`);
		result = result.replace(pattern, `$1"${version}"`);
	}
	return result;
}

/**
 * Split pi's CHANGELOG into `{ version, date, body }` entries for versions in (from, to].
 * Headings look like `## [1.1.0] - 2026-10-07`.
 */
export function changelogEntries(changelog, from, to) {
	const entries = [];
	let current;
	for (const line of changelog.split(/\r?\n/)) {
		const heading = /^## \[([^\]]+)\](?:\s*-\s*(.+))?\s*$/.exec(line);
		if (heading) {
			current = undefined;
			const version = heading[1];
			if (STABLE.test(version) && compareVersions(version, from) > 0 && compareVersions(version, to) <= 0) {
				current = { version, date: heading[2]?.trim() ?? "", lines: [] };
				entries.push(current);
			}
			continue;
		}
		current?.lines.push(line);
	}
	return entries.map(({ lines, ...entry }) => ({ ...entry, body: lines.join("\n").trim() }));
}

/** The bullet points under `### Breaking Changes` in one changelog entry. */
export function breakingChanges(body) {
	const lines = [];
	let inside = false;
	for (const line of body.split("\n")) {
		if (/^###\s/.test(line)) {
			inside = /^###\s+Breaking/i.test(line);
			continue;
		}
		if (inside && line.trim()) lines.push(line);
	}
	return lines;
}

/** Pull-request body for an update from `from` to `to`. */
export function pullRequestBody(changelog, from, to) {
	const entries = changelogEntries(changelog, from, to);
	const breaking = entries.flatMap((entry) =>
		breakingChanges(entry.body).map((line) => `${line} _(${entry.version})_`),
	);
	const parts = [
		`Updates the pi SDK compiled into Pier Host from \`${from}\` to \`${to}\` (${PI_PACKAGES.map((n) => `\`${n}\``).join(", ")}).`,
		"",
		"Opened by the `pi update` workflow. CI (lint, typecheck, tests, sidecar build and smoke test, desktop and mobile builds) runs on this branch.",
		"",
		"Before merging:",
		"",
		"- [ ] CI is green",
		"- [ ] Breaking changes below do not affect Pier (providers, settings, SDK APIs used by `packages/host/src/pi`)",
		"- [ ] A session in the desktop app works with the new sidecar",
		"",
		"Ship it to users with a patch release (`x.y.(z+1)`, CHANGELOG entry, `v*` tag); the in-app updater then delivers it.",
		"",
		"## Breaking changes",
		"",
		breaking.length > 0 ? breaking.join("\n") : "None listed in pi's changelog.",
		"",
		"## pi changelog",
		"",
	];
	if (entries.length === 0) parts.push("No changelog entries found between these versions.");
	for (const entry of entries) {
		// Demote headings so they nest under this section; keep the text otherwise unchanged.
		const body = entry.body.replace(/^(#{1,4}) /gm, "#$1 ");
		parts.push(
			`<details${entry === entries[0] ? " open" : ""}><summary><b>${entry.version}</b>${entry.date ? ` — ${entry.date}` : ""}</summary>`,
			"",
			body || "_No notes._",
			"",
			"</details>",
			"",
		);
	}
	// GitHub rejects pull-request bodies above 65536 characters.
	const text = parts.join("\n").trimEnd();
	const limit = 60_000;
	return text.length <= limit
		? `${text}\n`
		: `${text.slice(0, limit)}\n\n… (truncated; see pi's CHANGELOG.md for the rest)\n`;
}

async function npmVersion(name, tagOrVersion) {
	const url = `${REGISTRY}/${name.replace("/", "%2f")}/${encodeURIComponent(tagOrVersion)}`;
	const response = await fetch(url, { headers: { accept: "application/json" } });
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const body = await response.json();
	return typeof body.version === "string" ? body.version : undefined;
}

function setOutputs(values) {
	const file = process.env.GITHUB_OUTPUT;
	if (!file) return;
	appendFileSync(
		file,
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(""),
	);
}

async function check(requested) {
	const current = pinnedVersion(JSON.parse(readFileSync(MANIFEST, "utf8")));
	const target = requested ?? (await npmVersion(PI_PACKAGES[0], "latest"));
	if (!target) throw new Error(`npm has no latest version of ${PI_PACKAGES[0]}`);
	parseStable(target);
	for (const name of PI_PACKAGES) {
		if ((await npmVersion(name, target)) !== target) throw new Error(`${name}@${target} is not published on npm`);
	}
	const update = compareVersions(target, current) > 0;
	setOutputs({ current, target, update });
	console.log(JSON.stringify({ current, target, update }));
}

function apply(version) {
	writeFileSync(MANIFEST, pinVersion(readFileSync(MANIFEST, "utf8"), version));
	console.log(`Pinned ${PI_PACKAGES.join(", ")} to ${version} in ${MANIFEST}`);
}

function notes(from, to, out) {
	const changelog = readFileSync(join(repoRoot, "node_modules", PI_PACKAGES[0], "CHANGELOG.md"), "utf8");
	const body = pullRequestBody(changelog, from, to);
	if (out) writeFileSync(out, body);
	else process.stdout.write(body);
}

async function main() {
	const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
	const { values } = parseArgs({
		args: rest,
		options: { version: { type: "string" }, from: { type: "string" }, to: { type: "string" }, out: { type: "string" } },
	});
	if (command === "check") return check(values.version || undefined);
	if (command === "apply" && values.version) return apply(values.version);
	if (command === "notes" && values.from && values.to) return notes(values.from, values.to, values.out);
	console.error(
		"Usage: pi-update.mjs check [--version x.y.z] | apply --version x.y.z | notes --from x.y.z --to x.y.z [--out file]",
	);
	process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
