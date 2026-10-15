import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PairingRequest, PROTOCOL_VERSION } from "@pier/protocol";
import { assert, describe, expect, it } from "vitest";
import { Recorder, startTestHost } from "./helpers.ts";

describe("processes over the paired channel", () => {
	it("lists and terminates a real child with a sanitized remote audit record", async () => {
		const localHost = await startTestHost();
		const remoteHost = await startTestHost({ remote: { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } });
		const child = spawn(
			process.execPath,
			["-e", 'setInterval(() => {}, 1000); console.log("ready");', "PRIVATE_PROCESS_ARGUMENT"],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			await once(child.stdout, "data");
			const local = await localHost.connect();
			const remote = await remoteHost.connect();
			const events = new Recorder();
			remote.onEvent(events.handler);
			const { uri } = await remote.request("pairing.start");
			void events
				.waitForType("pairing.request")
				.then((frame) =>
					remote.request("pairing.respond", { requestId: (frame.event.request as PairingRequest).id, accept: true }),
				);
			const { peer } = await local.request("peer.pair", { uri });
			const paired = await localHost.host.peers.openClient(peer.id);
			try {
				const result = await paired.request("host.processes");
				expect(paired.host?.protocolVersion).toBe(PROTOCOL_VERSION);
				const entry = result.processes.find((p) => p.pid === child.pid);
				assert(entry?.startToken);
				expect(entry).toMatchObject({ pid: child.pid, canTerminate: true });
				expect(JSON.stringify(result)).not.toContain("PRIVATE_PROCESS_ARGUMENT");
				await expect(paired.request("host.killProcess", { pid: entry.pid, startToken: "stale" })).rejects.toMatchObject(
					{ code: "CONFLICT" },
				);
				const exited = once(child, "exit");
				expect(
					await paired.request("host.killProcess", { pid: entry.pid, startToken: entry.startToken, force: true }),
				).toEqual({ signalled: true });
				await exited;
				const audit = readFileSync(join(remoteHost.root, "pier", "audit.log"), "utf8");
				expect(audit).toMatch(new RegExp(`"event":"host.killProcess".*"pid":${child.pid}.*"force":true`));
				expect(audit).not.toContain("PRIVATE_PROCESS_ARGUMENT");
				expect(audit).not.toContain("startToken");
			} finally {
				paired.close();
			}
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
			await Promise.all([localHost.close(), remoteHost.close()]);
		}
	});
});
