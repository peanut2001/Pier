import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PierClient } from "@pier/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startLocalGateway } from "../src/gateway/local-gateway.ts";
import { PierHost } from "../src/host.ts";
import { accountSite } from "../src/pi/account.ts";
import { PiEnvironment } from "../src/pi/environment.ts";
import {
	DASHBOARD_TOKEN,
	EMAIL_CODE,
	type FakeNewApi,
	type FakeOptions,
	PASSWORD,
	PAT,
	startFakeNewApi,
	TOKEN_KEY_B,
	TOTP,
} from "./fake-newapi.ts";
import { TOKEN } from "./helpers.ts";

interface Harness {
	root: string;
	accountFile: string;
	credentials: InMemoryCredentialStore;
	client: PierClient;
	second: PierClient;
	/** Stop the host and start a new one on the same directories. */
	restart(): Promise<void>;
	close(): Promise<void>;
}

async function startHarness(site: string): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pier-account-"));
	const agentDir = join(root, "agent");
	const modelsPath = join(agentDir, "models.json");
	mkdirSync(agentDir, { recursive: true });
	const credentials = new InMemoryCredentialStore();
	let stop: () => Promise<void> = async () => {};
	const harness: Harness = {
		root,
		accountFile: join(root, "pier", "account.json"),
		credentials,
		client: undefined as unknown as PierClient,
		second: undefined as unknown as PierClient,
		async restart() {
			await stop();
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
				accountSite: site,
			});
			const gateway = await startLocalGateway(host);
			const connect = async () => {
				const client = new PierClient({ url: gateway.url, token: TOKEN, client: { name: "test", version: "0.0.0" } });
				await client.connect();
				return client;
			};
			harness.client = await connect();
			harness.second = await connect();
			stop = async () => {
				harness.client.close();
				harness.second.close();
				await host.shutdown();
				await gateway.close();
			};
		},
		async close() {
			await stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
	await harness.restart();
	return harness;
}

describe("personal center site info", () => {
	it("reads sign-in options and the quota display from /api/status", () => {
		expect(
			accountSite("https://api.example.com", {
				system_name: "云链API",
				register_enabled: true,
				password_register_enabled: false,
				email_verification: true,
				github_oauth: true,
				linuxdo_oauth: true,
				oidc_enabled: true,
				oidc_display_name: "SSO",
				quota_per_unit: 500000,
				quota_display_type: "USD",
				usd_exchange_rate: 7,
			}),
		).toEqual({
			name: "云链API",
			url: "https://api.example.com",
			registerEnabled: false,
			emailVerification: true,
			passwordLogin: true,
			turnstile: false,
			oauth: ["GitHub", "LinuxDO", "SSO"],
			quota: { perUnit: 500000, type: "USD", usdRate: 7 },
		});
		expect(accountSite("https://x.test", { display_in_currency: false }).quota).toEqual({
			perUnit: 500000,
			type: "TOKENS",
		});
	});
});

