import {
	type ChatController,
	type CommandList,
	filterOptions,
	loadArgumentOptions,
	pickCommand,
	type SlashCommand,
	type SlashOption,
	slashMenu,
} from "@pier/chat-state";
import { useEffect, useRef, useState } from "react";

const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
	builtin: "内置",
	extension: "扩展",
	prompt: "模板",
	skill: "Skill",
};

interface Entry {
	key: string;
	name: string;
	hint?: string;
	description?: string;
	badge?: string;
	selected?: boolean;
	/** `run`: submit `text` now; otherwise put it into the composer. */
	pick(tab: boolean): { text: string; run: boolean };
}

export interface SlashMenuModel {
	open: boolean;
	/** Latest command list, for resolving what the user submits. */
	list: CommandList;
	entries: Entry[];
	active: number;
	status?: string;
	setActive(index: number): void;
	move(delta: number): void;
	dismiss(): void;
}

function commandEntry(command: SlashCommand): Entry {
	return {
		key: `${command.source}:${command.name}`,
		name: `/${command.name}`,
		...(command.argumentHint ? { hint: command.argumentHint } : {}),
		...(command.description ? { description: command.description } : {}),
		badge: SOURCE_LABEL[command.source],
		pick: (tab) => pickCommand(command, !tab),
	};
}

function optionEntry(command: string, option: SlashOption): Entry {
	return {
		key: option.value,
		name: option.label,
		...(option.detail && option.detail !== option.label ? { description: option.detail } : {}),
		...(option.selected ? { selected: true } : {}),
		pick: (tab) => ({ text: `/${command} ${option.value}`, run: !tab }),
	};
}

/** Slash-command menu state for the composer text. */
export function useSlashMenu(controller: ChatController, text: string): SlashMenuModel {
	const [list, setList] = useState<CommandList>(() => controller.commands);
	const [dismissedFor, setDismissedFor] = useState<string | undefined>();
	const [active, setActive] = useState(0);
	const [args, setArgs] = useState<{ command: string; options?: SlashOption[]; error?: string }>();
	const slashing = text.startsWith("/");
	const sessionId = controller.sessionId;
	const runtime = controller.chat.session?.runtime;
	const capabilities = controller.chat.capabilities;

	// Refresh the host's commands every time the menu opens (extensions may add commands).
	// biome-ignore lint/correctness/useExhaustiveDependencies: session metadata can change on the same controller.
	useEffect(() => {
		setList(controller.commands);
		if (!slashing) return;
		let alive = true;
		void controller.loadCommands().then((next) => {
			if (alive) setList(next);
		});
		return () => {
			alive = false;
		};
	}, [slashing, controller, sessionId, runtime, capabilities]);

	const state = dismissedFor === text ? undefined : slashMenu(text, list.commands);
	const argCommand = state?.kind === "arguments" ? state.command : undefined;

	useEffect(() => {
		if (!argCommand) {
			setArgs(undefined);
			return;
		}
		let alive = true;
		setArgs({ command: argCommand });
		loadArgumentOptions(controller, argCommand)
			.then((options) => {
				if (alive) setArgs({ command: argCommand, options });
			})
			.catch((error: unknown) => {
				if (alive) setArgs({ command: argCommand, error: error instanceof Error ? error.message : String(error) });
			});
		return () => {
			alive = false;
		};
	}, [argCommand, controller]);

	let entries: Entry[] = [];
	let status: string | undefined;
	if (state?.kind === "commands") {
		entries = state.items.map(commandEntry);
		if (!entries.length) status = "没有匹配的命令";
	} else if (state?.kind === "arguments") {
		const loaded = args?.command === state.command ? args : undefined;
		if (loaded?.error) status = `加载失败：${loaded.error}`;
		else if (!loaded?.options) status = "加载中…";
		else {
			entries = filterOptions(loaded.options, state.query).map((o) => optionEntry(state.command, o));
			if (!entries.length) {
				status = state.command === "fork" && !loaded.options.length ? "还没有可以分叉的消息" : "没有匹配的选项";
			}
		}
	}

	const queryKey = state ? (state.kind === "commands" ? `c:${state.query}` : `a:${state.command}:${state.query}`) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight when the query changes.
	useEffect(() => setActive(0), [queryKey]);

	const count = entries.length;
	return {
		open: state !== undefined,
		list,
		entries,
		active: Math.min(active, Math.max(count - 1, 0)),
		...(status ? { status } : {}),
		setActive,
		move: (delta) => {
			if (count) setActive((i) => (Math.min(i, count - 1) + delta + count) % count);
		},
		dismiss: () => setDismissedFor(text),
	};
}

export function SlashMenu({ menu, onPick }: { menu: SlashMenuModel; onPick: (entry: Entry) => void }) {
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${menu.active}"]`);
		item?.scrollIntoView({ block: "nearest" });
	}, [menu.active]);
	if (!menu.open) return null;
	return (
		<div className="slash-menu" ref={listRef} role="listbox" aria-label="命令">
			{menu.entries.map((entry, index) => (
				<button
					type="button"
					role="option"
					aria-selected={index === menu.active}
					key={entry.key}
					data-index={index}
					className={`slash-item${index === menu.active ? " active" : ""}`}
					// Keep the focus in the textarea.
					onMouseDown={(e) => e.preventDefault()}
					onMouseEnter={() => menu.setActive(index)}
					onClick={() => onPick(entry)}
				>
					<span className="slash-item-main">
						<span className="slash-item-name">{entry.name}</span>
						{entry.hint ? <span className="slash-item-hint">{entry.hint}</span> : null}
						{entry.selected ? <span className="mini-tag">当前</span> : null}
					</span>
					{entry.description ? <span className="slash-item-desc">{entry.description}</span> : null}
					{entry.badge ? <span className="slash-item-badge">{entry.badge}</span> : null}
				</button>
			))}
			{menu.status ? <div className="slash-status">{menu.status}</div> : null}
			<div className="slash-footer">↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭</div>
		</div>
	);
}

export type { Entry as SlashMenuEntry };
