import { execFile } from "node:child_process";
import { readdir, readFile, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, platform, totalmem, uptime } from "node:os";
import { join } from "node:path";
import type { HostStats } from "@pier/protocol";

/** Cumulative CPU time over all cores (ms). */
export interface CpuTimes {
	idle: number;
	total: number;
}

/** Cumulative bytes over the counted network interfaces. */
export interface NetTotals {
	rx: number;
	tx: number;
}

/** A sample taken this long after the previous one reuses it (several windows polling at once). */
const REUSE_MS = 1000;
/** When the previous sample is older than this, rates are measured over a short fresh window. */
const STALE_MS = 10_000;
/** Length of that fresh window. */
const BASELINE_MS = 400;
const COMMAND_TIMEOUT_MS = 3000;

export function readCpuTimes(list = cpus()): CpuTimes {
	let idle = 0;
	let total = 0;
	for (const cpu of list) {
		const t = cpu.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	return { idle, total };
}

/** Busy share of the CPU between two readings, 0–1. */
export function cpuUsage(before: CpuTimes, after: CpuTimes): number {
	const total = after.total - before.total;
	const idle = after.idle - before.idle;
	if (!(total > 0)) return 0;
	return Math.min(1, Math.max(0, 1 - idle / total));
}

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

/** `MemTotal` / `MemAvailable` from Linux `/proc/meminfo` (kB) as bytes. */
export function parseMeminfo(text: string): { total: number; available: number } | undefined {
	const value = (key: string) => {
		const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
		return match ? Number(match[1]) * 1024 : undefined;
	};
	const total = value("MemTotal");
	const available = value("MemAvailable");
	return total !== undefined && available !== undefined ? { total, available } : undefined;
}

/** Reclaimable memory from macOS `vm_stat` (free, inactive and speculative pages) in bytes. */
export function parseVmStat(text: string): number | undefined {
	const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
	const pages = (label: string) => {
		const match = new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(text);
		return match ? Number(match[1]) : undefined;
	};
	const free = pages("free");
	if (free === undefined) return undefined;
	return (free + (pages("inactive") ?? 0) + (pages("speculative") ?? 0)) * pageSize;
}

/**
 * Totals from Linux `/proc/net/dev`, counting only `interfaces` (all non-loopback ones when
 * omitted).
 */
export function parseProcNetDev(text: string, interfaces?: ReadonlySet<string>): NetTotals {
	let rx = 0;
	let tx = 0;
	for (const line of text.split("\n")) {
		const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
		if (!match) continue;
		const name = match[1] as string;
		if (name === "lo" || (interfaces && !interfaces.has(name))) continue;
		const fields = (match[2] as string).trim().split(/\s+/).map(Number);
		rx += fields[0] || 0;
		tx += fields[8] || 0;
	}
	return { rx, tx };
}

/**
 * Totals from macOS `netstat -ibn`: the link-level row of each `en*` interface (every
 * non-loopback interface when there is none).
 */
export function parseNetstatIbn(text: string): NetTotals | undefined {
	const rows: Array<{ name: string; rx: number; tx: number }> = [];
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (!parts[2]?.startsWith("<Link#")) continue;
		// Name Mtu Network [Address] Ipkts Ierrs Ibytes Opkts Oerrs Obytes [Coll]
		const hasAddress = parts.length >= 11;
		const rx = Number(parts[hasAddress ? 6 : 5]);
		const tx = Number(parts[hasAddress ? 9 : 8]);
		const name = (parts[0] as string).replace(/\*$/, "");
		if (!Number.isFinite(rx) || !Number.isFinite(tx) || name.startsWith("lo")) continue;
		rows.push({ name, rx, tx });
	}
	if (!rows.length) return undefined;
	const physical = rows.filter((r) => /^en\d+$/.test(r.name));
	let rx = 0;
	let tx = 0;
	for (const row of physical.length ? physical : rows) {
		rx += row.rx;
		tx += row.tx;
	}
	return { rx, tx };
}

/** Totals from Windows `netstat -e`: the first row with two counters is bytes (any locale). */
export function parseNetstatE(text: string): NetTotals | undefined {
	for (const line of text.split(/\r?\n/)) {
		const match = /^\S.*?\s+(\d+)\s+(\d+)\s*$/.exec(line);
		if (match) return { rx: Number(match[1]), tx: Number(match[2]) };
	}
	return undefined;
}

