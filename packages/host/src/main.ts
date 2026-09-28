#!/usr/bin/env node
/**
 * Pier Host sidecar entry point.
 *
 * Prints exactly one JSON line to stdout once listening:
 *   {"type":"pier.ready","url":"ws://127.0.0.1:<port>","port":<port>,"token":"<local token>","pid":<pid>,...}
 * The desktop shell reads it to learn the port and token. Logs go to stderr.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "@pier/protocol";
import { writePrivateFile } from "./config.ts";
import { DEFAULT_ALLOWED_ORIGINS, startLocalGateway } from "./gateway/local-gateway.ts";
import { PIER_HOST_VERSION, PierHost } from "./host.ts";
import { defaultPierDir, runtimeFilePath } from "./paths.ts";

const HELP = `pier-host ${PIER_HOST_VERSION}

Usage: pier-host [options]

Options:
  --port <n>          Local WebSocket port on 127.0.0.1 (default: random free port)
  --pier-dir <dir>    Pier state directory (default: $PIER_DIR or ~/.pier)
  --agent-dir <dir>   pi agent directory (default: pi's own resolution, ~/.pi/agent)
  --origin <origin>   Additional allowed WebSocket Origin (repeatable)
  --no-runtime-file   Do not write <pier-dir>/run/host.json for local tools
  --no-remote         Keep remote access (LAN) off for this run, whatever the saved setting
  --remote-port <n>   Use this port for remote access in this run (default: saved, 7433)
  --remote-address <host:port>
                      Address to put into pairing codes instead of the detected LAN
                      addresses (repeatable; e.g. a Tailscale name or a forwarded port)
  --no-mdns           Do not advertise _pier._tcp over mDNS
  --watch-stdin       Exit when stdin closes (sidecar mode: exit with the parent)
  -h, --help          Show this help

Environment:
  PIER_LOCAL_TOKEN    Local token to require (default: random per start)
`;

function log(message: string): void {
	process.stderr.write(`[pier-host] ${message}\n`);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: "string" },
			"pier-dir": { type: "string" },
			"agent-dir": { type: "string" },
			origin: { type: "string", multiple: true },
			"no-runtime-file": { type: "boolean" },
			"no-remote": { type: "boolean" },
			"remote-port": { type: "string" },
			"remote-address": { type: "string", multiple: true },
			"no-mdns": { type: "boolean" },
			"watch-stdin": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});
	if (values.help) {
		process.stdout.write(HELP);
		return;
	}

	const port = values.port === undefined ? 0 : Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port ${values.port}`);
	const pierDir = values["pier-dir"] ?? defaultPierDir();
	const token = process.env.PIER_LOCAL_TOKEN || randomBytes(32).toString("base64url");
	const remotePort = values["remote-port"] === undefined ? undefined : Number(values["remote-port"]);
	if (remotePort !== undefined && (!Number.isInteger(remotePort) || remotePort < 0 || remotePort > 65535)) {
		throw new Error(`Invalid --remote-port ${values["remote-port"]}`);
	}

	const host = await PierHost.create({
		pierDir,
		localToken: token,
		env: values["agent-dir"] ? { agentDir: values["agent-dir"] } : {},
		log,
		remote: {
			...(values["no-remote"] ? { enabled: false } : {}),
			...(remotePort !== undefined ? { port: remotePort } : {}),
			...(values["remote-address"]?.length ? { advertiseAddresses: values["remote-address"] } : {}),
			...(values["no-mdns"] ? { mdns: false } : {}),
		},
	});
	const gateway = await startLocalGateway(host, {
		port,
		...(values.origin?.length ? { allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, ...values.origin] } : {}),
	});

	const ready = {
		type: "pier.ready",
		url: gateway.url,
		port: gateway.port,
		token,
		pid: process.pid,
		version: PIER_HOST_VERSION,
		protocolVersion: PROTOCOL_VERSION,
	};
	const runtimeFile = runtimeFilePath(pierDir);
	if (!values["no-runtime-file"]) {
		writePrivateFile(runtimeFile, `${JSON.stringify({ ...ready, startedAt: new Date().toISOString() }, null, 2)}\n`);
	}
	process.stdout.write(`${JSON.stringify(ready)}\n`);
	log(`listening on ${gateway.url} (pi agent dir: ${host.env.agentDir})`);

	let stopping = false;
	const stop = async (reason: string) => {
		if (stopping) return;
		stopping = true;
		log(`shutting down (${reason})`);
		// Deliberately not unref'd: this must fire even if a shutdown step hangs.
		setTimeout(() => {
			log("shutdown timed out; forcing exit");
			process.exit(1);
		}, 10_000);
		try {
			await host.shutdown();
			log("sessions disposed");
			await gateway.close();
			log("gateway closed");
		} catch (error) {
			log(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (!values["no-runtime-file"]) removeRuntimeFileIfOurs(runtimeFile);
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
	if (values["watch-stdin"]) {
		process.stdin.on("end", () => void stop("stdin closed"));
		process.stdin.on("close", () => void stop("stdin closed"));
		process.stdin.resume();
	}
}

function removeRuntimeFileIfOurs(path: string): void {
	try {
		const content = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
		if (content.pid === process.pid) rmSync(path, { force: true });
	} catch {
		// Missing or unreadable.
	}
}

main().catch((error: unknown) => {
	log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exit(1);
});
