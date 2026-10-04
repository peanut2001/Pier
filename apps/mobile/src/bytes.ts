/**
 * Base64 helpers for moving file bytes over the protocol (uploads, downloads, terminal output).
 * Pure JS so they behave the same on Hermes, the web and in tests.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
	const parts: string[] = [];
	let chunk = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
		chunk +=
			ALPHABET.charAt((n >> 18) & 63) +
			ALPHABET.charAt((n >> 12) & 63) +
			ALPHABET.charAt((n >> 6) & 63) +
			ALPHABET.charAt(n & 63);
		if (chunk.length >= 8192) {
			parts.push(chunk);
			chunk = "";
		}
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = (bytes[i] as number) << 16;
		chunk += `${ALPHABET.charAt((n >> 18) & 63)}${ALPHABET.charAt((n >> 12) & 63)}==`;
	} else if (rest === 2) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
		chunk += `${ALPHABET.charAt((n >> 18) & 63)}${ALPHABET.charAt((n >> 12) & 63)}${ALPHABET.charAt((n >> 6) & 63)}=`;
	}
	parts.push(chunk);
	return parts.join("");
}

/** Decode standard base64 (padding optional; whitespace and unknown characters are skipped). */
export function base64ToBytes(data: string): Uint8Array {
	const out = new Uint8Array(Math.floor((data.length * 3) / 4) + 3);
	let length = 0;
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code === 61) break; // "="
		const value = code < 128 ? (LOOKUP[code] as number) : -1;
		if (value < 0) continue;
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[length++] = (buffer >> bits) & 0xff;
		}
	}
	return out.slice(0, length);
}

/** Bytes encoded by a base64 string, without decoding it. */
export function base64ByteLength(data: string): number {
	let padding = 0;
	if (data.endsWith("==")) padding = 2;
	else if (data.endsWith("=")) padding = 1;
	return Math.floor((data.length * 3) / 4) - padding;
}
