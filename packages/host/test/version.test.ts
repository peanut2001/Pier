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
		for (const pkg of [
			"packages/protocol",
			"packages/client",
			"packages/chat-state",
			"packages/host",
			"apps/desktop",
		]) {
			expect(versionOf(`${pkg}/package.json`), pkg).toBe(version);
		}
	});

	it("reports the same version from the host and the CLI", () => {
		expect(PIER_HOST_VERSION).toBe(version);
		const cli = readFileSync(join(root, "packages/client/src/cli.ts"), "utf8");
		expect(/PIER_CLI_VERSION = "([^"]+)"/.exec(cli)?.[1]).toBe(version);
	});

	it("uses the same version for the desktop shell", () => {
		const cargo = readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
		expect(/^version = "([^"]+)"/m.exec(cargo)?.[1]).toBe(version);
		// tauri.conf.json takes its version from apps/desktop/package.json.
		const tauri = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")) as {
			version: string;
		};
		expect(tauri.version).toBe("../package.json");
		const store = readFileSync(join(root, "apps/desktop/src/lib/store.tsx"), "utf8");
		expect(/APP_VERSION = "([^"]+)"/.exec(store)?.[1]).toBe(version);
	});

	it("has a changelog entry for the current version", () => {
		expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(`## v${version}`);
	});
});
