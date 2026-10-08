// Types for pi-update.mjs (imported by test/pi-update.test.ts).
export declare const PI_PACKAGES: readonly string[];
export declare function compareVersions(a: string, b: string): number;
export declare function pinnedVersion(manifest: { dependencies?: Record<string, string> }): string;
export declare function pinVersion(text: string, version: string): string;
export interface ChangelogEntry {
	version: string;
	date: string;
	body: string;
}
export declare function changelogEntries(changelog: string, from: string, to: string): ChangelogEntry[];
export declare function breakingChanges(body: string): string[];
export declare function pullRequestBody(changelog: string, from: string, to: string): string;
