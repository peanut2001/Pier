import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserPreparationProgress } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntimeInstaller, type BrowserRuntimeInstallerOptions } from "../src/browser/installation.ts";

const VERSION = "156.0.8078.47";
const bytes = Buffer.from("test browser archive");
const md5 = createHash("md5").update(bytes).digest("base64");
describe("automatic remote browser preparation", () => {
	let root: string;
	const installers: BrowserRuntimeInstaller[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-browser-install-"));
		for (const key of ["PIER_SELKIES_BIN", "PIER_BROWSER_BIN", "PIER_XVFB_BIN", "PIER_OPENBOX_BIN"])
			vi.stubEnv(key, "");
	});
	afterEach(async () => {
		await Promise.all(installers.splice(0).map((i) => i.shutdown()));
		rmSync(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});
	function setup(overrides: BrowserRuntimeInstallerOptions = {}) {
		const target = overrides.arch === "arm64" ? "linux-arm64" : "linux64";
		const find = vi.fn((name: string, override?: string, managed?: string): string | undefined => {
			if (override) return undefined;
			if (managed && existsSync(managed)) return managed;
			return ["selkies", "Xvfb", "openbox", "unzip"].includes(name) ? join(root, name) : undefined;
		});
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
			String(url).endsWith(".json")
				? Response.json({ channels: { Stable: { version: VERSION } } })
				: new Response(new Uint8Array(bytes), {
						headers: { "content-length": String(bytes.length), "x-goog-hash": `md5=${md5}` },
					}),
		);
		const run = vi.fn<NonNullable<BrowserRuntimeInstallerOptions["run"]>>(async (_file, args) => {
			if (args[0] === "-Z1") return `chrome-${target}/chrome\nchrome-${target}/resources/file`;
			if (args[0] === "-q") {
				const path = join(args[3] as string, `chrome-${target}`);
				mkdirSync(path, { recursive: true });
				writeFileSync(join(path, "chrome"), "installed browser");
			}
			return "";
		});
		const options: BrowserRuntimeInstallerOptions = {
			platform: "linux",
			arch: "x64",
			uid: 1000,
			find,
			chromium: () => undefined,
			fetch,
			run,
			probe: async () => VERSION,
			...overrides,
		};
		const installer = new BrowserRuntimeInstaller(root, options);
		installers.push(installer);
		return { installer, fetch, run, find, options };
	}
	it("reuses existing installations without network access or package operations", async () => {
		const { installer, fetch, run } = setup({ chromium: () => "/existing/chrome" });
		expect(await installer.ensure()).toMatchObject({ chromium: "/existing/chrome", xvfb: join(root, "Xvfb") });
		expect(fetch).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});
	it.each(["x64", "arm64"])("downloads a private browser for %s and reuses it after restart", async (arch) => {
		const { installer, fetch, run, options } = setup({ arch });
		const progress: BrowserPreparationProgress[] = [];
		const paths = await installer.ensure((p) => progress.push(p));
		expect(paths.chromium.startsWith(root)).toBe(true);
		expect(readFileSync(paths.chromium, "utf8")).toBe("installed browser");
		expect(progress.map((p) => p.stage)).toEqual(
			expect.arrayContaining(["checking", "downloading", "verifying", "installing", "starting"]),
		);
		expect(fetch.mock.calls[1]?.[0]).toBe(
			`https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${arch === "x64" ? "linux64" : "linux-arm64"}/chrome-${arch === "x64" ? "linux64" : "linux-arm64"}.zip`,
		);
		fetch.mockClear();
		run.mockClear();
		const restarted = new BrowserRuntimeInstaller(root, options);
		installers.push(restarted);
		expect(await restarted.ensure()).toEqual(paths);
		expect(fetch).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(readdirSync(root).some((name) => name.startsWith(".install-"))).toBe(false);
	});
	it("refuses corrupt Selkies bytes before executing them and removes temporary files", async () => {
		const { installer, run } = setup({
			chromium: () => "/existing/chrome",
			find: (name) => (["Xvfb", "openbox"].includes(name) ? `/bin/${name}` : undefined),
		});
		await expect(installer.ensure()).rejects.toThrow("校验失败");
		expect(run).not.toHaveBeenCalled();
		expect(readdirSync(root)).toEqual([]);
		expect(existsSync(`${root}.lock`)).toBe(false);
	});
	it("rejects invalid archive paths and missing download checksums", async () => {
		const unsafe = setup({ run: async () => "chrome-linux64/../../escape" });
		await expect(unsafe.installer.ensure()).rejects.toThrow("无效路径");
		const missing = setup({
			fetch: async (url) =>
				String(url).endsWith(".json")
					? Response.json({ channels: { Stable: { version: VERSION } } })
					: new Response(new Uint8Array(bytes)),
		});
		await expect(missing.installer.ensure()).rejects.toThrow("校验信息");
		expect(missing.run).not.toHaveBeenCalled();
	});
	it("shares one download and keeps it alive when only one waiting workspace cancels", async () => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		const download = vi.fn<typeof globalThis.fetch>(async (url) =>
			String(url).endsWith(".json")
				? Response.json({ channels: { Stable: { version: VERSION } } })
				: new Response(
						new ReadableStream<Uint8Array>({
							start(c) {
								stream = c;
							},
						}),
						{ headers: { "x-goog-hash": `md5=${md5}` } },
					),
		);
		const { installer } = setup({ fetch: download });
		const abort = new AbortController();
		const first = installer.ensure(() => {}, abort.signal);
		const failed = expect(first).rejects.toThrow("取消");
		const second = installer.ensure();
		await vi.waitFor(() => expect(stream).toBeDefined());
		abort.abort();
		await failed;
		stream?.enqueue(new Uint8Array(bytes));
		stream?.close();
		expect((await second).chromium).toContain(`chrome-${VERSION}`);
		// One manifest and one archive for both waiting workspaces.
		expect(download).toHaveBeenCalledTimes(2);
	});
	it("cancels the final waiter, cleans its staging area, and allows retry", async () => {
		let pending = true;
		const { installer } = setup({
			fetch: async (url) =>
				String(url).endsWith(".json")
					? Response.json({ channels: { Stable: { version: VERSION } } })
					: new Response(
							pending
								? new ReadableStream<Uint8Array>({
										start(c) {
											c.enqueue(new Uint8Array(bytes));
										},
									})
								: new Uint8Array(bytes),
							{ headers: { "x-goog-hash": `md5=${md5}` } },
						),
		});
		const abort = new AbortController();
		let downloading = false;
		const first = installer.ensure((p) => {
			if (p.stage === "downloading") downloading = true;
		}, abort.signal);
		const failed = expect(first).rejects.toThrow("取消");
		await vi.waitFor(() => expect(downloading).toBe(true));
		abort.abort();
		await failed;
		pending = false;
		expect((await installer.ensure()).chromium).toContain(`chrome-${VERSION}`);
		expect(readdirSync(root).some((name) => name.startsWith(".install-"))).toBe(false);
	});
	it("installs a missing display server without upgrading installed system packages", async () => {
		let installed = false;
		const run = vi.fn<NonNullable<BrowserRuntimeInstallerOptions["run"]>>(async (_file, args) => {
			if (args[0] === "install") installed = true;
			return "";
		});
		const { installer } = setup({
			uid: 0,
			chromium: () => "/existing/chrome",
			find: (name) =>
				name === "Xvfb" && !installed
					? undefined
					: ["Xvfb", "openbox", "selkies", "apt-get"].includes(name)
						? `/bin/${name}`
						: undefined,
			run,
		});
		expect((await installer.ensure()).xvfb).toBe("/bin/Xvfb");
		expect(run).toHaveBeenCalledWith(
			"/bin/apt-get",
			["install", "-y", "--no-install-recommends", "--no-upgrade", "xvfb"],
			{ system: true },
		);
	});
	it("adds window management to an existing browser installation without downloading it again", async () => {
		let installed = false;
		const run = vi.fn<NonNullable<BrowserRuntimeInstallerOptions["run"]>>(async (_file, args) => {
			if (args.includes("install")) installed = true;
			return "";
		});
		const { installer, fetch } = setup({
			chromium: () => "/existing/chrome",
			find: (name) =>
				name === "openbox" && !installed
					? undefined
					: ["Xvfb", "openbox", "selkies", "apt-get", "sudo"].includes(name)
						? `/bin/${name}`
						: undefined,
			run,
		});
		expect((await installer.ensure()).openbox).toBe("/bin/openbox");
		expect(run).toHaveBeenCalledWith("/bin/sudo", ["-n", "true"], expect.anything());
		expect(run).toHaveBeenCalledWith(
			"/bin/sudo",
			[
				"-n",
				"--",
				"env",
				"DEBIAN_FRONTEND=noninteractive",
				"/bin/apt-get",
				"install",
				"-y",
				"--no-install-recommends",
				"--no-upgrade",
				"openbox",
			],
			{ system: true },
		);
		expect(fetch).not.toHaveBeenCalled();
		run.mockClear();
		await installer.ensure();
		expect(run).not.toHaveBeenCalled();
	});
	it("reports missing privileges without opening a password prompt or downloading components", async () => {
		const { installer, fetch, run } = setup({
			chromium: () => "/existing/chrome",
			find: (name) => (name === "apt-get" || name === "selkies" ? `/bin/${name}` : undefined),
		});
		await expect(installer.ensure()).rejects.toThrow("管理员权限");
		expect(fetch).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});
	it("rejects invalid explicit overrides and unsupported platforms without changing them", async () => {
		vi.stubEnv("PIER_SELKIES_BIN", "/missing/selkies");
		const { installer, fetch } = setup();
		await expect(installer.ensure()).rejects.toThrow("PIER_SELKIES_BIN");
		expect(fetch).not.toHaveBeenCalled();
		await expect(setup({ platform: "darwin" }).installer.ensure()).rejects.toThrow("Linux");
	});
});
