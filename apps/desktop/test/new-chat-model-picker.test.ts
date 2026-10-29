import type { AgentRuntimeInfo, WorkspaceInfo } from "@pier/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatModelPicker } from "../src/components/ModelPicker.tsx";
import type { AppState } from "../src/lib/store.tsx";

const { state, store } = vi.hoisted(() => ({
	state: {
		workspaceNodes: { workspace: "peer" },
		nodes: { peer: { connection: "open" } },
		newChatRuntime: { local: "pi", peer: "codex" },
		newChatModel: { peer: { fastMode: false } },
	},
	store: { listModels: vi.fn(), setNewChatModel: vi.fn() },
}));

vi.mock("../src/lib/store.tsx", () => ({
	LOCAL_NODE: "local",
	useStore: () => store,
	useAppState: (selector: (value: AppState) => unknown) => selector(state as unknown as AppState),
}));

const workspace: WorkspaceInfo = { id: "workspace", name: "Workspace", path: "/workspace", policy: "ask" };
const codex: AgentRuntimeInfo = {
	id: "codex",
	name: "Codex",
	available: true,
	capabilities: {
		steer: true,
		followUp: true,
		compact: true,
		fork: true,
		rename: true,
		setModel: true,
		thinking: true,
		fastMode: true,
		reload: false,
		images: true,
		piExtensions: false,
	},
};
const render = (runtimes: AgentRuntimeInfo[]) =>
	renderToStaticMarkup(createElement(NewChatModelPicker, { workspace, runtimes }));

beforeEach(() => {
	state.newChatRuntime.peer = "codex";
	state.newChatModel.peer.fastMode = false;
});

describe("new-chat model picker", () => {
	it("exposes Fast controls before a session exists when the workspace's computer supports them", () => {
		expect(render([codex])).toContain('title="切换模型、思考程度与 Fast 模式"');
		expect(render([codex])).not.toContain('title="Fast 模式已开启"');
		state.newChatModel.peer.fastMode = true;
		expect(render([codex])).toContain('title="Fast 模式已开启"');
	});

	it("hides Fast while capabilities are unknown, unavailable or unsupported", () => {
		state.newChatModel.peer.fastMode = true;
		for (const runtimes of [
			[],
			[{ ...codex, available: false }],
			[{ ...codex, capabilities: { ...codex.capabilities, fastMode: undefined } }],
			[{ ...codex, capabilities: { ...codex.capabilities, fastMode: false } }],
		]) {
			expect(render(runtimes)).not.toContain("Fast");
		}
	});

	it.each(["pi", "claude-code"])("does not reuse Codex controls when %s is selected", (runtime) => {
		state.newChatRuntime.peer = runtime;
		state.newChatModel.peer.fastMode = true;
		expect(render([codex])).not.toContain("Fast");
	});
});
