import {
	type ConnectionRoute,
	createSecureSocketFactory,
	type PairingOutcome,
	PierClient,
	pairWithHost,
} from "@pier/client";
import { generateKeyPair, type KeyPair, parsePairingUri } from "@pier/crypto";
import type { PairingRequest, RemoteAccessStatus } from "@pier/protocol";
import { type RelayServer, startRelayServer } from "@pier/relay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostPeerConnection } from "../src/remote/p2p.ts";
import { fauxAssistantMessage, Recorder, startTestHost, type TestHost } from "./helpers.ts";

const RELAY_TOKEN = "relay-token-0123456789abcdef";

async function waitUntil<T>(probe: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value as NonNullable<T>;
		if (Date.now() > until) throw new Error("Timed out waiting");
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("Pier Relay", () => {
	let relay: RelayServer;
	let t: TestHost;
	let desktop: PierClient;
	let desktopEvents: Recorder;
	const phoneKeys: KeyPair = generateKeyPair();
	const clients: PierClient[] = [];

	async function startHost(relayOptions: { url: string; token?: string }, p2p = true): Promise<void> {
		t = await startTestHost({
			// LAN listener off: devices can only come through the relay.
			remote: { enabled: false, mdns: false, relay: relayOptions, p2p, approvalTimeoutMs: 3000 },
		});
		desktop = await t.connect();
		desktopEvents = new Recorder();
		desktop.onEvent(desktopEvents.handler);
	}

	async function relayStatus(): Promise<RemoteAccessStatus["relay"]> {
		return (await desktop.request("remote.status")).relay;
	}

	async function pair(): Promise<PairingOutcome> {
		const started = await desktop.request("pairing.start");
		const from = desktopEvents.mark();
		void desktopEvents
			.waitForType("pairing.request", from, 10_000)
			.then((frame) =>
				desktop.request("pairing.respond", { requestId: (frame.event.request as PairingRequest).id, accept: true }),
			);
		return pairWithHost({
			info: parsePairingUri(started.uri),
			deviceKeyPair: phoneKeys,
			device: { name: "Relay Phone", platform: "android" },
		});
	}

	function phone(outcome: PairingOutcome, routes: ConnectionRoute[], p2p = false): PierClient {
		const client = new PierClient({
			url: "pier-secure://host",
			client: { name: "pier-mobile", version: "0.3.0", platform: "android" },
			coalesceMs: 50,
			reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
			createWebSocket: createSecureSocketFactory({
				addresses: outcome.addresses,
				relays: outcome.relays,
				hostPublicKey: outcome.hostPublicKey,
				deviceKeyPair: phoneKeys,
				onRoute: (route) => routes.push(route),
				...(p2p ? { p2p: { createPeerConnection: (config) => createHostPeerConnection(config.iceServers) } } : {}),
			}),
		});
		clients.push(client);
		return client;
	}

	afterEach(async () => {
		for (const client of clients.splice(0)) client.close();
		await t?.close();
		await relay?.close();
	});

	describe("private mode", () => {
		beforeEach(async () => {
			relay = await startRelayServer({ mode: "private", tokens: [RELAY_TOKEN], port: 0, stunPort: 0 });
		});

		it("registers with a token, pairs and connects through the relay only", async () => {
			await startHost({ url: relay.url, token: RELAY_TOKEN }, false);
			const status = await waitUntil(async () => {
				const s = await relayStatus();
				return s?.state === "online" ? s : undefined;
			});
			expect(status).toMatchObject({ enabled: true, url: relay.url, hasToken: true, mode: "private" });
			expect(JSON.stringify(await desktop.request("remote.status"))).not.toContain(RELAY_TOKEN);

			const started = await desktop.request("pairing.start");
			expect(started.addresses).toEqual([]);
			expect(started.relays).toEqual([relay.url]);
			const outcome = await pair();
			expect(outcome.route).toEqual({ kind: "relay", relay: relay.url });
			expect(outcome.relays).toEqual([relay.url]);

			const routes: ConnectionRoute[] = [];
			const client = phone(outcome, routes);
			const hello = await client.connect();
			expect(hello.device?.name).toBe("Relay Phone");
			expect(routes).toEqual([{ kind: "relay", relay: relay.url }]);
			const devices = (await desktop.request("device.list")).devices;
			expect(devices[0]).toMatchObject({ connected: true, route: "relay" });
			expect(relay.stats()).toMatchObject({ hosts: 1, streams: 1 });

			// A session runs end to end through the relay.
			const { workspace } = await desktop.request("workspace.add", { path: t.workspaceDir });
			t.faux.setResponses([fauxAssistantMessage("hello through the relay")]);
			const { session } = await client.request("session.create", { workspaceId: workspace.id });
			const events = new Recorder();
			await client.subscribe(session.id, events.handler);
			await client.request("session.prompt", { sessionId: session.id, text: "hi" });
			const done = await events.waitFor((f) => f.event.type === "agent_settled", 0, 10_000);
			expect(done).toBeDefined();
			expect(JSON.stringify(events.frames)).toContain("hello through the relay");
		});

		it("reports a wrong token without retrying quickly", async () => {
			await startHost({ url: relay.url, token: "wrong-token-0123456789" });
			const status = await waitUntil(async () => {
				const s = await relayStatus();
				return s?.state === "error" ? s : undefined;
			});
			expect(status?.error).toMatch(/token/i);
			expect(relay.stats().hosts).toBe(0);
		});

		it("fails fast when the computer is not on the relay", async () => {
			await startHost({ url: relay.url, token: RELAY_TOKEN }, false);
			await waitUntil(async () => (await relayStatus())?.state === "online");
			const outcome = await pair();
			await desktop.request("remote.configure", { relay: { enabled: false } });
			expect((await relayStatus())?.state).toBe("off");
			const routes: ConnectionRoute[] = [];
			const client = new PierClient({
				url: "pier-secure://host",
				client: { name: "pier-mobile", version: "0.3.0" },
				reconnect: { enabled: false },
				createWebSocket: createSecureSocketFactory({
					addresses: [],
					relays: outcome.relays,
					hostPublicKey: outcome.hostPublicKey,
					deviceKeyPair: phoneKeys,
					onRoute: (route) => routes.push(route),
				}),
			});
			clients.push(client);
			const started = Date.now();
			await expect(client.connect()).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(3000);
			expect(routes).toEqual([]);
		});

		it("moves a relayed connection onto a peer-to-peer path without the client noticing", async () => {
			await startHost({ url: relay.url, token: RELAY_TOKEN });
			await waitUntil(async () => (await relayStatus())?.state === "online");
			const outcome = await pair();
			const routes: ConnectionRoute[] = [];
			const client = phone(outcome, routes, true);
			const states: string[] = [];
			client.onState((s) => states.push(s));
			await client.connect();
			const { workspace } = await desktop.request("workspace.add", { path: t.workspaceDir });
			const { session } = await client.request("session.create", { workspaceId: workspace.id });
			const events = new Recorder();
			await client.subscribe(session.id, events.handler);

			await waitUntil(() => routes.some((r) => r.kind === "p2p"), 20_000);
			expect(routes.map((r) => r.kind)).toEqual(["relay", "p2p"]);
			// The relay socket is closed once both sides moved.
			await waitUntil(() => relay.stats().streams === 0);
			await waitUntil(async () => (await desktop.request("device.list")).devices[0]?.route === "p2p");

			// Same protocol connection: no reconnect, the subscription keeps streaming.
			const big = "x".repeat(100_000);
			t.faux.setResponses([fauxAssistantMessage(`over p2p ${big}`)]);
			await client.request("session.prompt", { sessionId: session.id, text: "hi" });
			await events.waitFor((f) => f.event.type === "agent_settled", 0, 15_000);
			expect(JSON.stringify(events.frames)).toContain("over p2p");
			expect(states.filter((s) => s === "reconnecting")).toEqual([]);

			// Revoking the device closes the p2p connection with the revoke code (sent in a control frame).
			const devices = (await desktop.request("device.list")).devices;
			await desktop.request("device.revoke", { deviceId: devices[0]?.id ?? "" });
			await waitUntil(() => client.state === "closed", 10_000);
			expect(client.terminalClose?.code).toBe(4403);
			// The close code came over the data channel (no reconnect through the relay first).
			expect(routes.map((r) => r.kind)).toEqual(["relay", "p2p"]);
			expect(states.filter((s) => s === "reconnecting")).toEqual([]);
		}, 40_000);
	});

	describe("open mode", () => {
		beforeEach(async () => {
			relay = await startRelayServer({ mode: "open", port: 0, stunPort: 0 });
		});

		it("lets any computer register without a token", async () => {
			await startHost({ url: relay.url });
			const status = await waitUntil(async () => {
				const s = await relayStatus();
				return s?.state === "online" ? s : undefined;
			});
			expect(status).toMatchObject({ mode: "open", hasToken: false });
			const outcome = await pair();
			const routes: ConnectionRoute[] = [];
			await phone(outcome, routes).connect();
			expect(routes[0]?.kind).toBe("relay");
		});

		it("notices quickly when a device closes its peer-to-peer connection", async () => {
			await startHost({ url: relay.url });
			await waitUntil(async () => (await relayStatus())?.state === "online");
			const outcome = await pair();
			const routes: ConnectionRoute[] = [];
			const client = phone(outcome, routes, true);
			await client.connect();
			await waitUntil(async () => (await desktop.request("device.list")).devices[0]?.route === "p2p", 20_000);
			client.close();
			const started = Date.now();
			await waitUntil(async () => (await desktop.request("device.list")).devices[0]?.connected === false, 8000);
			expect(Date.now() - started).toBeLessThan(8000);
		}, 40_000);
	});
});
