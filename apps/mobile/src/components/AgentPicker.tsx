import type { AgentRuntimeId, AgentRuntimeInfo } from "@pier/protocol";
import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RADIUS, usePalette } from "../theme.ts";
import { Avatar, Button, Muted } from "./ui.tsx";

function agentDescription(id: AgentRuntimeId): string {
	switch (id) {
		case "pi":
			return "Pier 内置，使用在 Pier 中配置的模型与扩展";
		case "claude-code":
			return "电脑上的 Claude Code，使用它自己的登录与配置";
		case "codex":
			return "电脑上的 Codex，使用它自己的登录与配置";
		default:
			return "";
	}
}

/** Bottom sheet for choosing which agent runtime a new session uses. */
export function AgentPicker({
	runtimes,
	workspaceName,
	onPick,
	onClose,
}: {
	runtimes: AgentRuntimeInfo[];
	workspaceName?: string;
	/** Resolves once the session was created (or failed). */
	onPick: (runtime: AgentRuntimeId) => Promise<void>;
	onClose: () => void;
}) {
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const [creating, setCreating] = useState<AgentRuntimeId>();
	const close = () => {
		if (!creating) onClose();
	};
	return (
		<Modal transparent animationType="slide" onRequestClose={close}>
			<Pressable style={styles.backdrop} onPress={close} />
			<View style={[styles.sheet, { backgroundColor: p.card, paddingBottom: insets.bottom + 16 }]}>
				<View style={[styles.grabber, { backgroundColor: p.border }]} />
				<ScrollView contentContainerStyle={styles.content}>
					<View style={styles.head}>
						<Text style={[styles.title, { color: p.text }]}>由哪个 Agent 来做？</Text>
						{workspaceName ? <Muted>在“{workspaceName}”中新建会话</Muted> : null}
					</View>
					<View style={styles.options}>
						{runtimes.map((r) => {
							const busy = creating === r.id;
							return (
								<Pressable
									key={r.id}
									testID={`agent-${r.id}`}
									accessibilityRole="button"
									accessibilityLabel={r.name}
									disabled={creating !== undefined}
									style={({ pressed }) => [
										styles.option,
										{ backgroundColor: pressed || busy ? p.accentSoft : p.bg, borderColor: busy ? p.accent : p.border },
										creating !== undefined && !busy && styles.dimmed,
									]}
									onPress={async () => {
										setCreating(r.id);
										try {
											await onPick(r.id);
										} finally {
											setCreating(undefined);
										}
									}}
								>
									<Avatar name={r.name} size={40} />
									<View style={styles.flex}>
										<View style={styles.nameRow}>
											<Text style={[styles.name, { color: p.text }]} numberOfLines={1}>
												{r.name}
											</Text>
											{r.version ? (
												<Text style={[styles.tag, { color: p.muted, borderColor: p.border }]} numberOfLines={1}>
													{r.version}
												</Text>
											) : null}
										</View>
										{agentDescription(r.id) ? <Muted>{agentDescription(r.id)}</Muted> : null}
									</View>
									{busy ? (
										<ActivityIndicator size="small" color={p.accent} />
									) : (
										<Text style={[styles.chevron, { color: p.faint }]}>›</Text>
									)}
								</Pressable>
							);
						})}
					</View>
					<Button title="取消" variant="secondary" disabled={creating !== undefined} onPress={close} />
				</ScrollView>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1, gap: 3 },
	backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
	sheet: { maxHeight: "78%", borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl },
	grabber: { alignSelf: "center", width: 38, height: 5, borderRadius: 3, marginTop: 8 },
	content: { padding: 18, paddingTop: 14, gap: 16 },
	head: { gap: 4, paddingHorizontal: 2 },
	title: { fontSize: 19, fontWeight: "700" },
	options: { gap: 10 },
	option: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 14,
		paddingVertical: 13,
		borderRadius: RADIUS.lg,
		borderWidth: StyleSheet.hairlineWidth,
	},
	dimmed: { opacity: 0.5 },
	nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
	name: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
	tag: {
		fontSize: 10.5,
		fontWeight: "600",
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: RADIUS.sm,
		paddingHorizontal: 5,
		paddingVertical: 1,
		maxWidth: 120,
	},
	chevron: { fontSize: 22, marginTop: -2 },
});
