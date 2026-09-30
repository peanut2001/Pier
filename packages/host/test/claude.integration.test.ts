import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscript, type ChatState, initialChatState, reduceChat } from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import type { SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClaude, streamText } from "./fake-claude.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

const MODELS = [
	{
		provider: "claude-code",
		id: "default",
		name: "Default",
		reasoning: true,
		input: ["text", "image"],
		thinkingLevels: ["off" as const, "low" as const, "medium" as const, "high" as const],
	},
	{
		provider: "claude-code",
		id: "haiku",
		name: "Haiku",
		reasoning: true,
		input: ["text", "image"],
		thinkingLevels: ["off" as const, "low" as const, "high" as const],
	},
];

describe("Claude Code runtime", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let fake: FakeClaude;
	let configDir: string;

	beforeEach(async () => {
		configDir = mkdtempSync(join(tmpdir(), "pier-claude-"));
		fake = new FakeClaude(configDir);
		t = await startTestHost({
			agents: {
				codex: false,
				claudeCode: {
					executable: "/usr/bin/false",
					configDir,
					sdk: fake.sdk,
					catalog: { models: MODELS, commands: [{ name: "review", source: "prompt" }] },
				},
			},
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
		rmSync(configDir, { recursive: true, force: true });
	});

	async function open(session: SessionSummary) {
		let state: ChatState = initialChatState(session.id, session);
		const rec = new Recorder();
		await client.subscribe(
			session.id,
			(frame) => {
				state = reduceChat(state, frame);
				rec.handler(frame);
			},
			{ workspaceId: workspace.id },
		);
		await rec.waitForType("session.snapshot");
		return { rec, state: () => state };
	}

	it("lists the runtime with its capabilities", async () => {
		const { runtimes } = await client.request("runtime.list", {});
		expect(runtimes.map((r) => r.id)).toEqual(["pi", "claude-code"]);
		expect(runtimes[1]).toMatchObject({
			name: "Claude Code",
			available: true,
			capabilities: { steer: true, compact: true, piExtensions: false },
		});
		const models = await client.request("model.list", { workspaceId: workspace.id, runtime: "claude-code" });
		expect(models.models.map((m) => m.id)).toEqual(["default", "haiku"]);
		expect(models.current?.id).toBe("default");
	});

	it("streams a reply, asks for approval, and stores the session", async () => {
		fake.responder = async function* (ctx) {
			if (ctx.text === "make a file") {
				yield {
					type: "stream_event",
					event: { type: "message_start", message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 5 } } },
				};
				yield {
					type: "stream_event",
					event: {
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_1", name: "Bash" },
					},
				};
				yield {
					type: "stream_event",
					event: {
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"command":"touch made.txt"}' },
					},
				};
				yield {
					type: "assistant",
					message: {
						id: "msg_1",
						content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "touch made.txt" } }],
					},
				};
				yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
				yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} } };
				yield { type: "stream_event", event: { type: "message_stop" } };
				const decision = await ctx.canUseTool("Bash", { command: "touch made.txt" }, "tool_1");
				yield {
					type: "user",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_1",
								content: decision.behavior === "allow" ? "" : String(decision.message),
								is_error: decision.behavior !== "allow",
							},
						],
					},
				};
				yield* streamText("msg_2", "All done.");
			}
		};
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "claude-code" });
		expect(session.runtime).toBe("claude-code");
		const { rec, state } = await open(session);

		await client.request("session.prompt", { sessionId: session.id, text: "make a file" });
		const request = await rec.waitForType("ui.request");
		expect(request.event.request).toMatchObject({
			kind: "approval",
			approval: { toolName: "bash", summary: "touch made.txt", toolCallId: "tool_1" },
		});
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (request.event.request as { id: string }).id,
			response: { decision: "allow_once" },
		});
		await rec.waitForType("agent_settled");
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle");

		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(state().messages).toEqual(snapshot.messages);
		const items = buildTranscript(state());
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "assistant"]);
		expect(items[1]?.kind === "assistant" && items[1].blocks[0]).toMatchObject({
			kind: "tool",
			status: "done",
			call: { name: "bash", arguments: { command: "touch made.txt" } },
		});
		expect(items[2]?.kind === "assistant" && items[2].blocks).toEqual([{ kind: "text", text: "All done." }]);
		expect(rec.text()).toBe("All done.");

		// The stored session shows up in the list and reopens with the same transcript.
		await client.request("session.close", { sessionId: session.id });
		const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
		const listed = sessions.find((s) => s.id === session.id);
		expect(listed).toMatchObject({ runtime: "claude-code", active: false, firstMessage: "make a file" });
		const reopened = await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		const again = await client.request("session.snapshot", { sessionId: reopened.session.id });
		expect(again.messages.map((m) => (m as { role: string }).role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("denies a tool call the user rejects and resumes the stored session", async () => {
		fake.responder = async function* (ctx) {
			const decision = await ctx.canUseTool("Write", { file_path: "/etc/passwd", content: "x" }, "tool_w");
			yield* streamText("msg_w", decision.behavior === "allow" ? "wrote" : `refused: ${decision.message}`);
		};
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "claude-code" });
		const { rec } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "write" });
		const request = await rec.waitForType("ui.request");
		expect(request.event.request).toMatchObject({ approval: { toolName: "write", severity: "high" } });
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (request.event.request as { id: string }).id,
			response: { decision: "deny", reason: "no" },
		});
		await rec.waitForType("agent_settled");
		expect(rec.text()).toBe("refused: Denied by the user: no");
		expect(fake.options[0]).toMatchObject({ sessionId: session.id, cwd: workspace.path });

		// A second prompt reuses the running process; a new process resumes the session.
		fake.responder = async function* () {
			yield* streamText("msg_x", "again");
		};
		const mark = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "again" });
		await rec.waitForType("agent_settled", mark);
		expect(fake.options).toHaveLength(1);
		await client.request("session.close", { sessionId: session.id });
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		await client.request("session.prompt", { sessionId: session.id, text: "third" });
		await expect.poll(() => fake.options.length).toBe(2);
		expect(fake.options[1]).toMatchObject({ resume: session.id });
	});

	it("switches models and thinking levels, renames and forks", async () => {
		fake.responder = async function* (ctx) {
			yield* streamText(`msg_${ctx.text}`, `reply to ${ctx.text}`);
		};
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "claude-code" });
		const { rec } = await open(session);
		expect(
			await client.request("model.set", { sessionId: session.id, provider: "claude-code", modelId: "haiku" }),
		).toEqual({
			model: MODELS[1],
		});
		await expect(
			client.request("model.set", { sessionId: session.id, provider: "faux", modelId: "faux-1" }),
		).rejects.toThrow(/Claude Code models/);
		expect(await client.request("thinking.set", { sessionId: session.id, level: "medium" })).toEqual({ level: "high" });

		await client.request("session.prompt", { sessionId: session.id, text: "one" });
		await rec.waitForType("agent_settled");
		expect(fake.options[0]).toMatchObject({ model: "haiku", effort: "high" });
		const mark = rec.mark();
		await client.request("session.prompt", { sessionId: session.id, text: "two" });
		await rec.waitForType("agent_settled", mark);
		await client.request("thinking.set", { sessionId: session.id, level: "off" });
		expect(fake.calls).toContain("thinkingTokens:0");

		const renamed = await client.request("session.rename", { sessionId: session.id, name: "Named" });
		expect(renamed.session.name).toBe("Named");
		expect(fake.sessions.get(session.id)?.title).toBe("Named");

		const { commands } = await client.request("session.commands", { sessionId: session.id });
		expect(commands).toEqual([{ name: "review", description: "Review code", source: "prompt" }]);

		const { points } = await client.request("session.forkPoints", { sessionId: session.id });
		expect(points.map((p) => p.text)).toEqual(["one", "two"]);
		const forked = await client.request("session.fork", { sessionId: session.id, entryId: points[1]?.entryId ?? "" });
		expect(forked.selectedText).toBe("two");
		expect(forked.session.runtime).toBe("claude-code");
		const snapshot = await client.request("session.snapshot", { sessionId: forked.session.id });
		expect(snapshot.messages.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant"]);

		await expect(client.request("session.reload", { sessionId: session.id })).rejects.toThrow(/do not support/);
	});

	it("queues follow-ups while the agent works", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		fake.responder = async function* (ctx) {
			if (ctx.text === "first") await gate;
			yield* streamText(`msg_${ctx.text}`, `reply to ${ctx.text}`);
		};
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "claude-code" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "first" });
		await expect(client.request("session.prompt", { sessionId: session.id, text: "x" })).rejects.toThrow(/busy/);
		const { queue } = await client.request("session.followUp", { sessionId: session.id, text: "second" });
		expect(queue.followUp).toEqual(["second"]);
		release();
		await rec.waitFor(
			(f) => f.event.type === "message_end" && JSON.stringify(f.event.message).includes("reply to second"),
		);
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle");
		const users = buildTranscript(state()).filter((i) => i.kind === "user");
		expect(users.map((u) => (u.kind === "user" ? u.text : ""))).toEqual(["first", "second"]);
		expect(state().queue).toEqual({ steering: [], followUp: [] });
	});
});
