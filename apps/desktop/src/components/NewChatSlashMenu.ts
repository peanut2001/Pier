import { builtinCommands, type CommandList, loadArgumentOptions } from "@pier/chat-state";
import type { AgentRuntimeInfo } from "@pier/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { useSlashMenuState } from "./SlashMenu.tsx";

const NO_RUNTIMES: AgentRuntimeInfo[] = [];

/** Share the selected computer's runtime catalog between the agent picker and slash menu. */
export function useNewChatRuntimes(workspaceId: string | undefined): AgentRuntimeInfo[] {
	const store = useStore();
	const node = useAppState((s) => (workspaceId ? s.workspaceNodes[workspaceId] : undefined) ?? LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const hostInfo = useAppState((s) => s.nodes[node]?.hostInfo);
	const installationVersion = useAppState((s) => s.agentConfigVersion);
	const request = useMemo(
		() => ({ workspaceId, online, hostInfo, installationVersion }),
		[workspaceId, online, hostInfo, installationVersion],
	);
	const [catalog, setCatalog] = useState<{ request: typeof request; runtimes: AgentRuntimeInfo[] }>();

	useEffect(() => {
		if (!request.workspaceId || !request.online) return;
		let live = true;
		store
			.listRuntimes(request.workspaceId)
			.then((runtimes) => {
				if (live) setCatalog({ request, runtimes });
			})
			.catch(() => {
				if (live) setCatalog({ request, runtimes: NO_RUNTIMES });
			});
		return () => {
			live = false;
		};
	}, [store, request]);

	// Never offer another computer's capabilities while its replacement is loading.
	return catalog?.request === request ? catalog.runtimes : NO_RUNTIMES;
}

/** Commands available before a session exists; host commands load in the session composer. */
export function useNewChatSlashMenu(
	workspaceId: string | undefined,
	text: string,
	runtimes: readonly AgentRuntimeInfo[] = NO_RUNTIMES,
) {
	const store = useStore();
	const node = useAppState((s) => (workspaceId ? s.workspaceNodes[workspaceId] : undefined) ?? LOCAL_NODE);
	const runtime = useAppState((s) => s.newChatRuntime[node] ?? "pi");
	const choice = useAppState((s) => s.newChatModel[node]);
	const capabilities = runtimes.find((entry) => entry.id === runtime && entry.available)?.capabilities;
	const list = useMemo<CommandList>(
		() => ({
			// There is no history to compact or fork on the new-chat screen.
			commands: workspaceId
				? builtinCommands(capabilities, runtime).filter(
						(command) => command.name !== "compact" && command.name !== "fork",
					)
				: [],
			known: false,
		}),
		[workspaceId, runtime, capabilities],
	);
	const loadOptions = useCallback(
		async (command: string) => {
			if (!workspaceId) return [];
			const result = command === "fast" ? undefined : await store.listModels(workspaceId, runtime);
			return loadArgumentOptions(
				{
					chat: {
						model: choice?.model ?? result?.current,
						thinkingLevel: choice?.thinkingLevel ?? result?.thinkingLevel ?? "medium",
						runState: "idle",
					},
					listModels: async () => result ?? { models: [] },
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
