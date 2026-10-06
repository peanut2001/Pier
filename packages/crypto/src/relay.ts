/**
 * Pier Relay wire format, shared by the relay server (`apps/relay`), the host and devices.
 *
 * A relay forwards channel frames between devices and hosts that cannot reach each other
 * directly (both behind NAT). It never sees plaintext: devices still run the Noise
 * handshake with the host through it, and it cannot impersonate either side.
 *
 * - Hosts keep a control WebSocket open at `/v1/host`. The relay sends a challenge; the
 *   host proves it holds the static key it registers (an X25519 key agreement with the
 *   relay's ephemeral key, bound to a fresh nonce), plus the access token in private mode.
 *   A host is addressed by its static public key, so nobody else can take its place.
 * - A device opens `/v1/connect?host=<host public key>`. The relay tells the host
 *   (`incoming`), the host opens `/v1/accept?id=<id>`, and the relay pipes text frames
 *   between the two sockets.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, equalBytes, fromBase64Url, toBase64Url, utf8Encode } from "./bytes.ts";
import type { IceServer } from "./channel.ts";
import { DHLEN, generateKeyPair, type KeyPair, randomBytes } from "./noise.ts";

export const RELAY_PROTOCOL_VERSION = 1;

/**
 * - `private`: only hosts that present one of the relay's access tokens may register.
 * - `open`: any host may register (within the relay's limits).
 */
export type RelayMode = "private" | "open";

export const RELAY_ERROR_CODES = [
	"BAD_REQUEST",
	/** Missing or wrong access token (private mode), or a failed key proof. */
	"UNAUTHORIZED",
	/** The host is not connected to the relay. */
	"HOST_OFFLINE",
	/** A relay limit was reached (hosts, connections, rate). */
	"LIMIT",
	"UNSUPPORTED_VERSION",
] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

/** WebSocket close codes used by the relay. */
export const RELAY_CLOSE = {
	badRequest: 4600,
	unauthorized: 4601,
	hostOffline: 4604,
	/** The host did not pick up a device connection in time. */
	acceptTimeout: 4608,
	/** Another connection registered the same host key. */
	replaced: 4609,
	limit: 4629,
} as const;

/** Relay → host on `/v1/host`. */
export type RelayServerMessage =
	| { t: "challenge"; v: number; mode: RelayMode; nonce: string; ek: string }
	| { t: "registered"; mode: RelayMode; iceServers: IceServer[] }
	| { t: "incoming"; id: string; addr?: string }
	| { t: "error"; code: RelayErrorCode; message: string };

/** Host → relay on `/v1/host`. */
export interface RelayRegisterMessage {
	t: "register";
	v: number;
	/** Host static public key (base64url). */
	pk: string;
	/** Proof of the static key, see {@link relayRegisterProof}. */
	proof: string;
	token?: string;
}

const PROOF_LABEL = utf8Encode(`pier-relay/${RELAY_PROTOCOL_VERSION} register`);

function proofMac(shared: Uint8Array, nonce: Uint8Array, hostKey: Uint8Array): Uint8Array {
	return hmac(sha256, shared, concatBytes(PROOF_LABEL, nonce, hostKey));
}

/** Host side: prove possession of `identity` for a relay challenge. */
export function relayRegisterProof(identity: KeyPair, challenge: { nonce: string; ek: string }): string {
	const ek = fromBase64Url(challenge.ek);
	if (ek.length !== DHLEN) throw new Error("Invalid relay challenge");
	const shared = x25519.getSharedSecret(identity.secretKey, ek);
	return toBase64Url(proofMac(shared, fromBase64Url(challenge.nonce), identity.publicKey));
}

/** Relay side: a fresh challenge and its verifier. */
export function createRelayChallenge(): {
	nonce: string;
	ek: string;
	verify(hostKey: string, proof: string): Uint8Array | undefined;
} {
	const ephemeral = generateKeyPair();
	const nonce = randomBytes(32);
	return {
		nonce: toBase64Url(nonce),
		ek: toBase64Url(ephemeral.publicKey),
		verify(hostKey, proof) {
			try {
				const pk = fromBase64Url(hostKey);
				if (pk.length !== DHLEN) return undefined;
				const shared = x25519.getSharedSecret(ephemeral.secretKey, pk);
				return equalBytes(proofMac(shared, nonce, pk), fromBase64Url(proof)) ? pk : undefined;
			} catch {
				return undefined;
			}
		},
	};
}

export class RelayUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RelayUrlError";
	}
}

/**
 * Canonical relay URL: `ws://` or `wss://`, no query, no trailing slash. Accepts `http(s)://`
 * (mapped to `ws(s)://`) and a bare host (`relay.example.com[:port][/path]`, which means `wss://`).
 */
export function normalizeRelayUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new RelayUrlError("Relay address is empty");
	// No `URL`: React Native's implementation lacks most accessors.
	const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)(?:[?#].*)?$/i.exec(trimmed);
	if (!match) throw new RelayUrlError(`Invalid relay address: ${trimmed}`);
	const protocol = (match[1] ?? "wss").toLowerCase();
	const scheme =
		protocol === "ws" || protocol === "http" ? "ws" : protocol === "wss" || protocol === "https" ? "wss" : "";
	if (!scheme) throw new RelayUrlError(`Unsupported relay address scheme ${protocol}:`);
	const authority = match[2] ?? "";
	if (authority.includes("@")) throw new RelayUrlError("Relay address must not contain credentials");
	const hostPort = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(authority);
	const port = hostPort?.[2] === undefined ? undefined : Number(hostPort[2]);
	if (!hostPort || (port !== undefined && (port < 1 || port > 65535))) {
		throw new RelayUrlError(`Invalid relay address: ${trimmed}`);
	}
	const host = (hostPort[1] ?? "").toLowerCase();
	const path = (match[3] ?? "").replace(/\/+$/, "");
	if (/\s/.test(path)) throw new RelayUrlError(`Invalid relay address: ${trimmed}`);
	return `${scheme}://${host}${port === undefined ? "" : `:${port}`}${path}`;
}

/** Device side: where to open a connection to `hostPublicKey` through the relay at `base`. */
export function relayConnectUrl(base: string, hostPublicKey: Uint8Array): string {
	return `${base}/v1/connect?host=${toBase64Url(hostPublicKey)}`;
}
