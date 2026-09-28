/**
 * Minimal Noise Protocol Framework implementation (revision 34) for the two handshake
 * patterns Pier uses, with the `25519_ChaChaPoly_SHA256` suite:
 *
 * - `XX`: first contact (pairing). Both sides learn each other's static key.
 * - `IK`: later connections. The device already knows the host's static key.
 *
 * Pure JS on top of `@noble/*`, so it runs unchanged in Node, Bun, browsers and
 * React Native (Hermes). Verified against the cacophony test vectors.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { concatBytes, equalBytes, utf8Encode } from "./bytes.ts";

export const DHLEN = 32;
export const HASHLEN = 32;
export const TAGLEN = 16;
/** Noise limits a single handshake / transport message to 65535 bytes. */
export const MAX_NOISE_MESSAGE = 65535;

export interface KeyPair {
	publicKey: Uint8Array;
	secretKey: Uint8Array;
}

export class NoiseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoiseError";
	}
}

export function generateKeyPair(): KeyPair {
	const secretKey = x25519.utils.randomSecretKey();
	return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
	if (secretKey.length !== DHLEN) throw new NoiseError("X25519 secret key must be 32 bytes");
	return { secretKey: secretKey.slice(), publicKey: x25519.getPublicKey(secretKey) };
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
	try {
		return x25519.getSharedSecret(secretKey, publicKey);
	} catch {
		throw new NoiseError("Invalid Diffie-Hellman public key");
	}
}

function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
	const tempKey = hmac(sha256, chainingKey, ikm);
	const out1 = hmac(sha256, tempKey, Uint8Array.of(1));
	const out2 = hmac(sha256, tempKey, concatBytes(out1, Uint8Array.of(2)));
	return [out1, out2];
}

/** ChaChaPoly nonce: 32 zero bits followed by the little-endian 64-bit counter. */
export function chachaNonce(n: number): Uint8Array {
	const nonce = new Uint8Array(12);
	const view = new DataView(nonce.buffer);
	view.setUint32(4, n >>> 0, true);
	view.setUint32(8, Math.floor(n / 0x1_0000_0000), true);
	return nonce;
}

/**
 * Noise CipherState. Nonces are a JS number, so a single direction supports 2^53
 * messages, which a Pier connection cannot reach; exceeding it throws.
 */
export class CipherState {
	private k: Uint8Array | undefined;
	private n = 0;

	constructor(key?: Uint8Array) {
		if (key) this.initializeKey(key);
	}

	initializeKey(key: Uint8Array): void {
		this.k = key.slice(0, 32);
		this.n = 0;
	}

	hasKey(): boolean {
		return this.k !== undefined;
	}

	get nonce(): number {
		return this.n;
	}

	private nextNonce(): Uint8Array {
		if (this.n >= Number.MAX_SAFE_INTEGER) throw new NoiseError("Nonce exhausted; reconnect");
		return chachaNonce(this.n++);
	}

	encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
		if (!this.k) return plaintext;
		return chacha20poly1305(this.k, this.nextNonce(), ad).encrypt(plaintext);
	}

	decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
		if (!this.k) return ciphertext;
		if (ciphertext.length < TAGLEN) throw new NoiseError("Ciphertext too short");
		const nonce = chachaNonce(this.n);
		let plaintext: Uint8Array;
		try {
			plaintext = chacha20poly1305(this.k, nonce, ad).decrypt(ciphertext);
		} catch {
			throw new NoiseError("Decryption failed");
		}
		// Only advance after successful authentication (Noise §5.1).
		this.n += 1;
		return plaintext;
	}
}

class SymmetricState {
	readonly cipher = new CipherState();
	private ck: Uint8Array;
	h: Uint8Array;

	constructor(protocolName: string) {
		const name = utf8Encode(protocolName);
		if (name.length <= HASHLEN) {
			this.h = new Uint8Array(HASHLEN);
			this.h.set(name);
		} else {
			this.h = sha256(name);
		}
		this.ck = this.h.slice();
	}

	mixKey(ikm: Uint8Array): void {
		const [ck, tempK] = hkdf2(this.ck, ikm);
		this.ck = ck;
		this.cipher.initializeKey(tempK);
	}

	mixHash(data: Uint8Array): void {
		this.h = sha256(concatBytes(this.h, data));
	}

	encryptAndHash(plaintext: Uint8Array): Uint8Array {
		const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
		this.mixHash(ciphertext);
		return ciphertext;
	}

	decryptAndHash(ciphertext: Uint8Array): Uint8Array {
		const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
		this.mixHash(ciphertext);
		return plaintext;
	}

	split(): [CipherState, CipherState] {
		const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
		return [new CipherState(k1), new CipherState(k2)];
	}
}

type Token = "e" | "s" | "ee" | "es" | "se" | "ss";

export type HandshakePatternName = "XX" | "IK";

interface HandshakePattern {
	/** Responder static key known to the initiator before the handshake (`<- s`). */
	responderPreStatic: boolean;
	messages: Token[][];
}

const PATTERNS: Record<HandshakePatternName, HandshakePattern> = {
	XX: {
		responderPreStatic: false,
		messages: [["e"], ["e", "ee", "s", "es"], ["s", "se"]],
	},
	IK: {
		responderPreStatic: true,
		messages: [
			["e", "es", "s", "ss"],
			["e", "ee", "se"],
		],
	},
};

export function protocolName(pattern: HandshakePatternName): string {
	return `Noise_${pattern}_25519_ChaChaPoly_SHA256`;
}

