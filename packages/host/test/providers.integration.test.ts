import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
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
import { mergeCustomProvider, stripJsonComments, toCustomProvider } from "../src/pi/models-json.ts";
import { Recorder, TOKEN } from "./helpers.ts";

const SECRET = "sk-test-SECRET-0123456789";

interface Harness {
	root: string;
	modelsPath: string;
	credentials: InMemoryCredentialStore;
	settings: SettingsManager;
	host: PierHost;
	client: PierClient;
	events: Recorder;
	close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pier-providers-"));
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
	const client = new PierClient({ url: gateway.url, token: TOKEN, client: { name: "test", version: "0.0.0" } });
	await client.connect();
	const events = new Recorder();
	client.onEvent(events.handler);
	return {
		root,
		modelsPath,
		credentials,
		settings,
		host,
		client,
		events,
		async close() {
			client.close();
			await host.shutdown();
			await gateway.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A tiny OpenAI-compatible `/v1/models` endpoint that records request headers. */
function startModelsServer(): Promise<{ url: string; headers: IncomingHttpHeaders[]; server: Server }> {
	const headers: IncomingHttpHeaders[] = [];
	const server = createServer((req, res) => {
		headers.push(req.headers);
		if (req.url === "/v1/models" && req.headers.authorization === `Bearer ${SECRET}`) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "gpt-b" }, { id: "gpt-a" }, { id: "gpt-a" }] }));
			return;
		}
		res.statusCode = 401;
		res.end(JSON.stringify({ error: `bad key ${req.headers.authorization ?? ""}` }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ url: `http://127.0.0.1:${port}/v1`, headers, server });
		});
	});
}

describe("models.json helpers", () => {
	it("strips comments and trailing commas outside strings", () => {
		const text = '{\n  // comment\n  "a": "http://x//y",\n  "b": [1, 2,],\n}';
		expect(JSON.parse(stripJsonComments(text))).toEqual({ a: "http://x//y", b: [1, 2] });
	});

	it("merges form fields while keeping unknown settings", () => {
		const previous = {
			api: "openai-completions",
			baseUrl: "http://old",
			headers: { "x-extra": "1" },
			apiKey: "$KEY",
			models: [{ id: "keep", compat: { supportsStore: false }, reasoning: true }, { id: "drop" }],
		};
		const merged = mergeCustomProvider(previous, {
			id: "p",
			name: "My Proxy",
			api: "openai-completions",
			baseUrl: "https://new/v1/",
			models: [
				{ id: "keep", images: true },
				{ id: "new", reasoning: true, contextWindow: 200000 },
			],
		});
		expect(merged).toEqual({
			name: "My Proxy",
			api: "openai-completions",
			baseUrl: "https://new/v1",
			headers: { "x-extra": "1" },
			apiKey: "$KEY",
			models: [
				{ id: "keep", compat: { supportsStore: false }, input: ["text", "image"] },
				{ id: "new", reasoning: true, input: ["text"], contextWindow: 200000 },
			],
		});
		expect(toCustomProvider("p", merged)).toEqual({
			id: "p",
			name: "My Proxy",
			api: "openai-completions",
			baseUrl: "https://new/v1",
			models: [
				{ id: "keep", images: true },
				{ id: "new", reasoning: true, contextWindow: 200000 },
			],
			hasConfiguredKey: true,
		});
		expect(toCustomProvider("p", { baseUrl: "http://x", models: [{ id: "a" }] })).toBeUndefined();
	});
});

