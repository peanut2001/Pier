import { existsSync, readFileSync } from "node:fs";
import { fromBase64Url, keyFingerprint } from "@pier/crypto";
import type { PeerInfo } from "@pier/protocol";
import { z } from "zod";
import { writePrivateFile } from "../config.ts";

const PeerRecordSchema = z.object({
	/** The peer's host id. */
	id: z.string().min(1),
	name: z.string().min(1),
	/** The peer's static X25519 public key (base64url), pinned at pairing. */
	publicKey: z.string().min(1),
	addresses: z.array(z.string().min(1)),
	/** Pier Relays the peer is registered with (from its pairing link). */
	relays: z.array(z.string().min(1)).optional(),
	/** This host's device id on the peer. */
	deviceId: z.string().min(1),
	pairedAt: z.string(),
	lastConnectedAt: z.string().optional(),
	platform: z.string().optional(),
	version: z.string().optional(),
});
export type PeerRecord = z.infer<typeof PeerRecordSchema>;

const PeersFileSchema = z.object({ version: z.literal(1), peers: z.array(PeerRecordSchema) });

/** Other computers this host paired with as a device, in `peers.json` (mode 0600). */
export class PeerStore {
	private peers: PeerRecord[];

	constructor(private readonly path: string) {
		if (existsSync(path)) {
			const parsed = PeersFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
			if (!parsed.success) throw new Error(`Invalid Pier peer list at ${path}: ${parsed.error.message}`);
			this.peers = parsed.data.peers;
		} else {
			this.peers = [];
		}
	}

	private save(): void {
		writePrivateFile(this.path, `${JSON.stringify({ version: 1, peers: this.peers }, null, 2)}\n`);
	}

	list(): PeerRecord[] {
		return this.peers.map((p) => ({
			...p,
			addresses: [...p.addresses],
			...(p.relays ? { relays: [...p.relays] } : {}),
		}));
	}

	get(id: string): PeerRecord | undefined {
		const peer = this.peers.find((p) => p.id === id);
		return peer
			? { ...peer, addresses: [...peer.addresses], ...(peer.relays ? { relays: [...peer.relays] } : {}) }
			: undefined;
	}

	/** Add a peer, or replace the record of a peer paired again. */
	put(record: PeerRecord): PeerRecord {
		this.peers = [...this.peers.filter((p) => p.id !== record.id), { ...record }];
		this.save();
		return { ...record };
	}

	/** Update fields of a known peer; saves only when something changed. */
	update(id: string, patch: Partial<Omit<PeerRecord, "id">>): PeerRecord | undefined {
		const peer = this.peers.find((p) => p.id === id);
		if (!peer) return undefined;
		const next = { ...peer, ...patch };
		if (JSON.stringify(next) !== JSON.stringify(peer)) {
			Object.assign(peer, patch);
			this.save();
		}
		return { ...peer, addresses: [...peer.addresses], ...(peer.relays ? { relays: [...peer.relays] } : {}) };
	}

	remove(id: string): boolean {
		const before = this.peers.length;
		this.peers = this.peers.filter((p) => p.id !== id);
		if (this.peers.length === before) return false;
		this.save();
		return true;
	}
}

export function toPeerInfo(record: PeerRecord, connected: boolean): PeerInfo {
	let fingerprint = "";
	try {
		fingerprint = keyFingerprint(fromBase64Url(record.publicKey));
	} catch {
		// Leave empty for a corrupt key; connecting fails anyway.
	}
	return {
		id: record.id,
		name: record.name,
		fingerprint,
		addresses: [...record.addresses],
		...(record.relays?.length ? { relays: [...record.relays] } : {}),
		deviceId: record.deviceId,
		pairedAt: record.pairedAt,
		...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {}),
		...(record.platform ? { platform: record.platform } : {}),
		...(record.version ? { version: record.version } : {}),
		connected,
	};
}
