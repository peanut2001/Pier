import type { PierClient } from "@pier/client";
import type { AgentRuntimeCapabilities, EventFrame, SessionCommandInfo, SessionSummary } from "@pier/protocol";
import { describe, expect, it, vi } from "vitest";
import { ChatController } from "../src/index.ts";

const session: SessionSummary = {
	id: "s1",
	workspaceId: "w1",
	cwd: "/tmp/w",
	createdAt: "2026-01-01T00:00:00.000Z",
	modifiedAt: "2026-01-01T00:00:00.000Z",
	messageCount: 0,
	firstMessage: "",
	active: true,
	state: "idle",
	runtime: "codex",
};

const capabilities: AgentRuntimeCapabilities = {
	steer: true,
	followUp: true,
	compact: true,
	fork: true,
	rename: true,
	setModel: true,
	thinking: true,
	reload: false,
	images: true,
	piExtensions: false,
};

function setup(initial = session) {
	const request = vi.fn().mockResolvedValue({ commands: [] });
	let receive!: (frame: EventFrame) => void;
	const client = {
		request,
		subscribe: async (_id: string, handler: typeof receive) => {
			receive = handler;
			return { unsubscribe: async () => {} };
		},
	} as unknown as PierClient;
	const controller = new ChatController(client, initial, {
		onChange: vi.fn(),
		onReplaced: vi.fn(),
		onSettled: vi.fn(),
		onError: vi.fn(),
	});
	return {
		controller,
		request,
		emit: (event: EventFrame["event"]) => receive({ type: "evt", sessionId: controller.sessionId, event }),
	};
}

describe("session command catalogs", () => {
	it("uses the session's agent before the host has returned a command list or snapshot", () => {
		const { controller } = setup();
		expect(controller.commands.commands.map((c) => c.name)).toContain("clear");
		expect(controller.commands.commands.map((c) => c.name)).toContain("reasoning");
		expect(controller.commands.commands.map((c) => c.name)).not.toContain("thinking");
		expect(controller.commands.commands.map((c) => c.name)).not.toContain("reload");
	});

	it("retains the agent's built-ins when command discovery fails on an older host", async () => {
		const { controller, request } = setup({ ...session, runtime: "claude-code" });
		request.mockRejectedValueOnce(new Error("Unknown method"));
		const list = await controller.loadCommands();
		expect(list.known).toBe(false);
		expect(list.commands.map((c) => c.name)).toContain("clear");
		expect(list.commands.map((c) => c.name)).toContain("effort");
		expect(list.commands.map((c) => c.name)).not.toContain("new");
	});

	it("applies capabilities from a late snapshot without losing the host's commands", async () => {
		const { controller, request, emit } = setup();
		await controller.start();
		request.mockResolvedValueOnce({ commands: [{ name: "review", source: "prompt" }] });
		await controller.loadCommands();
		emit({
			type: "session.snapshot",
			snapshot: {
				session,
				seq: 1,
				epoch: "epoch",
				messages: [],
				pendingToolCalls: [],
				pendingUi: [],
				queue: { steering: [], followUp: [] },
				thinkingLevel: "medium",
				statuses: {},
				widgets: {},
				capabilities: { ...capabilities, thinking: false },
			},
		});
		expect(controller.commands.known).toBe(true);
		expect(controller.commands.commands.map((c) => c.name)).toContain("review");
		expect(controller.commands.commands.map((c) => c.name)).not.toContain("reasoning");
	});

	it("does not reuse or apply an in-flight list after the session is replaced", async () => {
		const { controller, request, emit } = setup();
		await controller.start();
		let finish!: (result: { commands: SessionCommandInfo[] }) => void;
		request.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const old = controller.loadCommands();
		emit({ type: "session.replaced", session: { ...session, id: "s2", runtime: "claude-code" } });
		request.mockResolvedValueOnce({ commands: [{ name: "claude-only", source: "prompt" }] });
		const next = await controller.loadCommands();
		expect(request).toHaveBeenLastCalledWith("session.commands", { sessionId: "s2" });
		expect(next.commands.map((c) => c.name)).toContain("effort");
		finish({ commands: [{ name: "codex-only", source: "prompt" }] });
		await old;
		expect(controller.commands.commands.map((c) => c.name)).toContain("claude-only");
		expect(controller.commands.commands.map((c) => c.name)).not.toContain("codex-only");
	});
});
