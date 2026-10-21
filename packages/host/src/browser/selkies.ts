/** A private X11 display, a host-native browser, and a token-protected Selkies stream. */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { IceServer } from "@pier/crypto";
import { type BrowserCommand, type BrowserTransport, PierProtocolError } from "@pier/protocol";
import { findExecutable } from "../runtimes/executable.ts";
import type { BrowserProcess } from "./browsers.ts";
import { ChromiumBrowser, findChromium } from "./chromium.ts";

export interface RemoteBrowserProcess extends BrowserProcess {
	port: number;
	token: string;
	setTransport(transport: BrowserTransport): Promise<void>;
}
export interface RemoteBrowserLaunch {
	profile: string;
	url: string;
	transport: BrowserTransport;
	iceServers: IceServer[];
	signal?: AbortSignal;
	onExit(): void;
}

/** FamilyWild Xauthority cookie, with no X11 TCP listener or access-control bypass. */
export function xAuthority(cookie: Uint8Array): Buffer {
	const fields = [Buffer.alloc(0), Buffer.alloc(0), Buffer.from("MIT-MAGIC-COOKIE-1"), Buffer.from(cookie)];
	return Buffer.concat([
		Buffer.from([255, 255]),
		...fields.flatMap((field) => {
			const length = Buffer.alloc(2);
			length.writeUInt16BE(field.length);
			return [length, field];
		}),
	]);
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (!address || typeof address === "string") throw new Error("无法分配浏览器端口");
	return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
	if (!child.pid) return;
	const signal = (name: NodeJS.Signals | 0): boolean => {
		try {
			// Each helper owns its process group, including an AppImage's child processes.
			process.kill(-(child.pid as number), name);
			return true;
		} catch {
			return false;
		}
	};
	if (!signal("SIGTERM")) return;
	const deadline = Date.now() + 2000;
	while (signal(0) && Date.now() < deadline) await delay(50);
	// A helper can exit before its children. Do not cancel escalation just because the leader exits.
	signal("SIGKILL");
}

export class SelkiesBrowser implements RemoteBrowserProcess {
	port = 0;
	readonly token = randomBytes(32).toString("base64url");
	private readonly master = randomBytes(32).toString("base64url");
	private readonly children: ChildProcess[] = [];
	private browser?: ChromiumBrowser;
	private closed = false;
	private closing?: Promise<void>;
	private constructor(
		private readonly runtime: string,
		private readonly onExit: () => void,
	) {}

