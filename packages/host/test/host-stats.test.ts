import { describe, expect, it } from "vitest";
import {
	cpuUsage,
	HostStatsSampler,
	parseMeminfo,
	parseNetstatE,
	parseNetstatIbn,
	parseProcNetDev,
	parseVmStat,
} from "../src/host-stats.ts";

describe("host stats parsers", () => {
	it("computes CPU usage between two readings", () => {
		expect(cpuUsage({ idle: 100, total: 200 }, { idle: 175, total: 300 })).toBeCloseTo(0.25);
		expect(cpuUsage({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBe(0);
	});

	it("reads available memory from /proc/meminfo", () => {
		const text = "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n";
		expect(parseMeminfo(text)).toEqual({ total: 16384000 * 1024, available: 8192000 * 1024 });
		expect(parseMeminfo("MemTotal: 1 kB\n")).toBeUndefined();
	});

	it("reads reclaimable memory from vm_stat", () => {
		const text = [
			"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
			"Pages free:                               10.",
			"Pages active:                            500.",
			"Pages inactive:                           20.",
			"Pages speculative:                         5.",
		].join("\n");
		expect(parseVmStat(text)).toBe(35 * 16384);
	});

	it("sums /proc/net/dev without loopback, optionally only given interfaces", () => {
		const text = [
			"Inter-|   Receive                                                |  Transmit",
			" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
			"    lo: 5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0",
			"  eth0: 1000      10    0    0    0     0          0         0     2000      10    0    0    0     0       0          0",
			"docker0: 300       3    0    0    0     0          0         0      400       4    0    0    0     0       0          0",
		].join("\n");
		expect(parseProcNetDev(text)).toEqual({ rx: 1300, tx: 2400 });
		expect(parseProcNetDev(text, new Set(["eth0"]))).toEqual({ rx: 1000, tx: 2000 });
	});

	it("sums the en* link rows of netstat -ibn", () => {
		const text = [
			"Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
			"lo0        16384 <Link#1>                        100     0      9000      100     0      9000     0",
			"en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff    50     0      4000       40     0      3000     0",
			"en0        1500  192.168.1     192.168.1.5         50     -      4000       40     -      3000     -",
			"utun0      1380  <Link#20>                         7     0       700        8     0       800     0",
		].join("\n");
		expect(parseNetstatIbn(text)).toEqual({ rx: 4000, tx: 3000 });
		expect(
			parseNetstatIbn(
				text
					.split("\n")
					.filter((l) => !l.startsWith("en0"))
					.join("\n"),
			),
		).toEqual({
			rx: 700,
			tx: 800,
		});
	});

	it("reads the byte counters of netstat -e in any language", () => {
		const english =
			"Interface Statistics\r\n\r\n                           Received            Sent\r\n\r\nBytes                    123456789      98765432\r\nUnicast packets             1000            900\r\n";
		expect(parseNetstatE(english)).toEqual({ rx: 123456789, tx: 98765432 });
		const chinese =
			"接口统计\r\n\r\n                           接收的            发送的\r\n\r\n字节                    42      24\r\n";
		expect(parseNetstatE(chinese)).toEqual({ rx: 42, tx: 24 });
	});
});

describe("HostStatsSampler", () => {
	it("samples this computer and shares back-to-back samples", async () => {
		const sampler = new HostStatsSampler();
		const first = sampler.sample();
		expect(sampler.sample()).toBe(first);
		const stats = await first;
		expect(stats.cpu.cores).toBeGreaterThan(0);
		expect(stats.cpu.usage).toBeGreaterThanOrEqual(0);
		expect(stats.cpu.usage).toBeLessThanOrEqual(1);
		expect(stats.memory.total).toBeGreaterThan(0);
		expect(stats.memory.used).toBeLessThanOrEqual(stats.memory.total);
		expect(stats.hostRss).toBeGreaterThan(0);
		if (stats.disk) expect(stats.disk.total).toBeGreaterThan(0);
		if (stats.network) expect(stats.network.rxRate).toBeGreaterThanOrEqual(0);
		expect(Number.isNaN(Date.parse(stats.sampledAt))).toBe(false);
	});
});
