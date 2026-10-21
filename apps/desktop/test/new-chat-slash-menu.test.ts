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

function Menu({ text, workspaceId }: { text: string; workspaceId?: string }) {
	const menu = useNewChatSlashMenu(workspaceId, text);
	return createElement(SlashMenu, { menu, onPick: () => {} });
}

function render(text: string, workspaceId: string | undefined = "workspace") {
	return renderToStaticMarkup(createElement(Menu, { text, ...(workspaceId ? { workspaceId } : {}) }));
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

	it("keeps ordinary messages, paths and multiline prompts out of the menu", () => {
		for (const text of ["", "hello", "/usr/bin", "/model\nhello"]) expect(render(text)).toBe("");
	});
});
