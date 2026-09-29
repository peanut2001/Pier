import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	checkImageSupport,
	installPhotonWasmRedirect,
	PHOTON_WASM_FILENAME,
	photonWasmDirs,
	photonWasmServedFrom,
} from "../src/pi/photon-wasm.ts";

// photon-node reads its wasm through the CommonJS `fs` module object.
const cjsFs = createRequire(import.meta.url)("fs") as typeof import("node:fs");

const root = mkdtempSync(join(tmpdir(), "pier-photon-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const assets = join(root, "pi-assets");
mkdirSync(assets);
writeFileSync(join(assets, PHOTON_WASM_FILENAME), "bundled-wasm");
const buildDir = join(root, "build-machine/node_modules/@silvia-odwyer/photon-node");
const baked = join(buildDir, PHOTON_WASM_FILENAME);

describe("installPhotonWasmRedirect", () => {
	let restore: (() => void) | undefined;
	afterEach(() => {
		restore?.();
		restore = undefined;
		rmSync(join(root, "build-machine"), { recursive: true, force: true });
	});

	it("serves the wasm from the bundle when the baked build path is missing", () => {
		expect(() => cjsFs.readFileSync(baked)).toThrow(/ENOENT/);

		restore = installPhotonWasmRedirect([join(root, "empty"), assets]);
		expect(cjsFs.readFileSync(baked).toString()).toBe("bundled-wasm");
		expect(cjsFs.readFileSync(pathToFileURL(baked), "utf8")).toBe("bundled-wasm");
		expect(photonWasmServedFrom()).toBe(join(assets, PHOTON_WASM_FILENAME));
	});

	it("prefers the bundle even when the build machine's path still exists", () => {
		mkdirSync(buildDir, { recursive: true });
		writeFileSync(baked, "build-machine-wasm");

		restore = installPhotonWasmRedirect([assets]);
		expect(cjsFs.readFileSync(baked, "utf8")).toBe("bundled-wasm");
	});

	it("falls through to the requested path when no bundle has the file", () => {
		mkdirSync(buildDir, { recursive: true });
		writeFileSync(baked, "build-machine-wasm");

		restore = installPhotonWasmRedirect([join(root, "empty")]);
		expect(cjsFs.readFileSync(baked, "utf8")).toBe("build-machine-wasm");
		rmSync(baked);
		expect(() => cjsFs.readFileSync(baked)).toThrow(/ENOENT/);
	});

	it("leaves other reads alone and restores readFileSync", () => {
		const before = cjsFs.readFileSync;
		restore = installPhotonWasmRedirect([assets]);
		expect(() => cjsFs.readFileSync(join(buildDir, "other.wasm"))).toThrow(/ENOENT/);
		expect(() => cjsFs.readFileSync(root, "utf8")).toThrow(/EISDIR/);

		restore();
		restore = undefined;
		expect(cjsFs.readFileSync).toBe(before);
		expect(() => cjsFs.readFileSync(baked)).toThrow(/ENOENT/);
		expect(readFileSync(join(assets, PHOTON_WASM_FILENAME), "utf8")).toBe("bundled-wasm");
	});

	it("searches PI_PACKAGE_DIR, then the executable's directory", () => {
		expect(photonWasmDirs({ PI_PACKAGE_DIR: assets }, "/opt/pier/pier-host")).toEqual([assets, "/opt/pier"]);
		expect(photonWasmDirs({ PI_PACKAGE_DIR: "  " }, "/opt/pier/pier-host")).toEqual(["/opt/pier"]);
		expect(photonWasmDirs({}, "/opt/pier/pier-host")).toEqual(["/opt/pier"]);
	});
});

describe("checkImageSupport", () => {
	it("resizes a sample image through pi with the real Photon wasm", async () => {
		const photonDir = join(
			createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve(
				"@silvia-odwyer/photon-node/package.json",
			),
			"..",
		);
		const restore = installPhotonWasmRedirect([photonDir]);
		try {
			await expect(checkImageSupport()).resolves.toMatchObject({ ok: true });
		} finally {
			restore();
		}
	});
});
