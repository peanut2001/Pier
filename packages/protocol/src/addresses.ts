/** Port Pier listens on unless changed in its settings. */
export const DEFAULT_PIER_PORT = 7433;

/** A `host:port` address of a computer; IPv6 hosts are bracketed (`[fd00::1]:7433`). */
export const PEER_ADDRESS = /^(?:\[[0-9a-fA-F:.%\w-]+\]|[\w.-]+):(\d{1,5})$/;

/** The port of a `host:port` address, if it has a valid one. */
export function addressPort(address: string | undefined): number | undefined {
	const port = Number(PEER_ADDRESS.exec(address ?? "")?.[1]);
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Parse the addresses a user typed for a paired computer (desktop and mobile editors): one per
 * line, or separated by commas, semicolons or spaces. A bare host gets `defaultPort`, a bare
 * IPv6 address is bracketed, and a `ws://` / `http://` prefix or trailing slash is dropped.
 * Duplicates are removed while keeping the order.
 */
export function parsePeerAddresses(text: string, defaultPort: number): { addresses: string[]; invalid: string[] } {
	const addresses: string[] = [];
	const invalid: string[] = [];
	for (const raw of text.split(/[\s,，、;；]+/)) {
		let entry = raw
			.trim()
			.replace(/^(?:wss?|https?):\/\//i, "")
			.replace(/\/+$/, "");
		if (!entry) continue;
		if (!PEER_ADDRESS.test(entry)) {
			if (/^[\w.-]+$/.test(entry) || /^\[[0-9a-fA-F:.%\w-]+\]$/.test(entry)) entry = `${entry}:${defaultPort}`;
			else if (/^[0-9a-fA-F:.%\w-]+$/.test(entry) && entry.split(":").length > 2) entry = `[${entry}]:${defaultPort}`;
		}
		if (addressPort(entry) === undefined) {
			invalid.push(raw.trim());
			continue;
		}
		if (!addresses.includes(entry)) addresses.push(entry);
	}
	return { addresses, invalid };
}
