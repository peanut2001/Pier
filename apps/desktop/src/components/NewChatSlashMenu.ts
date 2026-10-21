import { builtinCommands, type CommandList, loadArgumentOptions } from "@pier/chat-state";
import { useCallback, useMemo } from "react";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { useSlashMenuState } from "./SlashMenu.tsx";

/** Commands available before a session exists; host commands load in the session composer. */
export function useNewChatSlashMenu(workspaceId: string | undefined, text: string) {
	const store = useStore();
	const node = useAppState((s) => (workspaceId ? s.workspaceNodes[workspaceId] : undefined) ?? LOCAL_NODE);
	const runtime = useAppState((s) => s.newChatRuntime[node] ?? "pi");
	const choice = useAppState((s) => s.newChatModel[node]);
	const list = useMemo<CommandList>(
		() => ({
			// There is no history to compact or fork on the new-chat screen.
			commands: workspaceId
				? builtinCommands(undefined, runtime).filter((command) => command.name !== "compact" && command.name !== "fork")
				: [],
			known: false,
		}),
		[workspaceId, runtime],
	);
	const loadOptions = useCallback(
		async (command: string) => {
			if (!workspaceId) return [];
			const result = await store.listModels(workspaceId, runtime);
			return loadArgumentOptions(
				{
					chat: {
						model: choice?.model ?? result.current,
						thinkingLevel: choice?.thinkingLevel ?? result.thinkingLevel ?? "medium",
						runState: "idle",
					},
					listModels: async () => result,
					forkPoints: async () => ({ points: [] }),
				},
				command,
			);
		},
		[store, workspaceId, runtime, choice],
	);
	const menu = useSlashMenuState(text, list, loadOptions);
	return {
		...menu,
		status: workspaceId ? (menu.status ?? "创建会话后可使用更多命令") : "请先选择一个工作区",
	};
}
