import type { ApprovalPolicy } from "@pier/protocol";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
	Avatar,
	Button,
	Card,
	confirmDestructive,
	Icon,
	type IconName,
	Muted,
	Screen,
	SectionLabel,
	Title,
} from "../../../../src/components/ui.tsx";
import { isBusy, POLICY_DESCRIPTION, POLICY_LABEL, shortPath } from "../../../../src/format.ts";
import { useMobileState, useStore } from "../../../../src/store.ts";
import { MONO, RADIUS, usePalette } from "../../../../src/theme.ts";

const POLICIES: ApprovalPolicy[] = ["ask", "smart", "auto"];

const POLICY_ICON: Record<ApprovalPolicy, IconName> = {
	ask: "hand-left-outline",
	smart: "shield-checkmark-outline",
	auto: "flash-outline",
};

/** Settings of one workspace on the connected computer: approval policy and removal. */
export default function WorkspaceSettings() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const { hostId, workspaceId } = useLocalSearchParams<{ hostId: string; workspaceId: string }>();
	const view = useMobileState((s) => s.host);
	const hostName = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId)?.hostName ?? "电脑");
	const workspace = view.hostId === hostId ? view.workspaces?.find((w) => w.id === workspaceId) : undefined;
	const sessions = view.sessions[workspaceId] ?? [];
	const online = view.hostId === hostId && view.connection === "open";
	const canManage = online && store.canManageWorkspaces();
	const [saving, setSaving] = useState<ApprovalPolicy>();
	const [removing, setRemoving] = useState(false);

	if (!workspace) {
		return (
			<Screen style={styles.center}>
				<Stack.Screen options={{ title: "工作区" }} />
				{view.workspaces && view.hostId === hostId ? (
					<Muted>这个工作区已经不存在</Muted>
				) : (
					<ActivityIndicator color={p.accent} />
				)}
			</Screen>
		);
	}

	const archived = sessions.filter((s) => s.archived).length;
	const running = sessions.filter((s) => isBusy(s.state)).length;

	const choose = async (policy: ApprovalPolicy) => {
		if (policy === workspace.policy || saving) return;
		setSaving(policy);
		await store.setWorkspacePolicy(workspace.id, policy);
		setSaving(undefined);
	};

	const remove = () =>
		confirmDestructive(
			`移除工作区“${workspace.name}”？`,
			`只会从 ${hostName} 上的 Pier 中移除，目录中的文件和会话记录都不会删除，之后重新添加这个目录即可恢复。${
				running ? `\n\n有 ${running} 个会话正在运行，会先中止。` : ""
			}`,
			"移除",
			async () => {
				setRemoving(true);
				const removed = await store.removeWorkspace(workspace.id);
				setRemoving(false);
				if (!removed) return;
				store.toast("info", `已移除工作区「${workspace.name}」`);
				router.back();
			},
		);

	return (
		<Screen>
			<Stack.Screen options={{ title: "工作区设置" }} />
			<ScrollView contentContainerStyle={styles.content}>
				<Card flat style={styles.summary}>
					<View style={styles.row}>
						<Avatar name={workspace.name} size={48} icon="folder-open" />
						<View style={styles.flex}>
							<Title numberOfLines={1}>{workspace.name}</Title>
							<Muted>
								{hostName} · {sessions.length - archived} 个会话{archived ? ` · ${archived} 个已归档` : ""}
							</Muted>
						</View>
					</View>
					<Pressable
						testID="workspace-path"
						onLongPress={async () => {
							await Clipboard.setStringAsync(workspace.path);
							store.toast("info", "已复制路径");
						}}
						style={[styles.pathBox, { backgroundColor: p.elevated }]}
					>
						<Icon name="folder-outline" size={15} color={p.muted} />
						<Text selectable style={[styles.path, { color: p.text }]}>
							{shortPath(workspace.path)}
						</Text>
						<Icon name="copy-outline" size={14} color={p.faint} />
					</Pressable>
				</Card>

				<SectionLabel style={styles.label}>工具审批策略</SectionLabel>
				<Card flat style={styles.options}>
					{POLICIES.map((policy, index) => {
						const selected = workspace.policy === policy;
						return (
							<Pressable
								key={policy}
								testID={`policy-${policy}`}
								accessibilityRole="radio"
								accessibilityState={{ selected, disabled: !canManage }}
								disabled={!canManage || !!saving}
								onPress={() => void choose(policy)}
								style={({ pressed }) => [
									styles.option,
									index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
									pressed && { backgroundColor: p.elevated },
								]}
							>
								<View
									style={[
										styles.policyIcon,
										{
											backgroundColor: selected ? (policy === "auto" ? p.warningSoft : p.accentSoft) : p.elevated,
										},
									]}
								>
									<Icon
										name={POLICY_ICON[policy]}
										size={18}
										color={selected ? (policy === "auto" ? p.warning : p.accent) : p.muted}
									/>
								</View>
								<View style={styles.flex}>
									<Text style={[styles.optionTitle, { color: p.text }]}>
										{POLICY_LABEL[policy]}
										{policy === "smart" ? <Text style={{ color: p.muted, fontWeight: "400" }}>（默认）</Text> : null}
									</Text>
									<Text style={[styles.optionText, { color: policy === "auto" ? p.warning : p.muted }]}>
										{POLICY_DESCRIPTION[policy]}
									</Text>
								</View>
								{saving === policy ? (
									<ActivityIndicator size="small" color={p.accent} />
								) : selected ? (
									<Icon name="checkmark-circle" size={22} color={policy === "auto" ? p.warning : p.accent} />
								) : (
									<View style={[styles.radio, { borderColor: p.border }]} />
								)}
							</Pressable>
						);
					})}
				</Card>
				<Muted style={styles.note}>
					危险命令（rm -r、sudo、git push --force 等）在“逐项审批”和“智能”策略下总是需要批准。
				</Muted>

				<Button
					title="从 Pier 移除工作区"
					icon="trash-outline"
					variant="danger"
					loading={removing}
					disabled={!canManage}
					onPress={remove}
					style={styles.remove}
					testID="workspace-remove"
				/>
				{!online ? (
					<Muted style={styles.note}>连接到电脑后才能修改。</Muted>
				) : !canManage ? (
					<Muted style={styles.note}>这台电脑上的 Pier 版本较旧，请先升级，或在电脑上管理工作区。</Muted>
				) : (
					<Muted style={styles.note}>不会删除目录中的文件和会话记录。</Muted>
				)}
			</ScrollView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	center: { alignItems: "center", justifyContent: "center" },
	content: { padding: 16, paddingBottom: 48 },
	summary: { gap: 14 },
	row: { flexDirection: "row", alignItems: "center", gap: 12 },
	pathBox: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		borderRadius: RADIUS.md,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	path: { flex: 1, fontSize: 12.5, fontFamily: MONO, lineHeight: 18 },
	policyIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
	label: { marginTop: 22, marginBottom: 8, marginLeft: 4 },
	options: { padding: 0, overflow: "hidden" },
	option: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 14 },
	radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2 },
	optionTitle: { fontSize: 15.5, fontWeight: "600" },
	optionText: { fontSize: 13, lineHeight: 19, marginTop: 3 },
	note: { marginTop: 10, marginHorizontal: 4, fontSize: 12.5, lineHeight: 18 },
	remove: { marginTop: 28 },
});