describe("provider configuration", () => {
	let t: Harness;
	let models: Awaited<ReturnType<typeof startModelsServer>>;
	const offline = process.env.PI_OFFLINE;

	beforeAll(async () => {
		process.env.PI_OFFLINE = "1";
		models = await startModelsServer();
	});
	afterAll(() => {
		models.server.close();
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	});
	beforeEach(async () => {
		t = await startHarness();
	});
	afterEach(async () => {
		await t.close();
	});

	it("lists built-in providers without credentials", async () => {
		const result = await t.client.request("provider.list");
		expect(result.availableCount).toBe(0);
		expect(result.defaultModel).toBeUndefined();
		const anthropic = result.providers.find((p) => p.id === "anthropic");
		expect(anthropic).toMatchObject({ builtin: true, stored: false, status: { configured: false } });
		expect(anthropic?.apiKey?.interactive).toBe(true);
		expect(anthropic?.oauth).toBeDefined();
		expect(anthropic?.modelCount).toBeGreaterThan(0);
	});

	it("adds, edits and removes a custom endpoint", async () => {
		const probe = await t.client.request("provider.probeModels", {
			api: "openai-completions",
			baseUrl: models.url,
			apiKey: SECRET,
		});
		expect(probe.models).toEqual([{ id: "gpt-a" }, { id: "gpt-b" }]);

		await expect(
			t.client.request("provider.saveCustom", {
				provider: { id: "my-proxy", api: "openai-completions", baseUrl: models.url, models: [{ id: "gpt-a" }] },
				create: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const mark = t.events.mark();
		const saved = await t.client.request("provider.saveCustom", {
			provider: {
				id: "my-proxy",
				name: "My Proxy",
				api: "openai-completions",
				baseUrl: `${models.url}/`,
				models: [
					{ id: "gpt-a", reasoning: true },
					{ id: "gpt-b", images: true },
				],
			},
			apiKey: SECRET,
			create: true,
		});
		await t.events.waitForType("provider.changed", mark);
		expect(saved.defaultModel).toEqual({ provider: "my-proxy", modelId: "gpt-a" });
		expect(saved.provider).toMatchObject({
			id: "my-proxy",
			name: "My Proxy",
			builtin: false,
			stored: true,
			modelCount: 2,
			availableCount: 2,
			status: { configured: true, type: "api_key" },
			custom: { baseUrl: models.url, hasConfiguredKey: false },
		});

		// The key lives in the credential store, never in models.json or responses.
		const file = readFileSync(t.modelsPath, "utf8");
		expect(file).not.toContain(SECRET);
		expect(JSON.parse(file).providers["my-proxy"].models[1]).toEqual({ id: "gpt-b", input: ["text", "image"] });
		if (process.platform !== "win32") expect(statSync(t.modelsPath).mode & 0o777).toBe(0o600);
		expect(await t.credentials.read("my-proxy")).toEqual({ type: "api_key", key: SECRET });
		expect(JSON.stringify(await t.client.request("provider.list"))).not.toContain(SECRET);

		const list = await t.client.request("model.list");
		expect(list.models.map((m) => `${m.provider}/${m.id}`)).toEqual(["my-proxy/gpt-a", "my-proxy/gpt-b"]);

		// Probing a saved provider reuses its stored key.
		const again = await t.client.request("provider.probeModels", {
			api: "openai-completions",
			baseUrl: models.url,
			providerId: "my-proxy",
		});
		expect(again.models).toHaveLength(2);
		await expect(
			t.client.request("provider.probeModels", { api: "openai-completions", baseUrl: models.url, apiKey: "wrong" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("401") });

		await expect(
			t.client.request("provider.saveCustom", {
				provider: { id: "my-proxy", api: "openai-completions", baseUrl: models.url, models: [{ id: "x" }] },
				create: true,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			t.client.request("provider.saveCustom", {
				provider: { id: "anthropic", api: "anthropic-messages", baseUrl: models.url, models: [{ id: "x" }] },
				apiKey: SECRET,
				create: true,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		// Editing without a key keeps the stored one.
		const edited = await t.client.request("provider.saveCustom", {
			provider: { id: "my-proxy", api: "openai-completions", baseUrl: models.url, models: [{ id: "gpt-b" }] },
		});
		expect(edited.provider.availableCount).toBe(1);
		expect(edited.defaultModel).toEqual({ provider: "my-proxy", modelId: "gpt-b" });
		expect(await t.credentials.read("my-proxy")).toEqual({ type: "api_key", key: SECRET });

		await t.client.request("model.setDefault", { provider: "my-proxy", modelId: "gpt-b" });
		await expect(
			t.client.request("model.setDefault", { provider: "my-proxy", modelId: "missing" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect((await t.client.request("provider.removeCustom", { providerId: "my-proxy" })).removed).toBe(true);
		expect(await t.credentials.read("my-proxy")).toBeUndefined();
		const after = await t.client.request("provider.list");
		expect(after.providers.some((p) => p.id === "my-proxy")).toBe(false);
		expect(after.availableCount).toBe(0);
		expect(JSON.parse(readFileSync(t.modelsPath, "utf8")).providers).toEqual({});
	});

	it("keeps other models.json content and rolls back invalid edits", async () => {
		writeFileSync(
			t.modelsPath,
			'{\n  // hand written\n  "providers": {\n    "other": { "baseUrl": "http://o", "api": "openai-completions", "apiKey": "x", "models": [{ "id": "o1" }] },\n  },\n}\n',
		);
		await t.host.env.modelRuntime.refresh({ allowNetwork: false });
		await t.client.request("provider.saveCustom", {
			provider: { id: "mine", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9", models: [{ id: "claude" }] },
			apiKey: SECRET,
			create: true,
		});
		const doc = JSON.parse(readFileSync(t.modelsPath, "utf8"));
		expect(Object.keys(doc.providers)).toEqual(["other", "mine"]);
		expect(doc.providers.other.apiKey).toBe("x");
		expect(readFileSync(`${t.modelsPath}.bak`, "utf8")).toContain("// hand written");

		const list = await t.client.request("provider.list");
		const other = list.providers.find((p) => p.id === "other");
		expect(other?.custom).toMatchObject({ hasConfiguredKey: true, models: [{ id: "o1" }] });
		expect(other?.status).toMatchObject({ configured: true, source: "models_json_key" });

		// pi rejects the file as a whole when any entry breaks its schema: the edit is rolled back.
		const broken = '{ "providers": { "bad": { "baseUrl": "http://b", "models": "nope" } } }\n';
		writeFileSync(t.modelsPath, broken);
		await expect(
			t.client.request("provider.saveCustom", {
				provider: { id: "mine2", api: "openai-completions", baseUrl: "http://127.0.0.1:9", models: [{ id: "m" }] },
				apiKey: SECRET,
				create: true,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("models.json") });
		expect(readFileSync(t.modelsPath, "utf8")).toBe(broken);
		expect(await t.credentials.read("mine2")).toBeUndefined();
	});

	it("signs in to a built-in provider through prompts and signs out", async () => {
		const mark = t.events.mark();
		const { flowId } = await t.client.request("provider.login", { providerId: "openai", method: "api_key" });
		const prompt = await t.events.waitForType("auth.prompt", mark);
		expect(prompt.event.flowId).toBe(flowId);
		const info = prompt.event.prompt as { id: string; type: string };
		expect(info.type).toBe("secret");
		expect(
			(
				await t.client.request("provider.loginRespond", {
					flowId,
					promptId: info.id,
					value: SECRET,
				})
			).accepted,
		).toBe(true);
		const done = await t.events.waitForType("auth.done", mark);
		expect(done.event).toMatchObject({ flowId, providerId: "openai", ok: true });
		expect(done.event.defaultModel).toMatchObject({ provider: "openai" });
		expect(await t.credentials.read("openai")).toEqual({ type: "api_key", key: SECRET });

		const list = await t.client.request("provider.list");
		const openai = list.providers.find((p) => p.id === "openai");
		expect(openai).toMatchObject({ stored: true, status: { configured: true, type: "api_key", source: "stored" } });
		expect(list.defaultAvailable).toBe(true);

		expect((await t.client.request("provider.logout", { providerId: "openai" })).removed).toBe(true);
		expect(await t.credentials.read("openai")).toBeUndefined();
		expect((await t.client.request("provider.logout", { providerId: "openai" })).removed).toBe(false);
	});

	it("removes a built-in provider's key from models.json, stored credential first", async () => {
		writeFileSync(
			t.modelsPath,
			JSON.stringify({
				providers: {
					deepseek: { apiKey: "sk-in-models-json" },
					openai: { apiKey: "!echo sk-from-command", headers: { "x-extra": "1" } },
					anthropic: { apiKey: "$PIER_TEST_UNSET_ANTHROPIC_KEY" },
				},
			}),
		);
		await t.credentials.modify("deepseek", async () => ({ type: "api_key", key: SECRET }));
		await t.host.env.modelRuntime.refresh({ allowNetwork: false });
		const find = async (id: string) => (await t.client.request("provider.list")).providers.find((p) => p.id === id);
		expect(await find("deepseek")).toMatchObject({ stored: true, status: { configured: true, source: "stored" } });
		expect((await find("openai"))?.status).toMatchObject({ configured: true, source: "models_json_command" });

		// The stored credential goes first; models.json is untouched.
		expect((await t.client.request("provider.logout", { providerId: "deepseek" })).removed).toBe(true);
		expect(await t.credentials.read("deepseek")).toBeUndefined();
		expect(JSON.parse(readFileSync(t.modelsPath, "utf8")).providers.deepseek).toEqual({ apiKey: "sk-in-models-json" });
		expect(await find("deepseek")).toMatchObject({
			stored: false,
			status: { configured: true, source: "models_json_key" },
		});

		// Then the models.json key: an entry holding nothing else is dropped.
		expect((await t.client.request("provider.logout", { providerId: "deepseek" })).removed).toBe(true);
		expect((await t.client.request("provider.logout", { providerId: "openai" })).removed).toBe(true);
		const doc = JSON.parse(readFileSync(t.modelsPath, "utf8"));
		expect(doc.providers).toEqual({
			openai: { headers: { "x-extra": "1" } },
			anthropic: { apiKey: "$PIER_TEST_UNSET_ANTHROPIC_KEY" },
		});
		expect((await find("deepseek"))?.status.configured).toBe(false);
		expect((await find("openai"))?.status.configured).toBe(false);

		// Environment variable references are not credentials Pier removes.
		expect((await t.client.request("provider.logout", { providerId: "anthropic" })).removed).toBe(false);
		expect((await t.client.request("provider.logout", { providerId: "deepseek" })).removed).toBe(false);
		expect(JSON.parse(readFileSync(t.modelsPath, "utf8"))).toEqual(doc);
	});

	it("cancels a sign-in", async () => {
		const mark = t.events.mark();
		const { flowId } = await t.client.request("provider.login", { providerId: "openai", method: "api_key" });
		await t.events.waitForType("auth.prompt", mark);
		expect((await t.client.request("provider.loginCancel", { flowId })).cancelled).toBe(true);
		const done = await t.events.waitForType("auth.done", mark);
		expect(done.event).toMatchObject({ flowId, ok: false, cancelled: true });
		expect(await t.credentials.read("openai")).toBeUndefined();
		await expect(t.client.request("provider.login", { providerId: "nope", method: "api_key" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(t.client.request("provider.login", { providerId: "openai", method: "oauth" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});
