import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type AgentConfigRuntime, type AgentInstallationStatus, PierProtocolError } from "@pier/protocol";
import { probeVersion } from "./executable.ts";
import { configureInstallationPath } from "./installation-path.ts";
import { publishAgentCommand, sharedAgentExecutable, sharedAgentPaths } from "./shared-installation.ts";

const CLAUDE_DOWNLOADS = "https://downloads.claude.ai/claude-code-releases";
const CODEX_RELEASE = "https://api.github.com/repos/openai/codex/releases/latest";
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const CHECKSUM = /^[a-f0-9]{64}$/i;
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

export function installationTarget(
	platform = process.platform,
	arch = process.arch,
): {
	claude: string;
	codex: string;
} {
	if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
		throw new PierProtocolError("UNSUPPORTED", `暂不支持在 ${platform}/${arch} 上自动安装 Agent`);
	}
	const musl =
		platform === "linux" && (existsSync("/lib/libc.musl-x86_64.so.1") || existsSync("/lib/libc.musl-aarch64.so.1"));
	return {
		claude: `${platform}-${arch}${musl ? "-musl" : ""}`,
		codex: `${arch === "arm64" ? "aarch64" : "x86_64"}-${
			platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"
		}`,
	};
}

export interface AgentInstallerOptions {
	/** Defaults to the OS user's home; tests use a separate temporary home. */
	homeDirectory?: string;
	configurePath?: typeof configureInstallationPath;
	fetch?: typeof fetch;
	probe?: typeof probeVersion;
	onInstalled?: (runtime: AgentConfigRuntime) => Promise<void> | void;
}

interface Release {
	version: string;
	url: string;
	checksum: string;
	archive: boolean;
}

/** Verified native releases, with public user-level commands shared by Pier and external terminals. */
export class AgentInstaller {
	private readonly statuses = new Map<AgentConfigRuntime, AgentInstallationStatus>();
	private readonly jobs = new Map<AgentConfigRuntime, { abort: AbortController; done: Promise<void> }>();
	private closed = false;

	constructor(
		private readonly directory: string,
		private readonly options: AgentInstallerOptions = {},
	) {}

	/** Prefer the shared command; retain old Pier-only installations until the next install/update. */
	static executable(directory: string, runtime: AgentConfigRuntime, homeDirectory = homedir()): string | undefined {
		const shared = sharedAgentExecutable(runtime, homeDirectory);
		if (shared) return shared;
		try {
			// Reading is deliberately synchronous: executable discovery is synchronous too.
			const text = readFileSync(join(directory, runtime, "current.json"), "utf8");
			const relative: unknown = JSON.parse(text).executable;
			if (typeof relative !== "string") return undefined;
			const root = resolve(directory, runtime);
			const path = resolve(root, relative);
			return path.startsWith(`${root}${sep}`) && existsSync(path) ? path : undefined;
		} catch {
			return undefined;
		}
	}

	status(runtime: AgentConfigRuntime): AgentInstallationStatus {
		return this.statuses.get(runtime) ?? { runtime, state: "idle" };
	}

	start(runtime: AgentConfigRuntime): AgentInstallationStatus {
		if (this.closed) throw new PierProtocolError("CONFLICT", "Pier Host 正在退出");
		if (this.jobs.has(runtime)) throw new PierProtocolError("CONFLICT", "这个 Agent 正在安装，请等待完成");
		installationTarget();
		const abort = new AbortController();
		this.statuses.set(runtime, { runtime, state: "checking" });
		// Queue the job so it is registered before any asynchronous work can finish.
		const done = Promise.resolve()
			.then(() => this.install(runtime, abort.signal))
			.finally(() => this.jobs.delete(runtime));
		this.jobs.set(runtime, { abort, done });
		return this.status(runtime);
	}

	private update(runtime: AgentConfigRuntime, fields: Partial<AgentInstallationStatus>): void {
		this.statuses.set(runtime, { ...this.status(runtime), ...fields });
	}