describe("personal center", () => {
	let t: Harness;
	let site: FakeNewApi;
	const offline = process.env.PI_OFFLINE;
	const start = async (options: FakeOptions) => {
		site = await startFakeNewApi(options);
		t = await startHarness(site.url);
	};

	beforeAll(() => {
		process.env.PI_OFFLINE = "1";
	});
	afterAll(() => {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	});
	afterEach(async () => {
		await t.close();
		site.server.close();
	});

	it("signs in, shows the balance and keeps the login across restarts", async () => {
		await start({ variant: "modern", twoFA: true });
		const before = await t.client.request("account.status", {});
		expect(before.user).toBeUndefined();
		expect(before.site).toMatchObject({
			name: "测试站",
			url: site.url,
			registerEnabled: true,
			oauth: ["GitHub"],
			quota: { perUnit: 500000, type: "CNY", usdRate: 7 },
		});
		await expect(t.client.request("account.overview", {})).rejects.toMatchObject({
			message: expect.stringContaining("请先登录"),
		});

		await expect(t.client.request("account.login", { username: "alice", password: "nope" })).rejects.toMatchObject({
			message: expect.stringContaining("用户名或密码错误"),
		});
		expect(await t.client.request("account.login", { username: "alice", password: PASSWORD })).toEqual({
			status: "verify",
			methods: ["2fa"],
		});
		const result = await t.client.request("account.verify", { code: TOTP });
		if (result.status !== "ok") throw new Error("expected a signed-in account");
		expect(result.overview.user).toEqual({
			id: 7,
			username: "alice",
			displayName: "Alice",
			group: "default",
			email: "alice@example.com",
			quota: 3_500_000,
			usedQuota: 1_000_000,
			requestCount: 42,
		});
		expect(result.overview.tokens.map((token) => token.id)).toEqual([2, 1]);
		expect(result.overview.groups.map((group) => group.name)).toEqual(["default", "vip"]);

		// Only the refresh cookie is saved, owner-only; never the dashboard token or passwords.
		const saved = readFileSync(t.accountFile, "utf8");
		expect(saved).toContain(site.refreshToken);
		expect(saved).not.toContain(DASHBOARD_TOKEN);
		expect(saved).not.toContain(PASSWORD);
		if (process.platform !== "win32") expect(statSync(t.accountFile).mode & 0o777).toBe(0o600);
		// Every connection of the host shares the login.
		expect((await t.second.request("account.status", {})).user).toEqual({
			id: 7,
			username: "alice",
			displayName: "Alice",
			group: "default",
		});

		await t.restart();
		expect((await t.client.request("account.status", {})).user).toMatchObject({ username: "alice" });
		const overview = await t.client.request("account.overview", {});
		expect(overview.user.quota).toBe(3_500_000);
		// The restarted host got a new access token with the refresh cookie, which rotated.
		expect(site.refreshes).toBe(1);
		expect(site.requests.find((r) => r.path === "/api/user/auth/refresh")?.headers.origin).toBe(site.url);
		expect(readFileSync(t.accountFile, "utf8")).toContain(site.refreshToken);

		// An access token the site stops accepting early is renewed once.
		site.accessTokens.clear();
		expect((await t.client.request("account.overview", {})).user.username).toBe("alice");
		expect(site.refreshes).toBe(2);

		// A refused origin or server error is not a dead login.
		site.accessTokens.clear();
		const originalUrl = site.url;
		site.url = "https://other.example";
		await expect(t.client.request("account.overview", {})).rejects.toMatchObject({
			message: expect.stringContaining("AUTH_ORIGIN_FORBIDDEN"),
		});
		site.url = originalUrl;
		expect((await t.client.request("account.status", {})).user).toMatchObject({ username: "alice" });
		expect((await t.client.request("account.overview", {})).user.username).toBe("alice");

		// A login the site revoked is forgotten.
		site.accessTokens.clear();
		site.refreshToken = undefined;
		await expect(t.client.request("account.overview", {})).rejects.toMatchObject({
			message: expect.stringContaining("登录已过期"),
		});
		expect((await t.client.request("account.status", {})).user).toBeUndefined();
		expect(() => statSync(t.accountFile)).toThrow();
	});

	it("configures a group's key as a provider and creates keys in groups", async () => {
		await start({ variant: "modern" });
		await t.client.request("account.login", { username: "alice", password: PASSWORD });

		const created = await t.client.request("account.createToken", { name: "Pier", group: "vip" });
		expect(created.tokens[0]).toMatchObject({ id: created.tokenId, name: "Pier", group: "vip", status: 1 });

		const used = await t.client.request("account.useToken", { tokenId: 2 });
		expect(used.models).toEqual([{ id: "m-a" }, { id: "m-b" }, { id: "only-main" }]);
		expect(JSON.stringify(used)).not.toContain(TOKEN_KEY_B);
		const provider = {
			id: "yunlian-vip",
			name: "云链API · vip",
			api: "openai-completions" as const,
			baseUrl: `${site.url}/v1`,
			models: [{ id: "m-a" }],
		};
		// The key reference belongs to the connection that asked for it.
		await expect(
			t.second.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const saved = await t.client.request("provider.saveCustom", { provider, apiKeyRef: used.keyRef, create: true });
		expect(saved.provider).toMatchObject({ id: "yunlian-vip", stored: true });
		expect(await t.credentials.read("yunlian-vip")).toEqual({ type: "api_key", key: `sk-${TOKEN_KEY_B}` });

		expect(await t.client.request("account.logout", {})).toEqual({ loggedOut: true });
		expect(site.logouts).toBe(1);
		expect(() => statSync(t.accountFile)).toThrow();
		await expect(t.client.request("account.useToken", { tokenId: 2 })).rejects.toMatchObject({
			message: expect.stringContaining("请先登录"),
		});
		expect(await t.client.request("account.logout", {})).toEqual({ loggedOut: false });
	});

	it("registers with an email code and signs in", async () => {
		await start({ variant: "modern", emailVerification: true });
		await expect(
			t.client.request("account.register", { username: "bob", password: "bob-password" }),
		).rejects.toMatchObject({ message: expect.stringContaining("验证码") });
		expect(await t.client.request("account.sendCode", { email: "bob@example.com" })).toEqual({ sent: true });
		expect(site.codesSent).toEqual(["bob@example.com"]);
		await expect(
			t.client.request("account.register", {
				username: "bob",
				password: "bob-password",
				email: "bob@example.com",
				code: "000000",
			}),
		).rejects.toMatchObject({ message: expect.stringContaining("验证码错误") });
		const result = await t.client.request("account.register", {
			username: "bob",
			password: "bob-password",
			email: "bob@example.com",
			code: EMAIL_CODE,
		});
		expect(result.status).toBe("ok");
		expect(site.users.get("bob")).toBe("bob-password");
		await expect(t.client.request("account.register", { username: "x", password: "short" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("keeps a system access token login", async () => {
		await start({ variant: "modern" });
		const result = await t.client.request("account.login", { accessToken: PAT });
		expect(result.status).toBe("ok");
		expect(readFileSync(t.accountFile, "utf8")).toContain(PAT);
		await t.restart();
		expect((await t.client.request("account.overview", {})).user.username).toBe("alice");
		// The user's own access token is never revoked.
		await t.client.request("account.logout", {});
		expect(site.logouts).toBe(0);
	});
});
