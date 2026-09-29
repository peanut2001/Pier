import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import { PierProtocolError, type SessionSummary, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, Recorder, startTestHost, type TestHost } from "./helpers.ts";

function userTexts(context: { messages: unknown[] }): string[] {
	const messages = context.messages as Array<{ role: string; content?: unknown }>;
	return messages
		.filter((m) => m.role === "user")
		.map((m) =>
			typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content.map((c: { text?: string }) => c.text ?? "").join("")
					: "",
		);
}

describe("slash commands", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let resources: string;
	const commandCalls: string[] = [];

	beforeEach(async () => {
		commandCalls.length = 0;
		resources = mkdtempSync(join(tmpdir(), "pier-commands-"));
		mkdirSync(join(resources, "skills", "demo-skill"), { recursive: true });
		writeFileSync(
			join(resources, "skills", "demo-skill", "SKILL.md"),
			"---\nname: demo-skill\ndescription: A demo skill for tests\n---\n\nDEMO SKILL BODY\n",
		);
		mkdirSync(join(resources, "prompts"), { recursive: true });
		writeFileSync(
			join(resources, "prompts", "review.md"),
			'---\ndescription: Review a file\nargument-hint: "<file>"\n---\nPlease review $1 carefully.\n',
		);
		t = await startTestHost({
			extraResources: {
				skillPaths: [join(resources, "skills")],
				promptTemplatePaths: [join(resources, "prompts")],
				extensions: [
					{
						name: "test-commands",
						factory: (pi) => {
							pi.registerCommand("hello", {
								description: "Say hello",
								handler: async (args) => {
									commandCalls.push(args);
								},
							});
							pi.registerCommand("ask", {
								description: "Ask a question",
								handler: async (_args, ctx) => {
									const ok = await ctx.ui.confirm("Proceed?", "Really?");
									commandCalls.push(ok ? "yes" : "no");
								},
							});
						},
					},
				],
			},
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
		rmSync(resources, { recursive: true, force: true });
	});

	async function newSession(): Promise<{ session: SessionSummary; rec: Recorder }> {
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		const rec = new Recorder();
		await client.subscribe(session.id, rec.handler, { workspaceId: workspace.id });
		await rec.waitForType("session.snapshot");
		return { session, rec };
	}

	it("lists extension commands, prompt templates, and skills", async () => {
		const { session } = await newSession();
		const { commands } = await client.request("session.commands", { sessionId: session.id });
		expect(commands).toContainEqual({ name: "hello", description: "Say hello", source: "extension" });
		expect(commands).toContainEqual({
			name: "review",
			description: "Review a file",
			argumentHint: "<file>",
			source: "prompt",
		});
		expect(commands).toContainEqual({
			name: "skill:demo-skill",
			description: "A demo skill for tests",
			source: "skill",
		});
	});

	it("runs extension commands, templates, and skills through session.prompt", async () => {
		const { session, rec } = await newSession();
		await client.request("session.prompt", { sessionId: session.id, text: "/hello world" });
		await expect.poll(() => commandCalls).toEqual(["world"]);

		const seen: string[][] = [];
		t.faux.setResponses([
			(context) => {
				seen.push(userTexts(context));
				return fauxAssistantMessage("ok");
			},
			(context) => {
				seen.push(userTexts(context));
				return fauxAssistantMessage("ok");
			},
		]);
		let from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "/review src/main.ts" });
		await rec.waitForType("agent_settled", from);
		expect(seen[0]?.at(-1)).toContain("Please review src/main.ts carefully.");

		from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "/skill:demo-skill do it" });
		await rec.waitForType("agent_settled", from);
		const last = seen[1]?.at(-1) ?? "";
		expect(last).toContain("DEMO SKILL BODY");
		expect(last).toContain("do it");
	});

	it("accepts extension commands that wait for a UI answer right away", async () => {
		const { session, rec } = await newSession();
		const from = rec.mark();
		expect(await client.request("session.prompt", { sessionId: session.id, text: "/ask" })).toEqual({
			accepted: true,
		});
		const request = await rec.waitForType("ui.request", from);
		const requestId = (request.event.request as { id: string }).id;
		await client.request("ui.respond", { sessionId: session.id, requestId, response: { confirmed: true } });
		await rec.waitForType("ui.resolved", from);
		await expect.poll(() => commandCalls).toEqual(["yes"]);
	});

	it("reloads resources", async () => {
		const { session } = await newSession();
		writeFileSync(join(resources, "prompts", "later.md"), "---\ndescription: Added later\n---\nLater.\n");
		const before = await client.request("session.commands", { sessionId: session.id });
		expect(before.commands.some((c) => c.name === "later")).toBe(false);
		expect(await client.request("session.reload", { sessionId: session.id })).toEqual({ reloaded: true });
		const after = await client.request("session.commands", { sessionId: session.id });
		expect(after.commands.some((c) => c.name === "later")).toBe(true);
		// Extension commands survive the reload.
		expect(after.commands.some((c) => c.name === "hello")).toBe(true);
	});

	it("refuses to reload while the agent runs", async () => {
		const { session, rec } = await newSession();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("done");
			},
		]);
		const from = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "work" });
		const error = await client.request("session.reload", { sessionId: session.id }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PierProtocolError);
		expect((error as PierProtocolError).code).toBe("CONFLICT");
		release();
		await rec.waitForType("agent_settled", from);
	});
});
