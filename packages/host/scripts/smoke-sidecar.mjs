#!/usr/bin/env node
/**
 * Smoke-test a compiled pier-host sidecar: start it with throwaway pi/Pier directories,
 * read the `pier.ready` line, speak the protocol over WebSocket (hello, workspace, session
 * via the pi SDK inside the binary), then close stdin and expect a clean exit.
 *
 * Usage: node scripts/smoke-sidecar.mjs <path-to-pier-host> [expected-version]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const exe = resolve(process.argv[2] ?? "");
const expectedVersion = process.argv[3];
if (!process.argv[2] || !existsSync(exe)) {
	console.error("Usage: smoke-sidecar.mjs <path-to-pier-host> [expected-version]");
	process.exit(2);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "pier-smoke-")));
const pierDir = join(root, "pier");
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const fail = (message) => {
	throw new Error(message);
};
const withTimeout = (promise, ms, what) =>
	Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

const child = spawn(exe, ["--watch-stdin", "--pier-dir", pierDir], {
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
	},
});
let stderr = "";
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
const exited = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));

async function main() {
	const lines = createInterface({ input: child.stdout });
	const readyLine = await withTimeout(
		new Promise((resolveLine, reject) => {
			lines.once("line", resolveLine);
			child.once("exit", () => reject(new Error("pier-host exited before it was ready")));
		}),
		60_000,
		"pier.ready",
	);
	const ready = JSON.parse(readyLine);
	if (ready.type !== "pier.ready") fail(`unexpected first stdout line: ${readyLine}`);
	if (expectedVersion && ready.version !== expectedVersion) fail(`version ${ready.version} != ${expectedVersion}`);
	if (!existsSync(join(pierDir, "run", "host.json"))) fail("runtime file was not written");

	const socket = new WebSocket(ready.url);
	const pending = new Map();
	const events = [];
	let nextId = 1;
	socket.onmessage = (message) => {
		const frame = JSON.parse(String(message.data));
		if (frame.type === "res") {
			const entry = pending.get(frame.id);
			pending.delete(frame.id);
			if (frame.ok) entry?.resolve(frame.result);
			else entry?.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
		} else {
			events.push(frame);
		}
	};
	await withTimeout(
		new Promise((resolveOpen, reject) => {
			socket.onopen = resolveOpen;
			socket.onerror = () => reject(new Error("WebSocket connection failed"));
		}),
		10_000,
		"WebSocket open",
	);
	const request = (method, params) =>
		withTimeout(
			new Promise((resolveReq, reject) => {
				const id = `r${nextId++}`;
				pending.set(id, { resolve: resolveReq, reject });
				socket.send(JSON.stringify({ type: "req", id, method, params }));
			}),
			30_000,
			method,
		);

	const hello = await request("host.hello", {
		protocolVersion: ready.protocolVersion,
		client: { name: "smoke", version: "0" },
		token: ready.token,
	});
	if (hello.host.piVersion === "0.0.0") fail("pi assets missing next to the binary (piVersion 0.0.0)");
	const { workspace: ws } = await request("workspace.add", { path: workspace });
	const { session } = await request("session.create", { workspaceId: ws.id, name: "smoke" });
	await request("session.subscribe", { sessionId: session.id });
	await withTimeout(
		(async () => {
			while (!events.some((e) => e.event.type === "session.snapshot")) await new Promise((r) => setTimeout(r, 20));
		})(),
		10_000,
		"session snapshot",
	);
	const { sessions } = await request("session.list", { workspaceId: ws.id });
	if (!sessions.some((s) => s.id === session.id)) fail("created session missing from session.list");
	socket.close();

	child.stdin.end();
	const { code, signal } = await withTimeout(exited, 15_000, "shutdown");
	if (code !== 0) fail(`pier-host exited with code ${code} signal ${signal}`);
	if (existsSync(join(pierDir, "run", "host.json"))) fail("runtime file was not removed on shutdown");
	console.log(
		`smoke OK: pier-host ${ready.version} (protocol ${ready.protocolVersion}, pi ${hello.host.piVersion}, ${hello.host.platform})`,
	);
}

main()
	.catch((error) => {
		console.error(`smoke FAILED: ${error.message}`);
		if (stderr) console.error(`--- pier-host stderr ---\n${stderr}`);
		child.kill("SIGKILL");
		process.exitCode = 1;
	})
	.finally(() => {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	});
