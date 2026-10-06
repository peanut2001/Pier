import { fromBase64Url, toBase64Url } from "./bytes.ts";
import { DHLEN } from "./noise.ts";
import { normalizeRelayUrl } from "./relay.ts";

export const PAIRING_URI_VERSION = 1;

/** Everything a device needs to pair with a host, encoded in the desktop's QR code. */
export interface PairingInfo {
	hostId: string;
	hostName: string;
	/** Host static X25519 public key. */
	hostPublicKey: Uint8Array;
	/** Candidate `host:port` addresses, tried in order. IPv6 hosts are bracketed. */
	addresses: string[];
	/** Pier Relay URLs the host is registered with (`ws://` / `wss://`), tried after the addresses. */
	relays?: string[];
	/** One-time pairing code. */
	code: string;
}

/** `pier://pair?v=1&host=<id>&name=<name>&pk=<base64url>&addr=<a,b>&relay=<url,url>&code=<code>` */
export function formatPairingUri(info: PairingInfo): string {
	const params = [
		["v", String(PAIRING_URI_VERSION)],
		["host", info.hostId],
		["name", info.hostName],
		["pk", toBase64Url(info.hostPublicKey)],
		["addr", info.addresses.join(",")],
		...(info.relays?.length ? [["relay", info.relays.join(",")]] : []),
		["code", info.code],
	];
	return `pier://pair?${params.map(([k, v]) => `${k}=${encodeURIComponent(v ?? "")}`).join("&")}`;
}

export class PairingUriError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PairingUriError";
	}
}

const ADDRESS = /^(?:\[[0-9a-fA-F:.%\w-]+\]|[\w.-]+):\d{1,5}$/;

function parseQuery(query: string): Map<string, string> {
	const params = new Map<string, string>();
	for (const part of query.split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
		const value = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
		params.set(key, value);
	}
	return params;
}

/** Parse a scanned pairing URI. Throws {@link PairingUriError} with a user-presentable reason. */
export function parsePairingUri(text: string): PairingInfo {
	const trimmed = text.trim();
	const match = /^pier:\/\/pair\/?\?(.*)$/i.exec(trimmed);
	if (!match) throw new PairingUriError("Not a Pier pairing code");
	let params: Map<string, string>;
	try {
		params = parseQuery(match[1] ?? "");
	} catch {
		throw new PairingUriError("Malformed pairing code");
	}
	const version = Number(params.get("v"));
	if (version !== PAIRING_URI_VERSION) {
		throw new PairingUriError(`Unsupported pairing code version ${params.get("v") ?? "?"}; update the app`);
	}
	const hostId = params.get("host") ?? "";
	const code = params.get("code") ?? "";
	const pk = params.get("pk") ?? "";
	if (!hostId || !code || !pk) throw new PairingUriError("Pairing code is incomplete");
	let hostPublicKey: Uint8Array;
	try {
		hostPublicKey = fromBase64Url(pk);
	} catch {
		throw new PairingUriError("Invalid host key in pairing code");
	}
	if (hostPublicKey.length !== DHLEN) throw new PairingUriError("Invalid host key in pairing code");
	const addresses = (params.get("addr") ?? "")
		.split(",")
		.map((a) => a.trim())
		.filter((a) => ADDRESS.test(a));
	const relays: string[] = [];
	for (const item of (params.get("relay") ?? "").split(",")) {
		if (!item.trim()) continue;
		try {
			const url = normalizeRelayUrl(item);
			if (!relays.includes(url)) relays.push(url);
		} catch {
			// Skip relays this version cannot use.
		}
	}
	if (!addresses.length && !relays.length) throw new PairingUriError("Pairing code contains no reachable address");
	return {
		hostId,
		hostName: params.get("name") || "Pier",
		hostPublicKey,
		addresses,
		...(relays.length ? { relays: relays.slice(0, 4) } : {}),
		code,
	};
}

/** `ws://` URL for a `host:port` address. */
export function addressToUrl(address: string): string {
	return `ws://${address}`;
}
