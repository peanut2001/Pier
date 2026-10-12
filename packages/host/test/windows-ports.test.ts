import { ChildProcess, execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { HostPortSampler } from "../src/ports/listening.ts";

vi.mock("node:child_process", { spy: true });

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each(["ETIMEDOUT", "ENOENT"])("still discovers Windows listeners when PowerShell fails with %s", async (code) => {
	vi.stubGlobal("process", { ...process, platform: "win32" });
	const query = vi.mocked(execFile);
	query.mockImplementationOnce(() => {
		throw Object.assign(new Error(`PowerShell ${code}`), { code });
	});
	query.mockImplementationOnce((...args) => {
		const callback = args.at(-1);
		if (typeof callback !== "function") throw new Error("Missing command callback");
		callback(null, "  TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    42\r\n", "");
		return new ChildProcess();
	});

	const sampler = new HostPortSampler();
	await expect(sampler.sample()).resolves.toEqual({
		ports: [{ protocol: "tcp", address: "127.0.0.1", port: 3000, pid: 42 }],
		truncated: false,
	});
	expect(query.mock.calls.map((call) => call[0])).toEqual(["powershell.exe", "netstat.exe"]);
});
