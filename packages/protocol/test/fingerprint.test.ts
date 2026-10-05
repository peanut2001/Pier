import { describe, expect, it } from "vitest";
import { canonicalJson, knownMessages, knownPrefix, messageFingerprint } from "../src/index.ts";

describe("message fingerprints", () => {
	const message = { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 2 }, at: 5 };

	it("does not depend on key order or a JSON round trip", () => {
		const reordered = {
			at: 5,
			usage: { output: 2, input: 1 },
			content: [{ text: "hi", type: "text" }],
			role: "assistant",
		};
		const withUndefined = { ...message, extra: undefined };
		expect(canonicalJson(reordered)).toBe(canonicalJson(message));
		expect(messageFingerprint(reordered)).toBe(messageFingerprint(message));
		expect(messageFingerprint(withUndefined)).toBe(messageFingerprint(message));
		expect(messageFingerprint(JSON.parse(JSON.stringify(message)))).toBe(messageFingerprint(message));
		expect(messageFingerprint({ ...message, at: 6 })).not.toBe(messageFingerprint(message));
		expect(messageFingerprint(message)).toMatch(/^[0-9a-f]{16}$/);
	});

	it("matches the prefix a client holds", () => {
		const messages = [{ n: 1 }, { n: 2 }, { n: 3 }];
		expect(knownMessages([])).toBeUndefined();
		const known = knownMessages(messages.slice(0, 2));
		expect(known?.count).toBe(2);
		expect(knownPrefix(messages, known)).toBe(2);
		expect(knownPrefix(messages, undefined)).toBe(0);
		expect(knownPrefix(messages.slice(0, 1), known)).toBe(0);
		expect(knownPrefix([{ n: 1 }, { n: 9 }, { n: 3 }], known)).toBe(0);
	});
});
