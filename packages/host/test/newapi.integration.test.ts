import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PierClient } from "@pier/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startLocalGateway } from "../src/gateway/local-gateway.ts";
import { PierHost } from "../src/host.ts";
import { PiEnvironment } from "../src/pi/environment.ts";
import { encryptNewApiPassword, normalizeNewApiUrl } from "../src/pi/newapi.ts";
import {
	DASHBOARD_TOKEN,
	decryptV2,
	type FakeNewApi,
	type FakeOptions,
	PASSWORD,
	PAT,
	PUBLIC_PEM,
	startFakeNewApi,
	TOKEN_KEY_B,
	TOTP,
} from "./fake-newapi.ts";
import { TOKEN } from "./helpers.ts";

interface Harness {
	modelsPath: string;
	credentials: InMemoryCredentialStore;
	host: PierHost;
	client: PierClient;
	second: PierClient;
	close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pier-newapi-"));
	const agentDir = join(root, "agent");
	const modelsPath = join(agentDir, "models.json");
	mkdirSync(agentDir, { recursive: true });
	const credentials = new InMemoryCredentialStore();
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath, refreshOnCreate: false });
	const settings = SettingsManager.inMemory({});
	const env = await PiEnvironment.create({
		agentDir,
		modelsPath,
		modelRuntime,
		settingsManager: () => settings,
		sessionDir: join(root, "sessions"),
		isolated: true,
	});
	const host = await PierHost.create({
		pierDir: join(root, "pier"),
		env,
		localToken: TOKEN,
		remote: { enabled: false },
	});
	const gateway = await startLocalGateway(host);
	const connect = async () => {
		const client = new PierClient({ url: gateway.url, token: TOKEN, client: { name: "test", version: "0.0.0" } });
		await client.connect();
		return client;
	};
	const client = await connect();
	const second = await connect();
	return {
		modelsPath,
		credentials,
		host,
		client,
		second,
		async close() {
			client.close();
			second.close();
			await host.shutdown();
			await gateway.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("NewAPI helpers", () => {
	it("normalizes pasted site addresses", () => {
		expect(normalizeNewApiUrl("api.example.com")).toBe("https://api.example.com");
		expect(normalizeNewApiUrl("https://api.example.com/v1/")).toBe("https://api.example.com");
		expect(normalizeNewApiUrl("https://api.example.com/console/token?x=1")).toBe("https://api.example.com");
		expect(normalizeNewApiUrl("http://10.0.0.2:3000/newapi/login")).toBe("http://10.0.0.2:3000/newapi");
		expect(() => normalizeNewApiUrl("ftp://x")).toThrow();
	});

	it("encrypts passwords in the v2 format", () => {
		const long = "p".repeat(500);
		expect(decryptV2(encryptNewApiPassword(PASSWORD, PUBLIC_PEM, "k1"), "k1")).toBe(PASSWORD);
		expect(decryptV2(encryptNewApiPassword(long, PUBLIC_PEM, "k1"), "k1")).toBe(long);
	});
});

describe("NewAPI sign-in", () => {
	let t: Harness;
	const fakes: FakeNewApi[] = [];
	const offline = process.env.PI_OFFLINE;
	const fake = async (options: FakeOptions) => {
		const f = await startFakeNewApi(options);
		fakes.push(f);
		return f;
	};

	beforeAll(() => {
		process.env.PI_OFFLINE = "1";
	});
	afterAll(() => {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	});
	beforeEach(async () => {
		t = await startHarness();
	});
	afterEach(async () => {
		await t.close();
		for (const f of fakes.splice(0)) f.server.close();
	});

	it("logs in with an encrypted password and 2FA, then saves a token as a provider", async () => {
		const site = await fake({ variant: "modern", twoFA: true, encryption: true });

		await expect(
			t.client.request("newapi.login", { baseUrl: site.url, username: "alice", password: "wrong" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("用户名或密码错误") });

		const first = await t.client.request("newapi.login", {
			baseUrl: `${site.url}/v1`,
			username: "alice",
			password: PASSWORD,
		});
		expect(first).toMatchObject({ status: "verify", methods: ["2fa"] });
		await expect(
			t.client.request("newapi.verify", { sessionId: first.sessionId, code: "000000" }),
		).rejects.toMatchObject({ message: expect.stringContaining("验证码错误") });
		// Another connection cannot use this login.
		await expect(t.second.request("newapi.verify", { sessionId: first.sessionId, code: TOTP })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		const result = await t.client.request("newapi.verify", { sessionId: first.sessionId, code: TOTP });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.account).toEqual({
			site: { name: "测试站", url: site.url, version: "v1.3.19" },
			user: { id: 7, username: "alice", displayName: "Alice", group: "default" },
			tokens: [
				{ id: 2, name: "main", maskedKey: "sk-BBBB**********2222", status: 1, group: "vip", unlimitedQuota: true },
				{ id: 1, name: "old", maskedKey: "sk-AAAA**********1111", status: 3, unlimitedQuota: true },
			],
			groups: [
				{ name: "default", description: "默认分组", ratio: 1 },
				{ name: "vip", description: "VIP", ratio: 0.5 },
			],
		});
		const dashboard = site.requests.filter((r) => r.path === "/api/token/");
		expect(dashboard.every((r) => r.headers.authorization === `Bearer ${DASHBOARD_TOKEN}`)).toBe(true);

		const used = await t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 2 });
		expect(used.models).toEqual([{ id: "m-a" }, { id: "m-b" }, { id: "only-main" }]);
		expect(JSON.stringify([result, used])).not.toContain(TOKEN_KEY_B);

		// The key reference works for probing and saving, but only on this connection.
		const probe = await t.client.request("provider.probeModels", {
			api: "openai-completions",
			baseUrl: `${site.url}/v1`,
			apiKeyRef: used.keyRef,
		});
		expect(probe.models).toHaveLength(3);
		const provider = {
			id: "test-site",
			name: "测试站",
			api: "openai-completions" as const,
			baseUrl: `${site.url}/v1`,
			models: [{ id: "m-a" }, { id: "m-b" }],
		};
		await expect(
			t.second.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const saved = await t.client.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true });
		expect(saved.provider).toMatchObject({ id: "test-site", stored: true, availableCount: 2 });
		expect(saved.defaultModel).toEqual({ provider: "test-site", modelId: "m-a" });
		expect(await t.credentials.read("test-site")).toEqual({ type: "api_key", key: `sk-${TOKEN_KEY_B}` });
		expect(readFileSync(t.modelsPath, "utf8")).not.toContain(TOKEN_KEY_B);

		expect(await t.client.request("newapi.close", { sessionId: result.sessionId })).toEqual({ closed: true });
		expect(site.logouts).toBe(1);
		await expect(
			t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 2 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("creates a token in a group", async () => {
		const site = await fake({ variant: "modern" });
		const result = await t.client.request("newapi.login", { baseUrl: site.url, username: "alice", password: PASSWORD });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		const created = await t.client.request("newapi.createToken", {
			sessionId: result.sessionId,
			name: "Pier",
			group: "vip",
		});
		expect(created.tokenId).toBe(3);
		expect(created.tokens[0]).toMatchObject({ id: 3, name: "Pier", group: "vip", status: 1 });
		const used = await t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 3 });
		expect(used.models.map((m) => m.id)).toContain("only-Pier");
	});

	it("supports legacy cookie sessions with 2FA and keys in the token list", async () => {
		const site = await fake({ variant: "legacy", twoFA: true });
		const first = await t.client.request("newapi.login", { baseUrl: site.url, username: "alice", password: PASSWORD });
		expect(first.status).toBe("verify");
		const result = await t.client.request("newapi.verify", { sessionId: first.sessionId, code: TOTP });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.account.tokens.map((t) => t.maskedKey)).toEqual(["sk-BBBB**********2222", "sk-AAAA**********1111"]);
		expect(result.account.groups).toEqual([{ name: "default", description: "默认", ratio: 1 }]);
		expect(site.requests.find((r) => r.path === "/api/token/")?.headers["new-api-user"]).toBe("7");

		const used = await t.client.request("newapi.useToken", { sessionId: result.sessionId, tokenId: 2 });
		expect(used.models).toHaveLength(3);
		const saved = await t.client.request("provider.saveCustom", {
			provider: { id: "legacy", api: "openai-completions", baseUrl: `${site.url}/v1`, models: [{ id: "m-a" }] },
			apiKeyRef: used.keyRef,
			create: true,
		});
		expect(saved.provider.stored).toBe(true);
		expect(await t.credentials.read("legacy")).toEqual({ type: "api_key", key: `sk-${TOKEN_KEY_B}` });
	});

	it("signs in with a system access token", async () => {
		const modern = await fake({ variant: "modern" });
		const result = await t.client.request("newapi.login", { baseUrl: modern.url, accessToken: PAT });
		expect(result.status).toBe("ok");
		// The user's own access token is never revoked.
		await t.client.request("newapi.close", { sessionId: result.sessionId });
		expect(modern.logouts).toBe(0);

		const legacy = await fake({ variant: "legacy" });
		await expect(t.client.request("newapi.login", { baseUrl: legacy.url, accessToken: PAT })).rejects.toMatchObject({
			message: expect.stringContaining("用户 ID"),
		});
		const ok = await t.client.request("newapi.login", { baseUrl: legacy.url, accessToken: PAT, userId: 7 });
		expect(ok.status).toBe("ok");
		await expect(
			t.client.request("newapi.login", { baseUrl: legacy.url, accessToken: "nope", userId: 7 }),
		).rejects.toMatchObject({ message: expect.stringContaining("NewAPI") });
	});

	it("explains sites that cannot be used", async () => {
		const turnstile = await fake({ variant: "modern", turnstile: true });
		await expect(
			t.client.request("newapi.login", { baseUrl: turnstile.url, username: "alice", password: PASSWORD }),
		).rejects.toMatchObject({ message: expect.stringContaining("访问令牌") });
		const other = createServer((_req, res) => res.end("<html></html>"));
		await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
		try {
			const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
			await expect(
				t.client.request("newapi.login", { baseUrl: url, username: "alice", password: PASSWORD }),
			).rejects.toMatchObject({ message: expect.stringContaining("NewAPI") });
		} finally {
			other.close();
		}
	});
});