/** Linux interfaces backed by a device (Ethernet, Wi-Fi, …) rather than virtual ones. */
async function physicalLinuxInterfaces(): Promise<Set<string> | undefined> {
	try {
		const names = await readdir("/sys/class/net");
		const physical = new Set<string>();
		await Promise.all(
			names.map(async (name) => {
				try {
					await readdir(join("/sys/class/net", name, "device"));
					physical.add(name);
				} catch {
					// Virtual interface (loopback, bridge, veth, tunnel, …).
				}
			}),
		);
		return physical.size ? physical : undefined;
	} catch {
		return undefined;
	}
}

async function readMemory(os: string): Promise<{ total: number; used: number }> {
	const total = totalmem();
	try {
		if (os === "linux") {
			const info = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
			if (info) return { total: info.total, used: Math.max(0, info.total - info.available) };
		} else if (os === "darwin") {
			const available = parseVmStat(await run("vm_stat", []));
			if (available !== undefined) return { total, used: Math.max(0, total - Math.min(total, available)) };
		}
	} catch {
		// Fall back to the generic reading below.
	}
	return { total, used: Math.max(0, total - freemem()) };
}

async function readDisk(): Promise<HostStats["disk"]> {
	const path = homedir();
	try {
		const fs = await statfs(path);
		const total = fs.blocks * fs.bsize;
		if (!(total > 0)) return undefined;
		return { path, total, used: Math.max(0, (fs.blocks - fs.bfree) * fs.bsize), available: fs.bavail * fs.bsize };
	} catch {
		return undefined;
	}
}

export class HostStatsSampler {
	private previous: { at: number; cpu: CpuTimes; net: NetTotals | undefined } | undefined;
	private pending: { at: number; result: Promise<HostStats> } | undefined;
	private linuxInterfaces: Promise<Set<string> | undefined> | undefined;
	private readonly os = platform();

	/** Current usage; concurrent and back-to-back callers share one sample. */
	sample(): Promise<HostStats> {
		const now = Date.now();
		if (this.pending && now - this.pending.at < REUSE_MS) return this.pending.result;
		const result = this.take();
		this.pending = { at: now, result };
		result.catch(() => {
			if (this.pending?.result === result) this.pending = undefined;
		});
		return result;
	}

	private async readNet(): Promise<NetTotals | undefined> {
		try {
			if (this.os === "linux") {
				this.linuxInterfaces ??= physicalLinuxInterfaces();
				const interfaces = await this.linuxInterfaces;
				return parseProcNetDev(await readFile("/proc/net/dev", "utf8"), interfaces);
			}
			if (this.os === "darwin") return parseNetstatIbn(await run("netstat", ["-ibn"]));
			if (this.os === "win32") return parseNetstatE(await run("netstat", ["-e"]));
		} catch {
			// Not available; network stats are omitted.
		}
		return undefined;
	}

	private async take(): Promise<HostStats> {
		let previous = this.previous;
		if (!previous || Date.now() - previous.at > STALE_MS) {
			this.linuxInterfaces = undefined;
			previous = { at: Date.now(), cpu: readCpuTimes(), net: await this.readNet() };
			await new Promise((resolve) => setTimeout(resolve, BASELINE_MS));
		}
		const [net, memory, disk] = await Promise.all([this.readNet(), readMemory(this.os), readDisk()]);
		const list = cpus();
		const cpu = readCpuTimes(list);
		const at = Date.now();
		this.previous = { at, cpu, net };
		const seconds = Math.max(0.001, (at - previous.at) / 1000);
		// Counters can wrap (32-bit on some systems) or reset; never report negative rates.
		const rate = (after: number, before: number) => Math.max(0, Math.round((after - before) / seconds));
		const model = list[0]?.model.trim();
		const load = loadavg();
		return {
			sampledAt: new Date(at).toISOString(),
			platform: this.os,
			uptime: Math.round(uptime()),
			cpu: {
				usage: cpuUsage(previous.cpu, cpu),
				cores: list.length,
				...(model ? { model } : {}),
				...(this.os === "win32" ? {} : { loadAverage: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] }),
			},
			memory,
			...(disk ? { disk } : {}),
			...(net
				? {
						network: {
							rxRate: previous.net ? rate(net.rx, previous.net.rx) : 0,
							txRate: previous.net ? rate(net.tx, previous.net.tx) : 0,
							rxTotal: net.rx,
							txTotal: net.tx,
						},
					}
				: {}),
			hostRss: process.memoryUsage.rss(),
		};
	}
}
