import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type HostProcess, type HostProcesses, PierProtocolError } from "@pier/protocol";

const MAX_PROCESSES = 8192;

function protectedPid(pid: number): boolean {
	return pid <= 1 || pid === process.pid || (process.platform === "win32" && pid === 4);
}

function row(data: Omit<HostProcess, "canTerminate">): HostProcess {
	return { ...data, name: data.name.slice(0, 256), canTerminate: !!data.startToken && !protectedPid(data.pid) };
}

/** /proc/stat's command can contain spaces, parentheses and newlines. Field 22 is start time. */
export function parseLinuxProcess(stat: string, status: string): HostProcess | undefined {
	const match = /^(\d+) \(([\s\S]*)\) ([\s\S]*)$/.exec(stat.trim());
	if (!match) return;
	const fields = (match[3] as string).split(/\s+/);
	const pid = Number(match[1]);
	const parentPid = Number(fields[1]);
	const startToken = fields[19];
	if (
		!Number.isInteger(pid) ||
		pid < 1 ||
		!Number.isInteger(parentPid) ||
		parentPid < 0 ||
		!startToken ||
		!/^\d+$/.test(startToken)
	)
		return;
	const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
	const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
	return row({
		pid,
		parentPid,
		name: match[2] as string,
		startToken,
		...(uid ? { user: uid } : {}),
		...(rss ? { memoryBytes: Number(rss) * 1024 } : {}),
	});
}

export function parseMacProcesses(text: string): HostProcess[] {
	const rows: HostProcess[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
			line,
		);
		if (!match) continue;
		rows.push(
			row({
				pid: Number(match[1]),
				parentPid: Number(match[2]),
				user: match[3],
				memoryBytes: Number(match[4]) * 1024,
				startToken: (match[5] as string).replace(/\s+/g, " "),
				name: basename(match[6] as string),
			}),
		);
	}
	return rows;
}

export function parseWindowsProcesses(text: string): HostProcess[] {
	const value: unknown = JSON.parse(text.replace(/^\uFEFF/, "").trim() || "[]");
	const rows: HostProcess[] = [];
	for (const item of Array.isArray(value) ? value : [value]) {
		if (!item || typeof item !== "object") continue;
		const { pid, name, memoryBytes, startToken } = item;
		if (!Number.isInteger(pid) || pid < 0 || typeof name !== "string") continue;
		rows.push(
			row({
				pid,
				name,
				...(Number.isFinite(memoryBytes) && memoryBytes >= 0 ? { memoryBytes } : {}),
				...(typeof startToken === "string" && /^\d+$/.test(startToken) ? { startToken } : {}),
			}),
		);
	}
	return rows;
}

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				timeout: 10_000,
				windowsHide: true,
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, LC_ALL: "C" },
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

async function linuxProcess(pid: number): Promise<HostProcess | undefined> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
		if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
		throw error;
	});
	if (stat === undefined) return;
	// Status can be unreadable even when stat is visible. Start identity is still useful.
	const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
	return parseLinuxProcess(stat, status);
}

