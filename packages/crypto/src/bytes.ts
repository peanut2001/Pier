import { base32, base64, base64urlnopad, hex } from "@scure/base";

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Constant-time comparison for equal-length inputs. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
	return diff === 0;
}

const nativeEncoder = typeof TextEncoder === "function" ? new TextEncoder() : undefined;
const nativeDecoder = (() => {
	try {
		return typeof TextDecoder === "function" ? new TextDecoder("utf-8") : undefined;
	} catch {
		return undefined;
	}
})();

/** UTF-8 encode; uses the native TextEncoder when the engine has one. */
export function utf8Encode(text: string): Uint8Array {
	return nativeEncoder ? nativeEncoder.encode(text) : utf8EncodeJs(text);
}

/** UTF-8 decode (invalid sequences become U+FFFD); uses the native TextDecoder when available. */
export function utf8Decode(bytes: Uint8Array): string {
	return nativeDecoder ? nativeDecoder.decode(bytes) : utf8DecodeJs(bytes);
}

/** Pure JS UTF-8 encoder for engines without TextEncoder (exported for tests). */
export function utf8EncodeJs(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i++;
			} else code = 0xfffd;
		} else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
		if (code < 0x80) out.push(code);
		else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
		else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
		else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
	}
	return Uint8Array.from(out);
}

/** Pure JS UTF-8 decoder for engines without TextDecoder (exported for tests). */
export function utf8DecodeJs(bytes: Uint8Array): string {
	let out = "";
	const chunk: number[] = [];
	const flush = () => {
		out += String.fromCharCode(...chunk);
		chunk.length = 0;
	};
	let i = 0;
	while (i < bytes.length) {
		const b0 = bytes[i] as number;
		let code = 0xfffd;
		let size = 1;
		if (b0 < 0x80) code = b0;
		else if (b0 >= 0xc2 && b0 < 0xe0 && i + 1 < bytes.length) {
			const b1 = bytes[i + 1] as number;
			if ((b1 & 0xc0) === 0x80) {
				code = ((b0 & 31) << 6) | (b1 & 63);
				size = 2;
			}
		} else if (b0 >= 0xe0 && b0 < 0xf0 && i + 2 < bytes.length) {
			const b1 = bytes[i + 1] as number;
			const b2 = bytes[i + 2] as number;
			if ((b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80) {
				const c = ((b0 & 15) << 12) | ((b1 & 63) << 6) | (b2 & 63);
				if (c >= 0x800 && (c < 0xd800 || c > 0xdfff)) {
					code = c;
					size = 3;
				}
			}
		} else if (b0 >= 0xf0 && b0 < 0xf5 && i + 3 < bytes.length) {
			const b1 = bytes[i + 1] as number;
			const b2 = bytes[i + 2] as number;
			const b3 = bytes[i + 3] as number;
			if ((b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
				const c = ((b0 & 7) << 18) | ((b1 & 63) << 12) | ((b2 & 63) << 6) | (b3 & 63);
				if (c >= 0x10000 && c <= 0x10ffff) {
					code = c;
					size = 4;
				}
			}
		}
		if (code >= 0x10000) {
			code -= 0x10000;
			chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
		} else chunk.push(code);
		if (chunk.length >= 8192) flush();
		i += size;
	}
	flush();
	return out;
}

type NativeBase64 = {
	toBase64?: (this: Uint8Array) => string;
};
type NativeBase64Ctor = { fromBase64?: (text: string) => Uint8Array };
type BufferLike = {
	from(data: Uint8Array): { toString(encoding: "base64"): string };
	from(data: string, encoding: "base64"): Uint8Array;
};

const nativeToBase64 = (Uint8Array.prototype as NativeBase64).toBase64;
const nativeFromBase64 = (Uint8Array as unknown as NativeBase64Ctor).fromBase64;
const NodeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard padded base64. Uses the fastest implementation the engine offers. */
export function toBase64(bytes: Uint8Array): string {
	if (nativeToBase64) return nativeToBase64.call(bytes);
	if (NodeBuffer) return NodeBuffer.from(bytes).toString("base64");
	return base64.encode(bytes);
}

/**
 * Standard base64 decode; throws on malformed input. (Ciphertexts are authenticated,
 * so the fast Node path only checks the alphabet and length.)
 */
export function fromBase64(text: string): Uint8Array {
	if (nativeFromBase64) return nativeFromBase64(text);
	if (NodeBuffer) {
		if (text.length % 4 !== 0 || !BASE64_CHARS.test(text)) throw new Error("Invalid base64");
		const buffer = NodeBuffer.from(text, "base64");
		return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
	}
	return base64.decode(text);
}
export const toBase64Url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);
export const fromBase64Url = (text: string): Uint8Array => base64urlnopad.decode(text);
export const toHex = (bytes: Uint8Array): string => hex.encode(bytes);
export const fromHex = (text: string): Uint8Array => hex.decode(text);

/** Base32 without padding (RFC 4648 alphabet). */
export function toBase32(bytes: Uint8Array): string {
	return base32.encode(bytes).replace(/=+$/, "");
}