	static async start(options: RemoteBrowserLaunch): Promise<SelkiesBrowser> {
		if (process.platform !== "linux")
			throw new PierProtocolError("UNSUPPORTED", "远程浏览器目前支持 Linux 主机；本机浏览器支持所有桌面平台");
		const selkies = findExecutable(
			"selkies",
			process.env.PIER_SELKIES_BIN,
			join(homedir(), ".local/share/pier/selkies-2.1.0/AppRun"),
		);
		const xvfb = findExecutable("Xvfb", process.env.PIER_XVFB_BIN);
		if (!selkies || !xvfb)
			throw new PierProtocolError(
				"UNSUPPORTED",
				"远程主机需要 Selkies 2.1.0 或更新版本、Xvfb 和 Chromium。请按 README 的远程浏览器安装步骤配置；可用 PIER_SELKIES_BIN 指定 Selkies 路径。",
			);
		options.signal?.throwIfAborted();
		const executable = findChromium();
		const session = new SelkiesBrowser(mkdtempSync(join(tmpdir(), "pier-browser-")), options.onExit);
		const abort = () => {
			void session.close();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			await session.start(selkies, xvfb, executable, options);
			if (session.closed) throw new Error("远程浏览器启动过程中已关闭");
			return session;
		} catch (error) {
			await session.close();
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
	}

	private launch(executable: string, args: string[], env: NodeJS.ProcessEnv, displayFd = false): ChildProcess {
		const child = spawn(executable, args, {
			env,
			detached: true,
			stdio: displayFd ? ["ignore", "ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
		});
		this.children.push(child);
		child.stderr?.resume(); // Never print URLs, session credentials, or browser diagnostics.
		child.once("error", () => {
			void this.close();
		});
		child.once("exit", () => {
			void this.close();
		});
		return child;
	}

	private async start(selkies: string, xvfb: string, executable: string, options: RemoteBrowserLaunch): Promise<void> {
		const auth = join(this.runtime, "Xauthority");
		writeFileSync(auth, xAuthority(randomBytes(16)), { mode: 0o600 });
		const display = this.launch(
			xvfb,
			[
				"-displayfd",
				"3",
				"-auth",
				auth,
				"-screen",
				"0",
				"1440x900x24",
				"-nolisten",
				"tcp",
				"-noreset",
				"-s",
				"0",
				"+extension",
				"RANDR",
			],
			process.env,
			true,
		);
		const number = await new Promise<string>((resolve, reject) => {
			let data = "";
			const timer = setTimeout(() => reject(new Error("远程显示启动超时，请检查 Xvfb")), 10_000);
			const fail = () => {
				clearTimeout(timer);
				reject(new Error("远程显示启动失败，请检查 Xvfb"));
			};
			display.once("error", fail);
			display.once("exit", fail);
			(display.stdio[3] as Readable).on("data", (chunk: Buffer) => {
				data += chunk.toString();
				if (/^\d+\n$/.test(data)) {
					clearTimeout(timer);
					display.off("error", fail);
					display.off("exit", fail);
					resolve(data.trim());
				} else if (data.length > 32) fail();
			});
		});
		if (this.closed) throw new Error("远程显示已关闭");
		const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${number}`, XAUTHORITY: auth };
		delete env.WAYLAND_DISPLAY;
		mkdirSync(options.profile, { recursive: true, mode: 0o700 });
		const downloads = join(options.profile, "Downloads");
		mkdirSync(downloads, { recursive: true, mode: 0o700 });
		this.browser = await ChromiumBrowser.start(
			options.profile,
			options.url,
			undefined,
			() => {
				void this.close();
			},
			{
				executable,
				env,
				downloadDir: downloads,
				args: ["--ozone-platform=x11", "--window-position=0,0", "--window-size=1440,900"],
			},
		);
		if (this.closed) {
			await this.browser.close();
			throw new Error("远程浏览器已关闭");
		}
		this.port = await freePort();
		if (this.closed) throw new Error("远程浏览器已关闭");
		const rtc = join(this.runtime, "rtc.json");
		writeFileSync(rtc, JSON.stringify({ iceServers: options.iceServers }), { mode: 0o600 });
		this.launch(
			selkies,
			[
				"--addr=127.0.0.1",
				`--port=${this.port}`,
				"--enable-https=false",
				"--enable-basic-auth=false",
				`--mode=${options.transport}`,
				"--enable-dual-mode=true",
				"--encoder=h264enc,vp8enc,jpeg",
				"--framerate=30",
				"--manual-resolution=true",
				"--manual-width=1440",
				"--manual-height=900",
				"--audio-enabled=false",
				"--command-enabled=false",
				"--clipboard-seamless=false",
				`--file-manager-path=${downloads}`,
				"--frame-ancestors='self',tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420",
			],
			{
				...env,
				SELKIES_MASTER_TOKEN: this.master,
				SELKIES_PUBLIC: "false",
				SELKIES_SUBFOLDER: "",
				SELKIES_UNIX_SOCKET: "",
				SELKIES_TOKENS_FILE: "",
				SELKIES_WAYLAND: "false",
				SELKIES_RTC_CONFIG_JSON: process.env.PIER_BROWSER_RTC_CONFIG || rtc,
			},
		);
		const deadline = Date.now() + 25_000;
		while (!this.closed && Date.now() < deadline) {
			try {
				await this.post("/api/tokens", { [this.token]: { role: "controller", slot: null, mk_control: true } });
				return;
			} catch {
				await delay(200);
			}
		}
		throw new Error("Selkies 启动失败或超时，请确认版本至少为 2.1.0，且系统支持 H.264 编码");
	}
	private async post(path: string, body: unknown): Promise<void> {
		const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.master}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(path === "/api/switch" ? 20_000 : 2000),
			redirect: "error",
		});
		await response.body?.cancel();
		if (!response.ok) throw new Error("远程浏览器服务未就绪");
	}
	async setTransport(transport: BrowserTransport): Promise<void> {
		if (this.closed) throw new Error("远程浏览器已关闭");
		await this.post("/api/switch", { mode: transport });
	}
	action(command: BrowserCommand) {
		if (!this.browser || this.closed) return Promise.reject(new Error("远程浏览器已关闭"));
		return this.browser.action(command);
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = Promise.resolve().then(async () => {
			await Promise.allSettled([this.browser?.close(), ...this.children.map(stop)]);
			rmSync(this.runtime, { recursive: true, force: true });
		});
		this.onExit();
		return this.closing;
	}
}
