/* biome-ignore-all lint/complexity/useLiteralKeys: Seed store clients and nodes without changing the public API. */
import type { PierClient } from "@pier/client";
import type { AgentRuntimeId, SessionSummary } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { LOCAL_NODE, NEW_CHAT_DRAFT, PierStore } from "../src/lib/store.tsx";

const draft = { text: "First message", images: [] };
const session: SessionSummary = {
	id: "session",
	workspaceId: "workspace",
	cwd: "/workspace",
	createdAt: "",
	modifiedAt: "",
	messageCount: 0,
	firstMessage: "",
	active: true,
	state: "idle",
	runtime: "codex",
};

function setup(owner = LOCAL_NODE, runtime: AgentRuntimeId = "codex") {
	const store = new PierStore({ kind: "browser" } as Bridge);
	const request = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ session }));
	const otherRequest = vi.fn();
	store["clients"].set(owner, { request } as unknown as PierClient);
	store["clients"].set("other", { request: otherRequest } as unknown as PierClient);
	store["set"]({ workspaceNodes: { workspace: owner }, newChat: { workspaceId: "workspace" } });
	store.setNewChatRuntime("workspace", runtime);
	store.saveDraft(NEW_CHAT_DRAFT, draft);
	return { store, request, otherRequest };
}

beforeEach(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("new-chat Fast mode", () => {
	it.each([LOCAL_NODE, "peer"])(
		"applies explicit on and off choices on the workspace's computer (%s)",
		async (owner) => {
			for (const enabled of [true, false]) {
				const { store, request, otherRequest } = setup(owner);
				store.setNewChatModel("workspace", { fastMode: enabled });
				expect(await store.sendNewChat(draft)).toBe(true);
				expect(request.mock.calls).toEqual([
					["session.create", { workspaceId: "workspace", runtime: "codex" }],
					["fast.set", { sessionId: session.id, enabled }],
				]);
				expect(otherRequest).not.toHaveBeenCalled();
				expect(store.getState().selectedSessionId).toBe(session.id);
				expect(store.draft(session.id)).toEqual(draft);
				expect(store.takeAutoSend(session.id)).toBe(true);
			}
		},
	);

	it("waits for Fast to apply before allowing the first message to send", async () => {
		const { store, request } = setup();
		const started = Promise.withResolvers<void>();
		const applied = Promise.withResolvers<{ enabled: boolean }>();
		request.mockImplementation(async (method) => {
			if (method !== "fast.set") return { session };
			started.resolve();
			return applied.promise;
		});
		store.setNewChatModel("workspace", { fastMode: true });
		const sending = store.sendNewChat(draft);
		await started.promise;
		expect(store.takeAutoSend(session.id)).toBe(false);
		expect(store.getState().selectedSessionId).toBeUndefined();
		applied.resolve({ enabled: true });
		await sending;
		expect(store.takeAutoSend(session.id)).toBe(true);
	});

	it("preserves the draft without sending if the host rejects Fast", async () => {
		const { store, request } = setup();
		request.mockImplementation(async (method) => {
			if (method === "fast.set") throw new Error("Fast mode unavailable");
			return { session };
		});
		store.setNewChatModel("workspace", { fastMode: true });
		expect(await store.sendNewChat(draft)).toBe(true);
		expect(store.getState().selectedSessionId).toBe(session.id);
		expect(store.draft(session.id)).toEqual(draft);
		expect(store.draft(NEW_CHAT_DRAFT).text).toBe("");
		expect(store.takeAutoSend(session.id)).toBe(false);
		expect(store.getState().toasts.at(-1)).toMatchObject({
			level: "error",
			message: "设置会话选项失败：Fast mode unavailable",
		});
	});

	it("preserves host defaults when Fast has not been chosen", async () => {
		const { store, request } = setup();
		await store.sendNewChat(draft);
		expect(request.mock.calls.map(([method]) => method)).toEqual(["session.create"]);
		expect(store.takeAutoSend(session.id)).toBe(true);
	});

	it.each(["pi", "claude-code"] as const)("does not apply Codex Fast to %s", async (runtime) => {
		const { store, request } = setup(LOCAL_NODE, runtime);
		store.setNewChatModel("workspace", { fastMode: true });
		await store.sendNewChat(draft);
		expect(request.mock.calls.map(([method]) => method)).toEqual(["session.create"]);
	});

	it("keeps the submitted choices if the selected agent changes while creating the session", async () => {
		const { store, request } = setup();
		const created = Promise.withResolvers<{ session: SessionSummary }>();
		request.mockImplementationOnce(() => created.promise);
		store.setNewChatModel("workspace", { fastMode: true, thinkingLevel: "xhigh" });
		const sending = store.sendNewChat(draft);
		store.setNewChatRuntime("workspace", "pi");
		expect(store.getState().newChatModel[LOCAL_NODE]).toBeUndefined();
		created.resolve({ session });
		await sending;
		expect(request.mock.calls).toEqual([
			["session.create", { workspaceId: "workspace", runtime: "codex" }],
			["thinking.set", { sessionId: session.id, level: "xhigh" }],
			["fast.set", { sessionId: session.id, enabled: true }],
		]);
	});
});
