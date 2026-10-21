import type { AgentRuntimeInfo } from "@pier/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNewChatSlashMenu } from "../src/components/NewChatSlashMenu.ts";
import { SlashMenu } from "../src/components/SlashMenu.tsx";
import type { AppState } from "../src/lib/store.tsx";

const { state, listModels } = vi.hoisted(() => ({
	state: {
		workspaceNodes: { workspace: "peer" },
		newChatRuntime: {} as Record<string, string>,
		newChatModel: {},
	},
	listModels: vi.fn(),
}));

vi.mock("../src/lib/store.tsx", () => ({
	LOCAL_NODE: "local",
	useStore: () => ({ listModels }),
	useAppState: (selector: (value: AppState) => unknown) => selector(state as unknown as AppState),
}));

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

function Menu({ text, workspaceId, runtimes }: { text: string; workspaceId?: string; runtimes?: AgentRuntimeInfo[] }) {
	const menu = useNewChatSlashMenu(workspaceId, text, runtimes);
	return createElement(SlashMenu, { menu, onPick: () => {} });
}

function render(text: string, workspaceId: string | undefined = "workspace", runtimes?: AgentRuntimeInfo[]) {
	return renderToStaticMarkup(createElement(Menu, { text, runtimes, ...(workspaceId ? { workspaceId } : {}) }));
}

beforeEach(() => {
	state.newChatRuntime = {};
	listModels.mockReset();
});

describe("new-chat slash menu", () => {
	it("opens on / before a session exists without loading or creating a session", () => {
		const html = render("/");
		expect(html).toContain('role="listbox"');
		expect(html).toContain("/model");
		expect(html).toContain("/thinking");
		expect(html).not.toContain("/compact");
		expect(html).not.toContain("/fork");
		expect(listModels).not.toHaveBeenCalled();
	});

	it("uses the workspace computer's selected agent and filters the query", () => {
		state.newChatRuntime = { local: "pi", peer: "codex" };
		const html = render("/");
		expect(html).toContain("/clear");
		expect(html).toContain("/reasoning");
		expect(html).not.toContain("/thinking");
		expect(html).not.toContain("/reload");
		expect(render("/rea")).toContain("/reasoning");
		expect(render("/rea")).not.toContain("/model");
		state.newChatRuntime.peer = "claude-code";
		expect(render("/")).toContain("/effort");
		expect(render("/")).not.toContain("/reasoning");
	});

	it("shows argument loading and asks for a workspace when none is selected", () => {
		expect(render("/model ")).toContain("加载中");
		const html = render("/", "");
		expect(html).toContain("请先选择一个工作区");
		expect(html).not.toContain('role="option"');
	});

	it("offers Fast before creating a session when the selected computer advertises it", () => {
		state.newChatRuntime = { local: "pi", peer: "codex" };
		const html = render("/fast", "workspace", [codex]);
		expect(html).toContain("/fast");
		expect(html).toContain("切换 Fast 模式");
		expect(html).not.toContain("没有匹配的命令");
		expect(render("/fast ", "workspace", [codex])).toContain("加载中");
		const all = render("/", "workspace", [codex]);
		expect(all).not.toContain("/compact");
		expect(all).not.toContain("/fork");
		expect(listModels).not.toHaveBeenCalled();
	});

	it("hides Fast while capabilities are unknown or the computer does not support it", () => {
		state.newChatRuntime = { peer: "codex" };
		for (const runtimes of [
			undefined,
			[],
			[{ ...codex, available: false }],
			[{ ...codex, capabilities: { ...codex.capabilities, fastMode: undefined } }],
			[{ ...codex, capabilities: { ...codex.capabilities, fastMode: false } }],
		]) {
			expect(render("/fast", "workspace", runtimes)).toContain("没有匹配的命令");
		}
	});

	it("does not reuse Codex capabilities for another selected agent or without a workspace", () => {
		for (const runtime of ["pi", "claude-code"]) {
			state.newChatRuntime = { peer: runtime };
			expect(render("/fast", "workspace", [codex])).toContain("没有匹配的命令");
		}
		state.newChatRuntime = { local: "codex" };
		expect(render("/fast", "", [codex])).toContain("请先选择一个工作区");
	});

	it("keeps ordinary messages, paths and multiline prompts out of the menu", () => {
		for (const text of ["", "hello", "/usr/bin", "/model\nhello"]) expect(render(text)).toBe("");
	});
});
