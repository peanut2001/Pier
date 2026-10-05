/**
 * Content fingerprints for transcript messages (1.27). A client that already has the start of
 * a transcript sends how many messages it has and the fingerprint of the last one with
 * `session.subscribe`; when the host's transcript starts the same way, the snapshot carries
 * only the messages after that prefix (`SessionSnapshot.messagesFrom`).
 *
 * The fingerprint is a 64-bit hash of the message's canonical JSON (object keys sorted), so it
 * does not depend on key order and survives a JSON round trip. It detects changes, not
 * tampering: both ends already trust each other.
 */

/** JSON with object keys sorted; `undefined` members are left out like `JSON.stringify` does. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const text = JSON.stringify(value);
		return text === undefined ? "null" : text;
	}
	const toJSON = (value as { toJSON?: () => unknown }).toJSON;
	if (typeof toJSON === "function") return canonicalJson(toJSON.call(value));
	if (Array.isArray(value)) {
		return `[${value.map((item) => (item === undefined || typeof item === "function" ? "null" : canonicalJson(item))).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of Object.keys(record).sort()) {
		const item = record[key];
		if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
		parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
	}
	return `{${parts.join(",")}}`;
}

/** Two independent 32-bit FNV-1a style hashes of `text`, as 16 hex digits. */
function hash64(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x5bd1e995);
		b ^= b >>> 15;
	}
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
	return hex(a) + hex(b);
}

/** Fingerprint of one transcript message. */
export function messageFingerprint(message: unknown): string {
	return hash64(canonicalJson(message));
}

/** What a client already has of a transcript: its first `count` messages, the last with `fingerprint`. */
export interface KnownMessages {
	count: number;
	fingerprint: string;
}

/** The prefix a client holds, or `undefined` when it has no messages. */
export function knownMessages(messages: readonly unknown[]): KnownMessages | undefined {
	const last = messages.length ? messages[messages.length - 1] : undefined;
	return last === undefined ? undefined : { count: messages.length, fingerprint: messageFingerprint(last) };
}

/** How many of `messages` the client already has (`known` matches), or 0 when it must get them all. */
export function knownPrefix(messages: readonly unknown[], known: KnownMessages | undefined): number {
	if (!known || known.count < 1 || known.count > messages.length) return 0;
	return messageFingerprint(messages[known.count - 1]) === known.fingerprint ? known.count : 0;
}
