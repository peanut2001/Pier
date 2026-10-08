import { describe, expect, it } from "vitest";
import {
	breakingChanges,
	changelogEntries,
	compareVersions,
	PI_PACKAGES,
	pinnedVersion,
	pinVersion,
	pullRequestBody,
} from "../scripts/pi-update.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

- Not yet released

## [1.1.0] - 2026-10-07

### Added

- Added a thing

## [1.0.0] - 2026-10-01

### Breaking Changes

- Renamed the \`foo\` provider to \`bar\`

### Fixed

- Fixed a bug

## [0.87.1] - 2026-09-22

### Fixed

- Older fix
`;

describe("pi update script", () => {
	it("compares stable versions numerically", () => {
		expect(compareVersions("1.1.0", "0.87.1")).toBeGreaterThan(0);
		expect(compareVersions("0.87.1", "0.87.10")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(() => compareVersions("1.0.0-beta.1", "1.0.0")).toThrow();
	});

	it("reads and rewrites the pinned version, keeping formatting", () => {
		const text = `{\n\t"dependencies": {\n\t\t"@earendil-works/pi-ai": "0.87.1",\n\t\t"@earendil-works/pi-coding-agent": "0.87.1",\n\t\t"ws": "^8.22.0"\n\t}\n}\n`;
		expect(pinnedVersion(JSON.parse(text))).toBe("0.87.1");
		const updated = pinVersion(text, "1.1.0");
		expect(updated).toBe(text.replaceAll('"0.87.1"', '"1.1.0"'));
		expect(pinnedVersion(JSON.parse(updated))).toBe("1.1.0");
		expect(() => pinVersion(text, "latest")).toThrow();
	});

	it("rejects mismatched or ranged pins", () => {
		expect(PI_PACKAGES).toEqual(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]);
		const agent = "@earendil-works/pi-coding-agent";
		const ai = "@earendil-works/pi-ai";
		expect(() => pinnedVersion({ dependencies: { [agent]: "1.1.0", [ai]: "1.0.0" } })).toThrow(/one version/);
		expect(() => pinnedVersion({ dependencies: { [agent]: "^1.1.0", [ai]: "^1.1.0" } })).toThrow(/exact/);
	});

	it("selects changelog entries after the current version up to the target", () => {
		const entries = changelogEntries(CHANGELOG, "0.87.1", "1.1.0");
		expect(entries.map((e) => e.version)).toEqual(["1.1.0", "1.0.0"]);
		expect(entries[0]).toMatchObject({ date: "2026-10-07" });
		expect(changelogEntries(CHANGELOG, "1.0.0", "1.0.0")).toEqual([]);
		expect(breakingChanges(entries[1]?.body ?? "")).toEqual(["- Renamed the `foo` provider to `bar`"]);
	});

	it("lists breaking changes first in the pull-request body", () => {
		const body = pullRequestBody(CHANGELOG, "0.87.1", "1.1.0");
		expect(body).toContain("from `0.87.1` to `1.1.0`");
		expect(body).toContain("- Renamed the `foo` provider to `bar` _(1.0.0)_");
		expect(body.indexOf("## Breaking changes")).toBeLessThan(body.indexOf("## pi changelog"));
		expect(body).toContain("#### Added");
		expect(body).not.toContain("Older fix");
		expect(body).not.toContain("Not yet released");
		expect(pullRequestBody(CHANGELOG, "1.0.0", "1.1.0")).toContain("None listed in pi's changelog.");
	});
});