	private async response(url: string, signal: AbortSignal, timeoutMs = 60_000): Promise<Response> {
		const response = await (this.options.fetch ?? fetch)(url, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
			headers: { "User-Agent": "Pier-Agent-Installer", Accept: "application/json" },
		});
		if (!response.ok) throw new Error(`官方下载失败（HTTP ${response.status}），请检查网络后重试`);
		return response;
	}

	private async release(runtime: AgentConfigRuntime, signal: AbortSignal): Promise<Release> {
		const target = installationTarget();
		if (runtime === "claude-code") {
			const version = (await (await this.response(`${CLAUDE_DOWNLOADS}/latest`, signal)).text()).trim();
			if (!VERSION.test(version)) throw new Error("Claude Code 官方服务返回了无效版本");
			const manifest = (await (await this.response(`${CLAUDE_DOWNLOADS}/${version}/manifest.json`, signal)).json()) as {
				platforms?: Record<string, { checksum?: string }>;
			};
			const checksum = manifest.platforms?.[target.claude]?.checksum;
			if (!checksum || !CHECKSUM.test(checksum)) throw new Error("Claude Code 官方清单缺少当前平台的 SHA-256 校验值");
			return {
				version,
				checksum,
				archive: false,
				url: `${CLAUDE_DOWNLOADS}/${version}/${target.claude}/claude${process.platform === "win32" ? ".exe" : ""}`,
			};
		}
		const release = (await (await this.response(CODEX_RELEASE, signal)).json()) as {
			tag_name?: string;
			assets?: Array<{ name: string; browser_download_url: string; digest?: string }>;
		};
		const version = release.tag_name?.replace(/^rust-v/, "") ?? "";
		if (!VERSION.test(version)) throw new Error("Codex 官方服务返回了无效版本");
		const asset = release.assets?.find((a) => a.name === `codex-package-${target.codex}.tar.gz`);
		const checksum = asset?.digest?.replace(/^sha256:/, "");
		if (!asset || !checksum || !CHECKSUM.test(checksum))
			throw new Error("Codex 官方发行包缺少当前平台的 SHA-256 校验值");
		// Only official release assets may be downloaded; no URLs or commands supplied by clients.
		if (!asset.browser_download_url.startsWith("https://github.com/openai/codex/releases/download/")) {
			throw new Error("Codex 官方发行包地址无效");
		}
		return { version, checksum, archive: true, url: asset.browser_download_url };
	}

	private async download(
		runtime: AgentConfigRuntime,
		release: Release,
		path: string,
		signal: AbortSignal,
	): Promise<void> {
		const response = await this.response(release.url, signal, 600_000);
		if (!response.body) throw new Error("官方下载内容为空");
		const total = Number(response.headers.get("content-length")) || undefined;
		if (total && total > MAX_DOWNLOAD_BYTES) throw new Error("官方下载文件过大");
		this.update(runtime, { state: "downloading", downloadedBytes: 0, ...(total ? { totalBytes: total } : {}) });
		const hash = createHash("sha256");
		let bytes = 0;
		const progress = new Transform({
			transform: (chunk: Buffer, _encoding, callback) => {
				bytes += chunk.length;
				if (bytes > MAX_DOWNLOAD_BYTES) return callback(new Error("官方下载文件过大"));
				hash.update(chunk);
				this.update(runtime, { downloadedBytes: bytes });
				callback(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
			progress,
			createWriteStream(path, { mode: 0o700 }),
			{ signal },
		);
		this.update(runtime, { state: "verifying" });
		if (hash.digest("hex").toLowerCase() !== release.checksum.toLowerCase()) {
			throw new Error("SHA-256 校验失败，下载文件未安装，请重试");
		}
	}

	private async install(runtime: AgentConfigRuntime, signal: AbortSignal): Promise<void> {
		let staging: string | undefined;
		const timeout = setTimeout(
			() => this.jobs.get(runtime)?.abort.abort(new Error("安装超过 10 分钟，请检查网络后重试")),
			600_000,
		);
		timeout.unref?.();
		try {
			const home = this.options.homeDirectory ?? homedir();
			const paths = sharedAgentPaths(runtime, home);
			const release = await this.release(runtime, signal);
			this.update(runtime, { version: release.version });
			const current = AgentInstaller.executable(this.directory, runtime, home);
			const upToDate = current && (await (this.options.probe ?? probeVersion)(current)) === release.version;
			if (upToDate && sharedAgentExecutable(runtime, home)) {
				signal.throwIfAborted();
				await (this.options.configurePath ?? configureInstallationPath)(paths.bin, { home });
				await this.options.onInstalled?.(runtime);
				this.update(runtime, { state: "ready" });
				return;
			}
			const root = paths.versions;
			await mkdir(root, { recursive: true, mode: 0o700 });
			staging = await mkdtemp(join(root, ".install-"));
			const filename = `${runtime === "codex" ? "codex" : "claude"}${process.platform === "win32" ? ".exe" : ""}`;
			const downloaded = join(staging, release.archive ? "download.tar.gz" : filename);
			if (upToDate && current) {
				// Migrate an already verified Pier-only installation even when its version is latest.
				if (release.archive) await cp(dirname(current), join(staging, "bin"), { recursive: true });
				else await cp(current, downloaded);
			} else {
				await this.download(runtime, release, downloaded, signal);
			}
			this.update(runtime, { state: "installing" });
			if (release.archive && !upToDate) {
				const extractionDirectory = staging;
				await new Promise<void>((resolve, reject) =>
					execFile(
						"tar",
						["-xzf", downloaded, "-C", extractionDirectory],
						{ signal, timeout: 120_000, windowsHide: true },
						(error) =>
							error ? reject(new Error(`解压 Codex 失败，请确认系统已安装 tar：${error.message}`)) : resolve(),
					),
				);
				await rm(downloaded);
			}
			const executable = join(staging, ...(release.archive ? ["bin", filename] : [filename]));
			await chmod(executable, 0o755);
			signal.throwIfAborted();
			const version = await (this.options.probe ?? probeVersion)(executable, 15_000);
			if (version !== release.version) throw new Error("安装后版本验证失败，已保留之前的 Agent，请重试");
			signal.throwIfAborted();
			const name = `${release.version}-${randomUUID()}`;
			const destination = join(root, name);
			await rename(staging, destination);
			staging = destination;
			await (this.options.configurePath ?? configureInstallationPath)(paths.bin, { home });
			signal.throwIfAborted();
			// Retain this verified release if publication/rollback encounters a filesystem error.
			staging = undefined;
			await publishAgentCommand(
				runtime,
				join(destination, ...(release.archive ? ["bin", filename] : [filename])),
				home,
			);
			await this.options.onInstalled?.(runtime);
			this.update(runtime, { state: "ready" });
		} catch (error) {
			this.update(runtime, { state: "error", error: error instanceof Error ? error.message : String(error) });
		} finally {
			clearTimeout(timeout);
			if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
		}
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		for (const job of this.jobs.values()) job.abort.abort(new Error("Pier Host 已停止安装"));
		await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
	}
}
