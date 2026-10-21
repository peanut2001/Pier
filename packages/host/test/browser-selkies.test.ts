/** Opt in with PIER_TEST_SELKIES and PIER_TEST_BROWSER pointing to installed executables. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelkiesBrowser } from "../src/browser/selkies.ts";

const selkies = process.env.PIER_TEST_SELKIES;
const chromium = process.env.PIER_TEST_BROWSER;
describe.skipIf(process.platform !== "linux" || !selkies || !chromium)("real Selkies browser runtime", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("authenticates the stream, switches transport without losing the browser, and preserves its profile", async () => {
		vi.stubEnv("PIER_SELKIES_BIN", selkies);
		vi.stubEnv("PIER_BROWSER_BIN", chromium);
		const root = mkdtempSync(join(tmpdir(), "pier-selkies-test-"));
		const server = createServer((_req, res) => {
			res.setHeader("Content-Type", "text/html");
			res.end('<title>Pier remote browser</title><input id="name"><p>Remote browser smoke test</p>');
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		let browser: SelkiesBrowser | undefined;
		const start = () =>
			SelkiesBrowser.start({ profile: join(root, "profile"), url, transport: "webrtc", iceServers: [], onExit() {} });
		try {
			browser = await start();
			const viewer = `http://127.0.0.1:${browser.port}`;
			expect((await fetch(`${viewer}/api/sessions`)).status).toBe(401);
			expect(
				(await fetch(`${viewer}/api/sessions`, { headers: { Authorization: `Bearer ${browser.token}` } })).status,
			).toBe(200);
			expect(await (await fetch(`${viewer}/api/status`)).json()).toMatchObject({ current_mode: "webrtc" });
			await expect
				.poll(async () => (await browser?.action({ action: "snapshot" }))?.text)
				.toContain("Remote browser smoke test");
			await browser.action({ action: "fill", selector: "#name", text: "same browser" });
			await browser.action({ action: "evaluate", expression: "localStorage.setItem('login','retained')" });
			await browser.setTransport("websockets");
			expect(await (await fetch(`${viewer}/api/status`)).json()).toMatchObject({ current_mode: "websockets" });
			expect(
				(await browser.action({ action: "evaluate", expression: "document.querySelector('#name').value" })).text,
			).toBe('"same browser"');
			const png = (await browser.action({ action: "screenshot" })).image;
			expect(
				Buffer.from(png?.data ?? "", "base64")
					.subarray(0, 8)
					.toString("hex"),
			).toBe("89504e470d0a1a0a");
			await browser.close();
			await expect(fetch(`${viewer}/api/status`)).rejects.toThrow();
			browser = await start();
			await expect
				.poll(
					async () =>
						(await browser?.action({ action: "evaluate", expression: "localStorage.getItem('login')" }))?.text,
				)
				.toBe('"retained"');
		} finally {
			await browser?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);
});
