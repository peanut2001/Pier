import { deleteItem, getItem, setItem } from "./storage.ts";

/** A computer this device has paired with. */
export interface PairedHost {
	hostId: string;
	hostName: string;
	/** Host static X25519 public key (base64url), pinned at pairing. */
	hostPublicKey: string;
	/** Candidate `host:port` addresses, best first. */
	addresses: string[];
	/** Pier Relays the computer is registered with, tried when no address answers. */
	relays?: string[];
	/** This device's id on that host. */
	deviceId: string;
	pairedAt: string;
	lastConnectedAt?: string;
}

const INDEX_KEY = "pier.hosts";
const hostKey = (hostId: string) => `pier.host.${hostId.replace(/[^\w.-]/g, "_")}`;

/**
 * Paired hosts, one secure-store entry each (entries are small; some platforms limit
 * values to ~2 KB) plus an index of host ids.
 */
export async function loadHosts(): Promise<PairedHost[]> {
	let ids: string[] = [];
	try {
		ids = JSON.parse((await getItem(INDEX_KEY)) ?? "[]") as string[];
	} catch {
		ids = [];
	}
	const hosts: PairedHost[] = [];
	for (const id of ids) {
		try {
			const raw = await getItem(hostKey(id));
			if (raw) hosts.push(JSON.parse(raw) as PairedHost);
		} catch {
			// Skip unreadable entries.
		}
	}
	return hosts;
}

export async function saveHost(host: PairedHost, all: PairedHost[]): Promise<void> {
	await setItem(hostKey(host.hostId), JSON.stringify(host));
	await setItem(INDEX_KEY, JSON.stringify(all.map((h) => h.hostId)));
}

export async function removeHost(hostId: string, remaining: PairedHost[]): Promise<void> {
	await deleteItem(hostKey(hostId));
	await setItem(INDEX_KEY, JSON.stringify(remaining.map((h) => h.hostId)));
}
