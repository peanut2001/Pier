import type { HostInfo } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	HOST_SETTINGS_PAGES,
	hostSpeaksMinor,
	pageFollowsHost,
	pageIsLocalOnly,
	remotePageBlocker,
} from "../src/lib/settings-target.ts";

const host = (protocolVersion: string): HostInfo => ({
	hostId: "h",
	hostName: "studio",
	version: "0.2.5",
	protocolVersion,
	platform: "linux",
	piVersion: "1.0.0",
	agentDir: "/home/me/.pi/agent",
});

describe("settings pages of the managed computer", () => {
	it("splits pages into per-computer, all-computer and this-computer ones", () => {
		for (const page of ["general", "account", "models", "extensions", "pi", "claude", "codex"]) {
			expect(pageFollowsHost(page)).toBe(true);
			expect(pageIsLocalOnly(page)).toBe(false);
		}
		for (const page of ["workspaces", "about"]) {
			expect(pageFollowsHost(page)).toBe(false);
			expect(pageIsLocalOnly(page)).toBe(false);
		}
		for (const page of ["remote", "logs"]) {
			expect(pageFollowsHost(page)).toBe(false);
			expect(pageIsLocalOnly(page)).toBe(true);
		}
		expect(pageFollowsHost("toString")).toBe(false);
	});

	it("compares protocol versions", () => {
		expect(hostSpeaksMinor(host("1.10"), 10)).toBe(true);
		expect(hostSpeaksMinor(host("1.9"), 10)).toBe(false);
		expect(hostSpeaksMinor(host("2.0"), 15)).toBe(true);
		expect(hostSpeaksMinor(host("bogus"), 0)).toBe(false);
		expect(hostSpeaksMinor(undefined, 0)).toBe(false);
	});

	it("blocks pages a paired computer's Pier is too old to be managed remotely for", () => {
		expect(HOST_SETTINGS_PAGES.pi).toBe(15);
		expect(remotePageBlocker("models", "studio", host("1.9"))).toMatch(/studio.*版本过旧.*1\.10/);
		expect(remotePageBlocker("models", "studio", host("1.10"))).toBeUndefined();
		expect(remotePageBlocker("pi", "studio", host("1.14"))).toMatch(/1\.15/);
		expect(remotePageBlocker("pi", "studio", host("1.18"))).toBeUndefined();
		expect(remotePageBlocker("claude", "studio", host("1.22"))).toMatch(/1\.23/);
		expect(remotePageBlocker("codex", "studio", host("1.23"))).toBeUndefined();
		// The general page only shows the computer's info; other pages do not follow it.
		expect(remotePageBlocker("general", "studio", host("1.0"))).toBeUndefined();
		expect(remotePageBlocker("remote", "studio", host("1.0"))).toBeUndefined();
		// Not connected yet: the connection state explains it instead.
		expect(remotePageBlocker("models", "studio", undefined)).toBeUndefined();
	});
});
