import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PIER_HOST_VERSION } from "../src/host.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const versionOf = (path: string) => (JSON.parse(readFileSync(join(root, path), "utf8")) as { version: string }).version;

describe("release versions", () => {
	const version = versionOf("package.json");

	it("uses one version for the repository and every package", () => {
		expect(version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
		for (const pkg of ["packages/protocol", "packages/client", "packages/host"]) {
			expect(versionOf(`${pkg}/package.json`), pkg).toBe(version);
		}
	});

	it("reports the same version from the host and the CLI", () => {
		expect(PIER_HOST_VERSION).toBe(version);
		const cli = readFileSync(join(root, "packages/client/src/cli.ts"), "utf8");
		expect(/PIER_CLI_VERSION = "([^"]+)"/.exec(cli)?.[1]).toBe(version);
	});

	it("has a changelog entry for the current version", () => {
		expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(`## v${version}`);
	});
});
