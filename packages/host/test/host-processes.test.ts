import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { MethodParamsSchemas } from "@pier/protocol";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
	HostProcessManager,
	parseLinuxProcess,
	parseMacProcesses,
	parseWindowsProcesses,
} from "../src/host-processes.ts";

const children: ChildProcess[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}),
	);
});

async function child(ignoreTerm = false): Promise<ChildProcess> {
	const script = `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""} setInterval(() => {}, 1000); console.log("ready");`;
	const proc = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
	children.push(proc);
	await once(proc.stdout, "data");
	return proc;
}

describe("host process management", () => {
	it("parses Linux command names without confusing parentheses with stat fields", () => {
		const fields = Array<string>(20).fill("0");
		fields[0] = "S";
		fields[1] = "12";
		fields[19] = "987654";
		expect(
			parseLinuxProcess(`42 (a name) (x)\n) ${fields.join(" ")}`, "Uid:\t1000 1000 1000 1000\nVmRSS:\t2048 kB\n"),
		).toEqual({
			pid: 42,
			parentPid: 12,
			name: "a name) (x)\n",
			startToken: "987654",
			user: "1000",
			memoryBytes: 2097152,
			canTerminate: true,
		});
		expect(parseLinuxProcess("42 (broken) S 1", "")).toBeUndefined();
	});

	it("parses macOS names with spaces and stable start identities", () => {
		expect(parseMacProcesses(" 42 1 alice 2048 Wed Oct  7 10:20:30 2026 /Applications/Google Chrome\ninvalid")).toEqual(
			[
				{
					pid: 42,
					parentPid: 1,
					user: "alice",
					memoryBytes: 2097152,
					startToken: "Wed Oct 7 10:20:30 2026",
					name: "Google Chrome",
					canTerminate: true,
				},
			],
		);
	});

	it("handles Windows singleton, empty and inaccessible processes", () => {
		expect(
			parseWindowsProcesses('\uFEFF{"pid":42,"name":"node","memoryBytes":1024,"startToken":"123456"}')[0],
		).toMatchObject({ pid: 42, startToken: "123456", canTerminate: true });
		expect(parseWindowsProcesses('[{"pid":53,"name":"restricted","startToken":null}]')[0]).toMatchObject({
			pid: 53,
			canTerminate: false,
		});
		expect(parseWindowsProcesses("[]")).toEqual([]);
	});

	it("rejects process groups, invalid PIDs and unsupported signals at the protocol boundary", () => {
		const schema = MethodParamsSchemas["host.killProcess"];
		for (const pid of [-42, -1, 0, 1, 1.5, 2_147_483_648])
			expect(schema.safeParse({ pid, startToken: "1" }).success).toBe(false);
		expect(schema.safeParse({ pid: 42, startToken: "" }).success).toBe(false);
		expect(schema.safeParse({ pid: 42, startToken: "1", force: "SIGINT" }).success).toBe(false);
	});

	it("discovers real processes, shares samples, and protects the Host and PID 1", async () => {
		const proc = await child();
		const manager = new HostProcessManager();
		const pending = manager.sample();
		expect(manager.sample()).toBe(pending);
		const sample = await pending;
		expect(sample.processes).toContainEqual(
			expect.objectContaining({ pid: proc.pid, startToken: expect.any(String), canTerminate: true }),
		);
		expect(sample.processes).toContainEqual(expect.objectContaining({ pid: process.pid, canTerminate: false }));
		await expect(manager.kill(process.pid, "irrelevant", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(manager.kill(1, "irrelevant", true)).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(manager.sample()).resolves.toBe(sample);
	});

	it("refuses a stale start identity and then sends SIGTERM to only the selected child", async () => {
		const proc = await child();
		const other = await child();
		const manager = new HostProcessManager();
		const entry = (await manager.sample()).processes.find((p) => p.pid === proc.pid);
		assert(entry?.startToken);
		await expect(manager.kill(entry.pid, `${entry.startToken}0`)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(proc.exitCode).toBeNull();
		const exited = once(proc, "exit");
		expect(await manager.kill(entry.pid, entry.startToken)).toEqual({ signalled: true });
		await exited;
		expect(other.exitCode).toBeNull();
		expect(other.signalCode).toBeNull();
		await expect(manager.kill(entry.pid, entry.startToken)).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it.skipIf(process.platform === "win32")("force kills a child that ignores SIGTERM", async () => {
		const proc = await child(true);
		const manager = new HostProcessManager();
		const entry = (await manager.sample()).processes.find((p) => p.pid === proc.pid);
		assert(entry?.startToken);
		await manager.kill(entry.pid, entry.startToken);
		expect(proc.signalCode).toBeNull();
		const exited = once(proc, "exit");
		await manager.kill(entry.pid, entry.startToken, true);
		const [, signal] = await exited;
		expect(signal).toBe("SIGKILL");
	});

	it("returns a permission error without exposing subprocess output", async () => {
		const proc = await child();
		const manager = new HostProcessManager();
		const entry = (await manager.sample()).processes.find((p) => p.pid === proc.pid);
		assert(entry?.startToken);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("private diagnostic"), { code: "EPERM" });
		});
		await expect(manager.kill(entry.pid, entry.startToken)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
