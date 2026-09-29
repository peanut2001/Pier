import { CLOSE_DEVICE_REVOKED, PierClient } from "@pier/client";
import { formatPairingUri, keyFingerprint } from "@pier/crypto";
import type { EventFrame, PairingRequest, PeerInfo, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOSE_PEER_UNKNOWN, CLOSE_PEER_UNREACHABLE } from "../src/peers/peers.ts";
import { fauxAssistantMessage, Recorder, startTestHost, type TestHost, TOKEN } from "./helpers.ts";

const REMOTE = { enabled: true, port: 0, bindHost: "127.0.0.1", mdns: false } as const;

async function expectCode(promise: Promise<unknown>, code: string): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		expect((error as { code?: string }).code).toBe(code);
		return error;
	}
	throw new Error(`Expected ${code}`);
}

describe("computer-to-computer (peers)", () => {
	/** The computer the user sits at. */
	let a: TestHost;
	/** The computer it connects to. */
	let b: TestHost;
	let aDesktop: PierClient;
	let bDesktop: PierClient;
	let aEvents: Recorder;
	let bEvents: Recorder;
	let bWorkspace: WorkspaceInfo;
	const extra: PierClient[] = [];

	beforeEach(async () => {
		[a, b] = await Promise.all([
			startTestHost({ peers: { openTimeoutMs: 1000 } }),
			startTestHost({ remote: { ...REMOTE, approvalTimeoutMs: 2000 } }),
		]);
		aDesktop = await a.connect();
		bDesktop = await b.connect();
		aEvents = new Recorder();
		bEvents = new Recorder();
		aDesktop.onEvent(aEvents.handler);
		bDesktop.onEvent(bEvents.handler);
		bWorkspace = (await bDesktop.request("workspace.add", { path: b.workspaceDir })).workspace;
	});
	afterEach(async () => {
		for (const client of extra.splice(0)) client.close();
		await Promise.all([a.close(), b.close()]);
	});

	/** Pair A with B, answering B's confirmation dialog with `accept`. */
	async function pair(accept: boolean | undefined = true): Promise<PeerInfo> {
		const { uri } = await bDesktop.request("pairing.start");
		const from = bEvents.mark();
		void bEvents
			.waitForType("pairing.request", from)
			.then((frame) => {
				const request = frame.event.request as PairingRequest;
				if (accept !== undefined) return bDesktop.request("pairing.respond", { requestId: request.id, accept });
			})
			.catch(() => undefined);
		return (await aDesktop.request("peer.pair", { uri }, { timeoutMs: 10_000 })).peer;
	}

	/** A desktop client of A that talks to B through A's local gateway. */
	function viaA(peerId: string, token = TOKEN): PierClient {
		const client = new PierClient({
			url: `${a.url}/peer/${encodeURIComponent(peerId)}`,
			token,
			client: { name: "pier-desktop", version: "0.0.0" },
			reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
		});
		extra.push(client);
		return client;
	}

	it("pairs with the host key, then drives the other computer through the local gateway", async () => {
		const from = aEvents.mark();
		let request: PairingRequest | undefined;
		const pairing = bEvents.waitForType("pairing.request").then((f) => {
			request = f.event.request as PairingRequest;
		});
		const peer = await pair();
		await pairing;
		// B sees A's host key (the same fingerprint A shows as its own) and its name and OS.
		expect(request).toMatchObject({
			device: { name: a.host.info().hostName, platform: process.platform },
			fingerprint: keyFingerprint(a.host.remote.identity.publicKey),
		});
		expect(peer).toMatchObject({
			id: b.host.info().hostId,
			name: b.host.info().hostName,
			fingerprint: keyFingerprint(b.host.remote.identity.publicKey),
			connected: false,
		});
		await aEvents.waitForType("peer.changed", from);
		expect((await aDesktop.request("peer.list")).peers).toEqual([peer]);
		const devices = (await bDesktop.request("device.list")).devices;
		expect(devices).toEqual([expect.objectContaining({ id: peer.deviceId, platform: process.platform })]);

		const remote = viaA(peer.id);
		const hello = await remote.connect();
		expect(hello.host.hostId).toBe(b.host.info().hostId);
		expect(hello.device).toEqual({ id: peer.deviceId, name: a.host.info().hostName });
		expect((await bDesktop.request("device.list")).devices[0]?.connected).toBe(true);
		const listed = (await aDesktop.request("peer.list")).peers[0];
		expect(listed).toMatchObject({ connected: true, version: b.host.info().version, platform: process.platform });
		expect(listed?.lastConnectedAt).toBeDefined();

		// It is a remote device there: workspaces yes, B's settings and pairing no.
		expect((await remote.request("workspace.list")).workspaces.map((w) => w.id)).toEqual([bWorkspace.id]);
		await expectCode(remote.request("workspace.add", { path: b.workspaceDir }), "FORBIDDEN");
		await expectCode(remote.request("pairing.start"), "FORBIDDEN");
		await expectCode(remote.request("peer.list"), "FORBIDDEN");

		b.faux.setResponses([fauxAssistantMessage("answered by computer B")]);
		const { session } = await remote.request("session.create", { workspaceId: bWorkspace.id });
		const rec = new Recorder();
		await remote.subscribe(session.id, rec.handler, { workspaceId: bWorkspace.id });
		await rec.waitForType("session.snapshot");
		await remote.request("session.prompt", { sessionId: session.id, text: "hello from A" });
		await rec.waitForType("agent_settled");
		expect(rec.text()).toBe("answered by computer B");
		// The session lives on B, not on A.
		expect((await bDesktop.request("session.list", { workspaceId: bWorkspace.id })).sessions[0]?.id).toBe(session.id);

		// B's local-only events do not reach A's window.
		const seen: string[] = [];
		remote.onEvent((frame: EventFrame) => seen.push(frame.event.type));
		await bDesktop.request("pairing.start");
		await bDesktop.request("pairing.cancel");
		await remote.request("host.info");
		expect(seen.filter((t) => t.startsWith("pairing.") || t.startsWith("remote."))).toEqual([]);

		remote.close();
		await aEvents.waitFor((f) => f.event.type === "peer.changed", aEvents.mark());
		expect((await aDesktop.request("peer.list")).peers[0]?.connected).toBe(false);
	});

	it("checks the local token before connecting and never forwards it", async () => {
		const peer = await pair();
		await expectCode(viaA(peer.id, "wrong-token-0123456789").connect(), "UNAUTHENTICATED");
		expect((await bDesktop.request("device.list")).devices[0]?.connected).toBe(false);
		await expectCode(viaA("no-such-computer").connect(), "NOT_FOUND");

		// B would reject a local token anyway, but it must not even see it.
		const remote = viaA(peer.id);
		await remote.connect();
		expect(remote.helloResult?.device).toBeDefined();
	});

	it("refuses its own link and reports declined pairing", async () => {
		const own = formatPairingUri({
			hostId: a.host.info().hostId,
			hostName: a.host.info().hostName,
			hostPublicKey: a.host.remote.identity.publicKey,
			addresses: ["127.0.0.1:9"],
			code: "unused",
		});
		const error = await expectCode(aDesktop.request("peer.pair", { uri: own }), "CONFLICT");
		expect((error as { data?: { reason?: string } }).data?.reason).toBe("SELF");
		await expectCode(aDesktop.request("peer.pair", { uri: "pier://nope" }), "BAD_REQUEST");

		const declined = await expectCode(pair(false), "CONFLICT");
		expect((declined as { data?: { reason?: string } }).data?.reason).toBe("PAIRING_REJECTED");
		expect((await aDesktop.request("peer.list")).peers).toEqual([]);
	});

	it("stops reconnecting once the other computer removed this one", async () => {
		const peer = await pair();
		const remote = viaA(peer.id);
		await remote.connect();
		const closed = new Promise<void>((resolve) => remote.onState((s) => s === "closed" && resolve()));
		await bDesktop.request("device.revoke", { deviceId: peer.deviceId });
		await closed;
		expect(remote.terminalClose?.code).toBe(CLOSE_DEVICE_REVOKED);

		// New attempts are refused during the handshake, and A still lists the peer.
		const again = viaA(peer.id);
		await expect(again.connect()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
		expect(again.terminalClose?.code).toBe(CLOSE_DEVICE_REVOKED);
		expect((await aDesktop.request("peer.list")).peers).toHaveLength(1);

		// Pairing again fixes it; the device id on B changes because B forgot the key.
		const repaired = await pair();
		await viaA(repaired.id).connect();
	});

	it("reports an unreachable computer and reconnects when it is back", async () => {
		const peer = await pair();
		const remote = viaA(peer.id);
		await remote.connect();
		const reconnecting = new Promise<void>((resolve) => remote.onState((s) => s === "reconnecting" && resolve()));
		await bDesktop.request("remote.configure", { enabled: false });
		await reconnecting;

		const offline = viaA(peer.id);
		const error = await offline.connect().then(
			() => undefined,
			(e: Error) => e,
		);
		expect(error?.message).toMatch(/Could not connect|closed/);

		const port = Number(peer.addresses[0]?.split(":").pop());
		const reopened = new Promise<void>((resolve) => remote.onState((s) => s === "open" && resolve()));
		await bDesktop.request("remote.configure", { enabled: true, port });
		await reopened;
		expect((await remote.request("workspace.list")).workspaces).toHaveLength(1);
		expect(CLOSE_PEER_UNREACHABLE).toBe(4502);
	});

	it("closes proxied connections when the computer is removed here", async () => {
		const peer = await pair();
		const remote = viaA(peer.id);
		await remote.connect();
		const reconnecting = new Promise<void>((resolve) => remote.onState((s) => s !== "open" && resolve()));
		expect(await aDesktop.request("peer.remove", { peerId: peer.id })).toEqual({ removed: true });
		await reconnecting;
		expect((await aDesktop.request("peer.list")).peers).toEqual([]);
		const gone = viaA(peer.id);
		await expectCode(gone.connect(), "NOT_FOUND");
		expect(CLOSE_PEER_UNKNOWN).toBe(4404);
		remote.close();
	});
});
