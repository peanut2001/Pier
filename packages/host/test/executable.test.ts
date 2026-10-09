import { execFile } from "node:child_process";
import { expect, it, vi } from "vitest";
import { probeVersion } from "../src/runtimes/executable.ts";

vi.mock("node:child_process", { spy: true });

it.each(["ENOEXEC", "UNKNOWN"])("returns no version when starting an executable throws %s", async (code) => {
	vi.mocked(execFile).mockImplementationOnce(() => {
		throw Object.assign(new Error(`spawn ${code}`), { code });
	});
	await expect(probeVersion("invalid-native-cli")).resolves.toBeUndefined();
});
