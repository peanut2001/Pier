import { describe, expect, it } from "vitest";
import {
	absolutePath,
	baseName,
	childPath,
	formatCost,
	formatPercent,
	formatRate,
	formatSize,
	formatTokens,
	formatUptime,
	parentPath,
	shortPath,
} from "../src/format.ts";

describe("shortPath", () => {
	it("shortens home directories to ~", () => {
		expect(shortPath("/home/me/projects/pier")).toBe("~/projects/pier");
		expect(shortPath("/home/me")).toBe("~");
		expect(shortPath("/Users/me/code")).toBe("~/code");
		expect(shortPath("/root/work")).toBe("~/work");
		expect(shortPath("C:\\Users\\me\\code")).toBe("~\\code");
	});

	it("leaves other paths alone", () => {
		expect(shortPath("/homework/x")).toBe("/homework/x");
		expect(shortPath("/rootfs/a")).toBe("/rootfs/a");
		expect(shortPath("/opt/pier")).toBe("/opt/pier");
		expect(shortPath("D:\\code")).toBe("D:\\code");
	});
});

describe("file paths", () => {
	it("splits and joins workspace-relative paths", () => {
		expect(baseName("src/app/main.ts")).toBe("main.ts");
		expect(baseName("", "ws")).toBe("ws");
		expect(parentPath("src/app/main.ts")).toBe("src/app");
		expect(parentPath("main.ts")).toBe("");
		expect(childPath("", "a.txt")).toBe("a.txt");
		expect(childPath("src/", "a.txt")).toBe("src/a.txt");
	});

	it("builds absolute paths with the root's separator", () => {
		expect(absolutePath("/home/me/ws", "src/a.ts")).toBe("/home/me/ws/src/a.ts");
		expect(absolutePath("/home/me/ws", "")).toBe("/home/me/ws");
		expect(absolutePath("C:\\code\\ws", "src/a.ts")).toBe("C:\\code\\ws\\src\\a.ts");
	});
});

describe("sizes and usage", () => {
	it("formats sizes, rates, tokens and uptime", () => {
		expect(formatSize(512)).toBe("512 B");
		expect(formatSize(1536)).toBe("1.5 KB");
		expect(formatRate(2 * 1024 * 1024)).toBe("2.0 MB/s");
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(12_345)).toBe("12k");
		expect(formatPercent(0.05)).toBe("5.0%");
		expect(formatPercent(0.5)).toBe("50%");
		expect(formatUptime(3 * 86400 + 4 * 3600)).toBe("3 天 4 小时");
		expect(formatCost(0.5)).toBe("$0.50");
	});
});
