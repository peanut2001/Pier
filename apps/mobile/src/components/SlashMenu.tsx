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
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { FLOAT_SHADOW, usePalette } from "../theme.ts";

const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
	builtin: "内置",
	extension: "扩展",
	prompt: "模板",
	skill: "Skill",
};

export interface SlashEntry {
	key: string;
	name: string;
	hint?: string;
	description?: string;
	badge?: string;
	selected?: boolean;
	/** `run`: submit `text` now; otherwise put it into the composer. */
	pick(): { text: string; run: boolean };
}

export interface SlashMenuModel {
	open: boolean;
	list: CommandList;
	entries: SlashEntry[];
	status?: string;
}

/** Slash-command menu state for the composer text (shared logic lives in @pier/chat-state). */
export function useSlashMenu(controller: ChatController, text: string): SlashMenuModel {
	const [list, setList] = useState<CommandList>(() => controller.commands);
	const [args, setArgs] = useState<{ command: string; options?: SlashOption[]; error?: string }>();
	const slashing = text.startsWith("/");

	useEffect(() => {
		if (!slashing) return;
		let alive = true;
		void controller.loadCommands().then((next) => {
			if (alive) setList(next);
		});
		return () => {
			alive = false;
		};
	}, [slashing, controller]);

	const state = slashMenu(text, list.commands);
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

	let entries: SlashEntry[] = [];
	let status: string | undefined;
	if (state?.kind === "commands") {
		entries = state.items.map((command) => ({
			key: `${command.source}:${command.name}`,
			name: `/${command.name}`,
			...(command.argumentHint ? { hint: command.argumentHint } : {}),
			...(command.description ? { description: command.description } : {}),
			badge: SOURCE_LABEL[command.source],
			pick: () => pickCommand(command),
		}));
		if (!entries.length) status = "没有匹配的命令";
	} else if (state?.kind === "arguments") {
		const loaded = args?.command === state.command ? args : undefined;
		if (loaded?.error) status = `加载失败：${loaded.error}`;
		else if (!loaded?.options) status = "加载中…";
		else {
			const command = state.command;
			entries = filterOptions(loaded.options, state.query).map((option) => ({
				key: option.value,
				name: option.label,
				...(option.detail && option.detail !== option.label ? { description: option.detail } : {}),
				...(option.selected ? { selected: true } : {}),
				pick: () => ({ text: `/${command} ${option.value}`, run: true }),
			}));
			if (!entries.length) {
				status = command === "fork" && !loaded.options.length ? "还没有可以分叉的消息" : "没有匹配的选项";
			}
		}
	}
	return { open: state !== undefined, list, entries, ...(status ? { status } : {}) };
}

export function SlashMenu({ menu, onPick }: { menu: SlashMenuModel; onPick: (entry: SlashEntry) => void }) {
	const p = usePalette();
	if (!menu.open) return null;
	return (
		<View style={[styles.root, FLOAT_SHADOW, { borderColor: p.border, backgroundColor: p.card }]}>
			<ScrollView keyboardShouldPersistTaps="always" style={styles.list}>
				{menu.entries.map((entry) => (
					<Pressable
						key={entry.key}
						onPress={() => onPick(entry)}
						style={({ pressed }) => [styles.item, pressed ? { backgroundColor: p.accentSoft } : null]}
						accessibilityRole="button"
						accessibilityLabel={entry.name}
					>
						<View style={styles.itemHead}>
							<Text style={[styles.name, { color: p.text }]} numberOfLines={1}>
								{entry.name}
								{entry.hint ? <Text style={{ color: p.faint }}> {entry.hint}</Text> : null}
							</Text>
							{entry.selected ? (
								<Text style={[styles.badge, { color: p.accent, backgroundColor: p.accentSoft }]}>当前</Text>
							) : null}
							{entry.badge ? (
								<Text style={[styles.badge, { color: p.muted, backgroundColor: p.elevated }]}>{entry.badge}</Text>
							) : null}
						</View>
						{entry.description ? (
							<Text style={[styles.description, { color: p.muted }]} numberOfLines={1}>
								{entry.description}
							</Text>
						) : null}
					</Pressable>
				))}
				{menu.status ? <Text style={[styles.status, { color: p.muted }]}>{menu.status}</Text> : null}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, overflow: "hidden" },
	list: { maxHeight: 260 },
	item: { paddingHorizontal: 14, paddingVertical: 10, gap: 3 },
	itemHead: { flexDirection: "row", alignItems: "center", gap: 8 },
	name: { flex: 1, fontSize: 14, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
	badge: {
		fontSize: 10.5,
		fontWeight: "600",
		paddingHorizontal: 6,
		paddingVertical: 1,
		borderRadius: 6,
		overflow: "hidden",
	},
	description: { fontSize: 12 },
	status: { padding: 12, fontSize: 13 },
});