async function windowsProcesses(pid?: number): Promise<HostProcess[]> {
	const script =
		"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $rows=@(); " +
		(pid === undefined ? "Get-Process" : `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`) +
		" | ForEach-Object { $start=$null; try { $start=$_.StartTime.ToUniversalTime().Ticks.ToString() } catch {}; " +
		"$rows+=@{pid=$_.Id;name=$_.ProcessName;memoryBytes=$_.WorkingSet64;startToken=$start} }; " +
		"ConvertTo-Json -InputObject @($rows) -Compress";
	return parseWindowsProcesses(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
}

async function macProcesses(pid?: number): Promise<HostProcess[]> {
	return parseMacProcesses(
		await run("/bin/ps", [
			"-ww",
			...(pid === undefined ? ["-ax"] : ["-p", String(pid)]),
			"-o",
			"pid=,ppid=,user=,rss=,lstart=,comm=",
		]).catch((error) => {
			// ps exits with 1 and only a heading (suppressed here) when the selected PID is gone.
			if (pid !== undefined && error.code === 1 && !error.stdout?.trim()) return "";
			throw error;
		}),
	);
}

async function readProcesses(): Promise<HostProcesses> {
	let processes: HostProcess[];
	let truncated = false;
	if (process.platform === "linux") {
		const pids = (await readdir("/proc"))
			.filter((name) => /^\d+$/.test(name))
			.map(Number)
			.sort((a, b) => a - b);
		truncated = pids.length > MAX_PROCESSES;
		const selected = pids.slice(0, MAX_PROCESSES);
		processes = [];
		// Bound open files on machines with many processes. Exits and permission failures are normal.
		let index = 0;
		await Promise.all(
			Array.from({ length: Math.min(32, selected.length) }, async () => {
				while (index < selected.length) {
					const pid = selected[index++] as number;
					const entry = await linuxProcess(pid).catch(() => undefined);
					if (entry) processes.push(entry);
				}
			}),
		);
	} else if (process.platform === "darwin") processes = await macProcesses();
	else if (process.platform === "win32") processes = await windowsProcesses();
	else throw new PierProtocolError("UNSUPPORTED", "这台主机的系统暂不支持进程管理");
	processes.sort((a, b) => a.pid - b.pid);
	return { processes: processes.slice(0, MAX_PROCESSES), truncated: truncated || processes.length > MAX_PROCESSES };
}

function processError(error: unknown): PierProtocolError {
	if (error instanceof PierProtocolError) return error;
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === "ESRCH") return new PierProtocolError("NOT_FOUND", "进程已退出，请刷新列表");
	if (code === "EACCES" || code === "EPERM")
		return new PierProtocolError("FORBIDDEN", "当前主机用户没有操作这个进程的权限");
	return new PierProtocolError("INTERNAL", "无法操作进程，请确认系统进程查询工具可用后重试");
}

/** Authenticated local and paired clients share samples; signals always recheck the live identity. */
export class HostProcessManager {
	private cached?: { time: number; result: HostProcesses };
	private pending?: Promise<HostProcesses>;
	private generation = 0;

	sample(): Promise<HostProcesses> {
		if (this.cached && Date.now() - this.cached.time < 1000) return Promise.resolve(this.cached.result);
		if (this.pending) return this.pending;
		const generation = this.generation;
		this.pending = readProcesses()
			.then((result) => {
				if (generation === this.generation) this.cached = { time: Date.now(), result };
				return result;
			})
			.catch((error) => {
				throw processError(error);
			})
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}

	async kill(pid: number, startToken: string, force = false): Promise<{ signalled: true }> {
		// Validate here too: never let pid=0 or a negative PID address a process group.
		if (!Number.isInteger(pid) || pid < 2 || pid > 2_147_483_647)
			throw new PierProtocolError("BAD_REQUEST", "无效的进程 PID");
		if (protectedPid(pid)) throw new PierProtocolError("FORBIDDEN", "不能结束系统核心进程或 Pier Host 自身");
		if (!["linux", "darwin", "win32"].includes(process.platform))
			throw new PierProtocolError("UNSUPPORTED", "这台主机的系统暂不支持进程管理");
		try {
			const current =
				process.platform === "linux"
					? await linuxProcess(pid)
					: process.platform === "darwin"
						? (await macProcesses(pid))[0]
						: process.platform === "win32"
							? (await windowsProcesses(pid))[0]
							: undefined;
			if (!current) throw new PierProtocolError("NOT_FOUND", "进程已退出，请刷新列表");
			if (!current.startToken) throw new PierProtocolError("FORBIDDEN", "无法验证进程启动时间，不能结束这个进程");
			if (current.startToken !== startToken)
				throw new PierProtocolError("CONFLICT", "这个 PID 已被其他进程使用，请刷新列表后重试");
			process.kill(pid, force ? "SIGKILL" : "SIGTERM");
			this.generation += 1;
			this.cached = undefined;
			return { signalled: true };
		} catch (error) {
			throw processError(error);
		}
	}
}
