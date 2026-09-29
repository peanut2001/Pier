/**
 * Let pi find Photon's WebAssembly binary inside a packaged app.
 *
 * pi resizes every image (user attachments and tool results) with Photon before sending it
 * to the model. `@silvia-odwyer/photon-node` loads `photon_rs_bg.wasm` with
 * `require("fs").readFileSync(__dirname + "/photon_rs_bg.wasm")`, and `bun build --compile`
 * bakes the build machine's `__dirname` into the sidecar. pi's own fallback then only looks
 * next to the executable, in `<exe dir>/photon`, and in the working directory, but the desktop
 * app ships the file in its `pi-assets` resource directory (`PI_PACKAGE_DIR`). Without a hit
 * Photon fails to load and pi replaces every image with
 * "[Image omitted: could not be resized below the inline image size limit.]". The bug is
 * invisible on the build machine, where the baked path still exists.
 *
 * This installs a narrow `fs.readFileSync` redirect: reads of `photon_rs_bg.wasm` are served
 * from the first bundled directory that has the file, so the sidecar never depends on the
 * build machine's path; all other reads pass through untouched. pi wraps (and later restores)
 * the current `readFileSync` around its own lazy Photon import, so installing this once at
 * start-up chains cleanly with pi's patch.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PHOTON_WASM_FILENAME = "photon_rs_bg.wasm";

type ReadFileSync = (...args: unknown[]) => unknown;

// The same module object that photon-node's `require("fs")` returns.
const fs = createRequire(import.meta.url)("fs") as { readFileSync: ReadFileSync; existsSync(path: string): boolean };

let servedFrom: string | undefined;

/** The bundled wasm file the redirect last served, if any (for diagnostics). */
export function photonWasmServedFrom(): string | undefined {
	return servedFrom;
}

/**
 * Directories that may hold the bundled wasm: `PI_PACKAGE_DIR` (the desktop app's `pi-assets`)
 * and the executable's directory (the standalone sidecar layout from `build-sidecar.mjs`).
 */
export function photonWasmDirs(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string[] {
	const dirs: string[] = [];
	const packageDir = env.PI_PACKAGE_DIR?.trim();
	if (packageDir) dirs.push(packageDir);
	dirs.push(dirname(execPath));
	return dirs;
}

function pathOf(file: unknown): string | undefined {
	if (typeof file === "string") return file;
	if (file instanceof URL && file.protocol === "file:") return fileURLToPath(file);
	return undefined;
}

/**
 * Serve `photon_rs_bg.wasm` reads from the first of `dirs` that contains the file.
 * Returns a function that removes the redirect again (if nothing replaced it meanwhile).
 */
export function installPhotonWasmRedirect(dirs: readonly string[] = photonWasmDirs()): () => void {
	const original = fs.readFileSync;
	const patched: ReadFileSync = (...args) => {
		const requested = pathOf(args[0]);
		if (requested?.endsWith(PHOTON_WASM_FILENAME)) {
			for (const dir of dirs) {
				const candidate = join(dir, PHOTON_WASM_FILENAME);
				if (fs.existsSync(candidate)) {
					const bytes = original.apply(fs, [candidate, ...args.slice(1)]);
					servedFrom = candidate;
					return bytes;
				}
			}
		}
		return original.apply(fs, args);
	};
	fs.readFileSync = patched;
	return () => {
		if (fs.readFileSync === patched) fs.readFileSync = original;
	};
}

// A 4x4 PNG; the 2x2 limit below forces pi through Photon's decode, resize and encode.
const SAMPLE_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8y4AALAxEcQA0BwELeIS5cwAAAABJRU5ErkJggg==";

export interface ImageSupportCheck {
	ok: boolean;
	/** The bundled wasm the redirect served, or undefined when Photon was loaded from elsewhere. */
	wasm?: string;
	error?: string;
}

/** Resize a sample image through pi (as for real attachments) and report whether it worked. */
export async function checkImageSupport(): Promise<ImageSupportCheck> {
	const { resizeImage } = await import("@earendil-works/pi-coding-agent");
	try {
		const bytes = new Uint8Array(Buffer.from(SAMPLE_PNG, "base64"));
		const resized = await resizeImage(bytes, "image/png", { maxWidth: 2, maxHeight: 2 });
		const wasm = photonWasmServedFrom();
		if (!resized)
			return { ok: false, ...(wasm ? { wasm } : {}), error: "pi could not load Photon or resize the image" };
		if (resized.width !== 2 || resized.height !== 2) {
			return { ok: false, error: `unexpected resize result ${resized.width}x${resized.height}` };
		}
		return { ok: true, ...(wasm ? { wasm } : {}) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
