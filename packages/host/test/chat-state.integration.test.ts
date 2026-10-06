import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildTranscript,
	ChatController,
	type ChatHooks,
	type ChatState,
	cacheableChatState,
	initialChatState,
	reduceChat,
} from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import type { SessionSnapshot, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall, Recorder, startTestHost, type TestHost } from "./helpers.ts";

const posixShell = process.platform !== "win32";

/** The desktop and mobile apps render from `@pier/chat-state`; check it against a real host. */
describe("chat-state against a live host", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost({ tokensPerSecond: 2000 });
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	it.skipIf(!posixShell)("rebuilds the host transcript from the event stream", async () => {
		t.faux.setResponses([
			fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("read", { path: "notes.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bash", { command: "touch made.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("All done."),
		]);
		writeFileSync(join(t.workspaceDir, "notes.txt"), "hello\n");
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
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
		expect(state.loaded).toBe(true);

		await client.request("session.prompt", { sessionId: session.id, text: "make a file" });
		const request = await rec.waitForType("ui.request");
		expect(state.pendingUi).toHaveLength(1);
		expect(state.runState).toBe("streaming");
		const waiting = buildTranscript(state).at(-1);
		const waitingTool = waiting?.kind === "assistant" ? waiting.blocks[0] : undefined;
		expect(waitingTool?.kind).toBe("tool");
		expect(["pending", "running"]).toContain(waitingTool?.kind === "tool" ? waitingTool.status : undefined);

		await client.request("ui.respond", {
			sessionId: session.id,
			requestId: (request.event.request as { id: string }).id,
			response: { decision: "allow_once" },
		});
		await rec.waitForType("agent_settled");
		await rec.waitFor((f) => f.event.type === "session.status" && f.event.state === "idle");

		const snapshot = await client.request("session.snapshot", { sessionId: session.id });
		expect(state.seq).toBe(snapshot.seq);
		expect(state.messages).toEqual(snapshot.messages);
		expect(state.streaming).toBeUndefined();
		expect(state.pendingUi).toEqual([]);
		expect(state.runState).toBe("idle");

		const items = buildTranscript(state);
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "assistant", "assistant"]);
		const [, first, second, last] = items;
		expect(first?.kind === "assistant" && first.blocks.map((b) => b.kind)).toEqual(["text", "tool"]);
		expect(first?.kind === "assistant" && first.blocks[1]).toMatchObject({ status: "done", call: { name: "read" } });
		expect(second?.kind === "assistant" && second.blocks[0]).toMatchObject({
			status: "done",
			call: { name: "bash", arguments: { command: "touch made.txt" } },
		});
		expect(last?.kind === "assistant" && last.blocks).toEqual([{ kind: "text", text: "All done." }]);
	});

	it("resumes a late subscriber mid-run from the snapshot", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("finished after the gate");
			},
		]);
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		await client.request("session.prompt", { sessionId: session.id, text: "wait" });

		const late = await t.connect();
		let state: ChatState = initialChatState(session.id);
		const rec = new Recorder();
		await late.subscribe(session.id, (frame) => {
			state = reduceChat(state, frame);
			rec.handler(frame);
		});
		await rec.waitForType("session.snapshot");
		expect((rec.frames[0]?.event.snapshot as SessionSnapshot | undefined)?.session.state).toBe("streaming");
		expect(state.runState).toBe("streaming");
		release();
		await rec.waitForType("agent_settled");
		const snapshot = await late.request("session.snapshot", { sessionId: session.id });
		expect(state.messages).toEqual(snapshot.messages);
	});

	/** Run a two-turn conversation in a new session, following it with a controller. */
	async function conversation(): Promise<{ session: SessionSummary; cached: ChatState }> {
		t.faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const { session } = await client.request("session.create", { workspaceId: workspace.id });
		const chat = new ChatController(client, session, hooks());
		await chat.start();
		await until(() => chat.chat.loaded);
		for (const text of ["one", "two"]) {
			const before = chat.chat.messages.length;
			await client.request("session.prompt", { sessionId: session.id, text });
			await until(() => chat.chat.messages.length >= before + 2 && chat.chat.runState === "idle");
		}
		const cached = cacheableChatState(chat.chat);
		chat.dispose();
		if (!cached) throw new Error("nothing to cache");
		return { session, cached: JSON.parse(JSON.stringify(cached)) as ChatState };
	}

	it("resumes a cached session from the missed events only", async () => {
		const { session, cached } = await conversation();
		t.faux.setResponses([fauxAssistantMessage("third answer")]);
		await client.request("session.prompt", { sessionId: session.id, text: "three" });
		await until(
			async () =>
				(await client.request("session.snapshot", { sessionId: session.id })).messages.length ===
				cached.messages.length + 2,
		);

		const phone = await t.connect();
		const frames: string[] = [];
		phone.onEvent((frame) => frames.push(frame.event.type));
		const chat = new ChatController(phone, session, hooks(), cached);
		expect(chat.chat.messages).toEqual(cached.messages);
		await chat.start();
		await until(() => chat.chat.messages.length === cached.messages.length + 2);
		expect(frames).not.toContain("session.snapshot");
		const snapshot = await phone.request("session.snapshot", { sessionId: session.id });
		expect(chat.chat.messages).toEqual(snapshot.messages);
		expect(chat.chat.seq).toBe(snapshot.seq);
		chat.dispose();
	});

	it("sends only the new messages after the session was reloaded", async () => {
		const { session, cached } = await conversation();
		// The host drops the session from memory (new event log): replay is no longer possible.
		await client.request("session.close", { sessionId: session.id });
		await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
		t.faux.setResponses([fauxAssistantMessage("third answer")]);
		await client.request("session.prompt", { sessionId: session.id, text: "three" });
		await until(
			async () =>
				(await client.request("session.snapshot", { sessionId: session.id })).messages.length ===
				cached.messages.length + 2,
		);

		const phone = await t.connect();
		const snapshots: SessionSnapshot[] = [];
		phone.onEvent((frame) => {
			if (frame.event.type === "session.snapshot") snapshots.push(frame.event.snapshot as SessionSnapshot);
		});
		const chat = new ChatController(phone, session, hooks(), cached);
		await chat.start();
		await until(() => snapshots.length === 1 && chat.chat.messages.length === cached.messages.length + 2);
		expect(snapshots[0]?.messagesFrom).toBe(cached.messages.length);
		expect(snapshots[0]?.messages).toHaveLength(2);
		const full = await phone.request("session.snapshot", { sessionId: session.id });
		expect(full.messagesFrom).toBeUndefined();
		expect(chat.chat.messages).toEqual(full.messages);
		chat.dispose();
	});

	it("sends the whole transcript when the cached prefix does not match", async () => {
		const { session, cached } = await conversation();
		const stale: ChatState = {
			...cached,
			epoch: "another-epoch",
			messages: cached.messages.map((m, i) => (i === cached.messages.length - 1 ? { ...m, timestamp: 1 } : m)),
		};
		const phone = await t.connect();
		const snapshots: SessionSnapshot[] = [];
		phone.onEvent((frame) => {
			if (frame.event.type === "session.snapshot") snapshots.push(frame.event.snapshot as SessionSnapshot);
		});
		const chat = new ChatController(phone, session, hooks(), stale);
		await chat.start();
		await until(() => snapshots.length === 1);
		expect(snapshots[0]?.messagesFrom).toBeUndefined();
		expect(chat.chat.messages).toEqual(cached.messages);
		chat.dispose();
	});
});

function hooks(): ChatHooks {
	return { onReplaced: () => {}, onSettled: () => {}, onChange: () => {}, onError: () => {} };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