export interface HandshakeOptions {
	pattern: HandshakePatternName;
	initiator: boolean;
	prologue?: Uint8Array;
	/** Local static key pair. */
	staticKeyPair: KeyPair;
	/** Remote static public key known in advance (IK initiator). */
	remoteStaticKey?: Uint8Array;
	/** Fixed ephemeral key pair, for test vectors only. */
	ephemeralKeyPair?: KeyPair;
}

export interface HandshakeResult {
	/** Encrypts messages we send. */
	send: CipherState;
	/** Decrypts messages we receive. */
	receive: CipherState;
	/** Final handshake hash; identical on both sides (usable for channel binding). */
	handshakeHash: Uint8Array;
	remoteStaticKey: Uint8Array;
}

/**
 * Noise HandshakeState. Call `writeMessage` / `readMessage` in pattern order;
 * `isComplete()` turns true after the last message, then call `finish()`.
 */
export class Handshake {
	private readonly symmetric: SymmetricState;
	private readonly pattern: HandshakePattern;
	private readonly initiator: boolean;
	private readonly s: KeyPair;
	private e: KeyPair | undefined;
	private rs: Uint8Array | undefined;
	private re: Uint8Array | undefined;
	private readonly fixedEphemeral: KeyPair | undefined;
	private index = 0;

	constructor(options: HandshakeOptions) {
		this.pattern = PATTERNS[options.pattern];
		this.initiator = options.initiator;
		this.s = options.staticKeyPair;
		this.rs = options.remoteStaticKey?.slice();
		this.fixedEphemeral = options.ephemeralKeyPair;
		this.symmetric = new SymmetricState(protocolName(options.pattern));
		this.symmetric.mixHash(options.prologue ?? new Uint8Array(0));
		if (this.pattern.responderPreStatic) {
			if (this.initiator) {
				if (!this.rs || this.rs.length !== DHLEN)
					throw new NoiseError(`${options.pattern} requires the remote static key`);
				this.symmetric.mixHash(this.rs);
			} else {
				this.symmetric.mixHash(this.s.publicKey);
			}
		}
	}

	/** Whether it is our turn to write the next handshake message. */
	get isMyTurn(): boolean {
		return this.index % 2 === (this.initiator ? 0 : 1);
	}

	isComplete(): boolean {
		return this.index >= this.pattern.messages.length;
	}

	/** Remote static key once received (or known in advance). */
	get remoteStaticKey(): Uint8Array | undefined {
		return this.rs;
	}

	get handshakeHash(): Uint8Array {
		return this.symmetric.h;
	}

	private tokens(): Token[] {
		const tokens = this.pattern.messages[this.index];
		if (!tokens) throw new NoiseError("Handshake already complete");
		return tokens;
	}

	private mixDh(token: "ee" | "es" | "se" | "ss"): void {
		const e = this.e;
		const re = this.re;
		const rs = this.rs;
		const need = <T>(value: T | undefined): T => {
			if (value === undefined) throw new NoiseError(`Missing key for ${token}`);
			return value;
		};
		switch (token) {
			case "ee":
				this.symmetric.mixKey(dh(need(e).secretKey, need(re)));
				return;
			case "ss":
				this.symmetric.mixKey(dh(this.s.secretKey, need(rs)));
				return;
			case "es":
				this.symmetric.mixKey(this.initiator ? dh(need(e).secretKey, need(rs)) : dh(this.s.secretKey, need(re)));
				return;
			case "se":
				this.symmetric.mixKey(this.initiator ? dh(this.s.secretKey, need(re)) : dh(need(e).secretKey, need(rs)));
				return;
		}
	}

	writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
		if (!this.isMyTurn) throw new NoiseError("Not our turn to write");
		const parts: Uint8Array[] = [];
		for (const token of this.tokens()) {
			if (token === "e") {
				this.e = this.fixedEphemeral ?? generateKeyPair();
				parts.push(this.e.publicKey);
				this.symmetric.mixHash(this.e.publicKey);
			} else if (token === "s") {
				parts.push(this.symmetric.encryptAndHash(this.s.publicKey));
			} else {
				this.mixDh(token);
			}
		}
		parts.push(this.symmetric.encryptAndHash(payload));
		this.index += 1;
		const message = concatBytes(...parts);
		if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError("Handshake message too large");
		return message;
	}

	readMessage(message: Uint8Array): Uint8Array {
		if (this.isMyTurn) throw new NoiseError("Not our turn to read");
		if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError("Handshake message too large");
		let offset = 0;
		const take = (length: number): Uint8Array => {
			if (offset + length > message.length) throw new NoiseError("Handshake message truncated");
			const slice = message.subarray(offset, offset + length);
			offset += length;
			return slice;
		};
		for (const token of this.tokens()) {
			if (token === "e") {
				this.re = take(DHLEN).slice();
				this.symmetric.mixHash(this.re);
			} else if (token === "s") {
				const length = this.symmetric.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN;
				this.rs = this.symmetric.decryptAndHash(take(length)).slice();
			} else {
				this.mixDh(token);
			}
		}
		const payload = this.symmetric.decryptAndHash(message.subarray(offset));
		this.index += 1;
		return payload;
	}

	finish(): HandshakeResult {
		if (!this.isComplete()) throw new NoiseError("Handshake not complete");
		if (!this.rs) throw new NoiseError("Remote static key unknown");
		const [c1, c2] = this.symmetric.split();
		return {
			send: this.initiator ? c1 : c2,
			receive: this.initiator ? c2 : c1,
			handshakeHash: this.symmetric.h.slice(),
			remoteStaticKey: this.rs.slice(),
		};
	}
}

export { equalBytes, randomBytes };
