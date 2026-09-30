import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTranscript, type ChatState, initialChatState, reduceChat } from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import type { SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import { Recorder, startTestHost, type TestHost } from "./helpers.ts";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

describe("Codex runtime", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let codexDir: string;

	beforeEach(async () => {
		codexDir = mkdtempSync(join(tmpdir(), "pier-codex-"));
		t = await startTestHost({
			agents: {
				claudeCode: false,
				codex: {
					executable: process.execPath,
					args: [FAKE_SERVER],
					env: { ...process.env, FAKE_CODEX_DIR: codexDir },
				},
			},
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(async () => {
		await t.close();
		rmSync(codexDir, { recursive: true, force: true });
	});

	function runtime(): CodexRuntime {
		return t.host.pool.runtime("codex") as CodexRuntime;
	}

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

	it("runs a turn with an approval and stores the thread", async () => {
		const { runtimes } = await client.request("runtime.list", {});
		expect(runtimes.find((r) => r.id === "codex")).toMatchObject({ available: true, name: "Codex" });
		const models = await client.request("model.list", { workspaceId: workspace.id, runtime: "codex" });
		expect(models.models.map((m) => m.id)).toEqual(["gpt-test", "gpt-mini"]);
		expect(models).toMatchObject({ current: { id: "gpt-test" }, thinkingLevel: "medium" });

		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		expect(session.runtime).toBe("codex");
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "please run it" });
		const request = await rec.waitForType("ui.request");
		expect(request.event.request).toMatchObject({
			kind: "approval",
			approval: { toolName: "bash", summary: "npm install" },
		});
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (request.event.request as { id: string }).id,
			response: { decision: "allow_once" },
		});
		await rec.waitForType("agent_settled");
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle");
		expect(rec.text()).toBe("Reply to please run it");

		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(state().messages).toEqual(snapshot.messages);
		const items = buildTranscript(state());
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "assistant"]);
		expect(items[1]?.kind === "assistant" && items[1].blocks[0]).toMatchObject({
			kind: "tool",
			status: "done",
			call: { name: "bash", arguments: { command: "npm install" } },
			result: { content: [{ type: "text", text: "hi\n" }] },
		});
		expect(items[2]?.kind === "assistant" && items[2].blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
		const last = await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id });
		expect(last).toMatchObject({ approvalPolicy: "on-request", effort: "medium", cwd: workspace.path });

		await client.request("session.close", { sessionId: session.id });
		const { sessions } = await client.request("session.list", { workspaceId: workspace.id });
		expect(sessions.find((s) => s.id === session.id)).toMatchObject({
			runtime: "codex",
			active: false,
			firstMessage: "please run it",
		});
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		const reopened = await client.request("session.snapshot", { sessionId: session.id });
		expect(reopened.messages.map((m) => (m as { role: string }).role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);

		// Deleting archives the thread in Codex.
		await client.request("session.close", { sessionId: session.id });
		expect(await client.request("session.delete", { workspaceId: workspace.id, sessionId: session.id })).toEqual({
			deleted: true,
		});
		const after = await client.request("session.list", { workspaceId: workspace.id });
		expect(after.sessions.some((s) => s.id === session.id)).toBe(false);
	});

	it("declines commands the user denies and follows the workspace policy", async () => {
		await client.request("workspace.setPolicy", { workspaceId: workspace.id, policy: "ask" });
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "run" });
		const request = await rec.waitForType("ui.request");
		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (request.event.request as { id: string }).id,
			response: { decision: "deny" },
		});
		await rec.waitForType("agent_settled");
		const tool = buildTranscript(state())[1];
		expect(tool?.kind === "assistant" && tool.blocks[0]).toMatchObject({ kind: "tool", status: "error" });
		const last = await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id });
		expect(last).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite" } });
	});

	it("steers, queues follow-ups, switches models, renames and forks", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		expect(
			await client.request("model.set", { sessionId: session.id, provider: "codex", modelId: "gpt-mini" }),
		).toMatchObject({ model: { id: "gpt-mini", thinkingLevels: ["low"] } });
		expect(await client.request("thinking.set", { sessionId: session.id, level: "high" })).toEqual({ level: "low" });

		await client.request("session.prompt", { sessionId: session.id, text: "wait here" });
		await rec.waitForType("agent_start");
		await expect.poll(() => state().runState).toBe("streaming");
		await client.request("session.followUp", { sessionId: session.id, text: "later" });
		await expect
			.poll(async () => (await client.request("session.snapshot", { sessionId: session.id })).queue.followUp)
			.toEqual(["later"]);
		await client.request("session.steer", { sessionId: session.id, text: "now" });
		await rec.waitFor(
			(f) => f.event.type === "message_end" && JSON.stringify(f.event.message).includes("Reply to later"),
		);
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle");
		const users = buildTranscript(state())
			.filter((i) => i.kind === "user")
			.map((i) => (i.kind === "user" ? i.text : ""));
		expect(users).toEqual(["wait here", "now", "later"]);
		expect(rec.text()).toContain("Reply to wait here + 1 steer");
		const last = await runtime().server().request<Record<string, unknown>>("fake/lastTurn", { threadId: session.id });
		expect(last).toMatchObject({ model: "gpt-mini", effort: "low" });

		const renamed = await client.request("session.rename", { sessionId: session.id, name: "Codex chat" });
		expect(renamed.session.name).toBe("Codex chat");

		const { points } = await client.request("session.forkPoints", { sessionId: session.id });
		expect(points.map((p) => p.text)).toEqual(["wait here", "later"]);
		const forked = await client.request("session.fork", { sessionId: session.id, entryId: points[1]?.entryId ?? "" });
		expect(forked.selectedText).toBe("later");
		const snapshot = await client.request("session.snapshot", { sessionId: forked.session.id });
		expect(snapshot.messages.filter((m) => (m as { role: string }).role === "user")).toHaveLength(2);

		const compacted = await client.request("session.compact", { sessionId: session.id });
		expect(compacted).toEqual({ summary: "", tokensBefore: 0 });
	});

	it("aborts a running turn", async () => {
		const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime: "codex" });
		const { rec, state } = await open(session);
		await client.request("session.prompt", { sessionId: session.id, text: "wait forever" });
		await rec.waitForType("agent_start");
		await expect.poll(() => runtime().server().request("fake/lastTurn", { threadId: session.id })).not.toBeNull();
		await client.request("session.abort", { sessionId: session.id });
		await rec.waitForType("agent_settled");
		expect(state().runState).toBe("idle");
		expect(state().errorMessage).toBeUndefined();
	});
});
