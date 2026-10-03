import { describe, expect, it } from "vitest";
import { addressPort, parsePeerAddresses } from "../src/addresses.ts";

describe("parsePeerAddresses", () => {
	it("keeps host:port addresses in order without duplicates", () => {
		expect(parsePeerAddresses("10.1.55.1:7433\n10.1.0.222:7433\n10.1.55.1:7433", 7433)).toEqual({
			addresses: ["10.1.55.1:7433", "10.1.0.222:7433"],
			invalid: [],
		});
	});

	it("adds the default port, brackets IPv6 and accepts other separators", () => {
		expect(
			parsePeerAddresses("192.168.1.20, studio.tail1234.ts.net；fd00::1 [fd00::2]、ws://10.0.0.5:9000/", 7500),
		).toEqual({
			addresses: [
				"192.168.1.20:7500",
				"studio.tail1234.ts.net:7500",
				"[fd00::1]:7500",
				"[fd00::2]:7500",
				"10.0.0.5:9000",
			],
			invalid: [],
		});
	});

	it("reports what it cannot use", () => {
		expect(parsePeerAddresses("10.0.0.1:70000\nhost:0\nbad/addr", 7433)).toEqual({
			addresses: [],
			invalid: ["10.0.0.1:70000", "host:0", "bad/addr"],
		});
		expect(parsePeerAddresses("  \n ", 7433)).toEqual({ addresses: [], invalid: [] });
	});

	it("reads the port of an address", () => {
		expect(addressPort("10.1.55.1:7433")).toBe(7433);
		expect(addressPort("[fd00::1]:8000")).toBe(8000);
		expect(addressPort("10.1.55.1")).toBeUndefined();
		expect(addressPort(undefined)).toBeUndefined();
	});
});
