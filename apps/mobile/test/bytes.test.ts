import { describe, expect, it } from "vitest";
import { base64ByteLength, base64ToBytes, bytesToBase64 } from "../src/bytes.ts";

describe("base64", () => {
	it("round-trips every remainder length like Buffer", () => {
		for (let length = 0; length < 40; length++) {
			const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
			const encoded = bytesToBase64(bytes);
			expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
			expect(base64ByteLength(encoded)).toBe(length);
			expect([...base64ToBytes(encoded)]).toEqual([...bytes]);
		}
	});

	it("encodes large buffers", () => {
		const bytes = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 7) & 0xff);
		expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
	});

	it("decodes without padding and skips whitespace", () => {
		expect(new TextDecoder().decode(base64ToBytes("aGVs\nbG8"))).toBe("hello");
	});
});
