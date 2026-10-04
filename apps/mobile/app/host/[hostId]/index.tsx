import { agentRuntimeLabel } from "@pier/chat-state";
import type { AgentRuntimeId, AgentRuntimeInfo, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { AgentPicker } from "../../../src/components/AgentPicker.tsx";
import {
	ActionSheet,
	Avatar,
	Button,
	Card,
	HeaderAction,
	Muted,
	Pill,
	Screen,
	type SheetAction,
	Title,
} from "../../../src/components/ui.tsx";
import { isBusy, RUN_STATE_LABEL, relativeTime, sessionTitle } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, RADIUS, usePalette } from "../../../src/theme.ts";

const SESSIONS_PER_WORKSPACE = 15;

function ConnectionBanner({ hostId }: { hostId: string }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const view = useMobileState((s) => s.host);
	if (view.revoked) {
		return (
			<Card flat style={[styles.banner, { borderColor: p.danger, backgroundColor: p.dangerSoft }]}>
				<Title>无法连接</Title>
				<Muted>{view.error}</Muted>
				<Button
					title="重新配对"
					variant="primary"
					onPress={() => router.push({ pathname: "/pair", params: { from: hostId } })}
				/>
				<Button
					title="从手机移除这台电脑"
					variant="danger"
					onPress={async () => {
						await store.forgetHost(hostId);
						router.back();
					}}
				/>
			</Card>
		);
	}
	if (view.connection === "open") return null;
	return (
		<Card flat style={styles.banner}>
			<View style={styles.bannerRow}>
				<ActivityIndicator color={p.accent} />
				<Text style={{ color: p.text, flex: 1 }}>
					{view.connection === "reconnecting" ? "连接中断，正在重连…" : "正在连接…"}
				</Text>
				<Button title="立即重试" small onPress={() => store.retryNow()} />
			</View>
			{view.error ? <Muted>{view.error}</Muted> : null}
			{view.connection === "reconnecting" ? (
				<View style={styles.bannerRow}>
					<Muted style={styles.flex}>电脑的 IP 变了？修改地址即可，不用重新配对。</Muted>
					<Button
						title="修改地址"
						small
						variant="tonal"
						onPress={() => router.push({ pathname: "/host/[hostId]/addresses", params: { hostId } })}
					/>
				</View>
			) : null}
		</Card>
	);
}

function SessionMenu({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
	const store = useStore();
	const running = isBusy(session.state);
	const title = sessionTitle(session);
	const actions: SheetAction[] = [];
	// Older computers cannot archive.
	if (store.canArchive()) {
		actions.push(
			session.archived
				? {
						label: "取消归档",
						description: "放回会话列表",
						testID: "session-unarchive",
						onPress: () => void store.archiveSession(session, false),
					}
				: {
						label: "归档",
						description: "从列表中收起，可随时在“已归档”中找回",
						testID: "session-archive",
						onPress: () => void store.archiveSession(session, true),
					},
		);
	}
	actions.push({
		label: "删除",
		description: running ? "Agent 正在运行，会先中止" : "移到电脑上的 Pier 回收站",
		danger: true,
		testID: "session-delete",
		confirm: {
			title: `删除“${title.length > 40 ? `${title.slice(0, 40)}…` : title}”？`,
			message: `${running ? "Agent 正在运行，会先中止。" : ""}会话文件会移到电脑上的 Pier 回收站（~/.pier/trash/sessions）。`,
			action: "删除",
		},
		onPress: () => void store.deleteSession(session, running),
	});
	return (
		<ActionSheet
			title={title}
			subtitle={[
				session.archived ? "已归档" : running ? RUN_STATE_LABEL[session.state] : "",
				relativeTime(session.modifiedAt),
				`${session.messageCount} 条消息`,
			]
				.filter(Boolean)
				.join(" · ")}
			actions={actions}
			onClose={onClose}
		/>
	);
}

function SessionRow({
	session,
	hostId,
	first,
	last,
	onMenu,
}: {
	session: SessionSummary;
	hostId: string;
	first: boolean;
	last: boolean;
	onMenu: (session: SessionSummary) => void;
}) {
	const router = useRouter();
	const p = usePalette();
	const pending = session.pendingUi ?? 0;
	const busy = isBusy(session.state);
	return (
		<Pressable
			testID={`session-${session.id}`}
			style={({ pressed }) => [
				styles.session,
				{ backgroundColor: pressed ? p.elevated : p.card, borderColor: p.border },
				first && styles.sessionFirst,
				last && styles.sessionLast,
			]}
			onPress={() =>
				router.push({
					pathname: "/host/[hostId]/session/[sessionId]",
					params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
				})
			}
			onLongPress={() => onMenu(session)}
		>
			{!first ? <View style={[styles.separator, { backgroundColor: p.border }]} /> : null}
			<View style={styles.sessionMain}>
				<Text style={[styles.sessionTitle, { color: session.archived ? p.muted : p.text }]} numberOfLines={2}>
					{sessionTitle(session)}
				</Text>
				<Text style={[styles.sessionMeta, { color: p.faint }]} numberOfLines={1}>
					{session.archived ? "已归档 · " : ""}
					{session.runtime && session.runtime !== "pi" ? `${agentRuntimeLabel(session.runtime)} · ` : ""}
					{relativeTime(session.modifiedAt)} · {session.messageCount} 条消息
				</Text>
			</View>
			{pending ? (
				<Pill text={`待批准 ${pending}`} tone="warning" dot />
			) : busy ? (
				<Pill text={RUN_STATE_LABEL[session.state]} tone="accent" dot />
			) : (
				<Text style={[styles.chevron, { color: p.faint }]}>›</Text>
			)}
		</Pressable>
	);
}

export default function HostScreen() {
	const { hostId } = useLocalSearchParams<{ hostId: string }>();
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const host = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId));
	const view = useMobileState((s) => s.host);
	const [limits, setLimits] = useState<Record<string, number>>({});
	const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
	const [refreshing, setRefreshing] = useState(false);
	const [picker, setPicker] = useState<{ workspace: WorkspaceInfo; runtimes: AgentRuntimeInfo[] }>();
	const [menu, setMenu] = useState<SessionSummary>();

	const createSession = async (workspaceId: string, runtime?: AgentRuntimeId) => {
		const session = await store.createSession(workspaceId, runtime);
		if (session) {
			setPicker(undefined);
			router.push({
				pathname: "/host/[hostId]/session/[sessionId]",
				params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
			});
		}
	};

	useEffect(() => {
		if (hostId) store.openHost(hostId);
	}, [hostId, store]);

	const sections = useMemo(
		() =>
			(view.hostId === hostId ? (view.workspaces ?? []) : []).map((workspace: WorkspaceInfo) => {
				const all = view.sessions[workspace.id] ?? [];
				const archived = all.filter((s) => s.archived).length;
				const withArchived = !!showArchived[workspace.id];
				// Archived sessions are listed after the others once shown.
				const sessions = withArchived
					? [...all.filter((s) => !s.archived), ...all.filter((s) => s.archived)]
					: all.filter((s) => !s.archived);
				const limit = limits[workspace.id] ?? SESSIONS_PER_WORKSPACE;
				return {
					workspace,
					total: sessions.length,
					archived,
					withArchived,
					limit,
					data: sessions.slice(0, limit),
				};
			}),
		[view, hostId, limits, showArchived],
	);

	const pendingTotal = sections.reduce(
		(sum, s) => sum + (view.sessions[s.workspace.id] ?? []).reduce((n, x) => n + (x.pendingUi ?? 0), 0),
		0,
	);
	const online = view.hostId === hostId && view.connection === "open";
	const addWorkspace = () => {
		if (!store.canAddWorkspace()) {
			store.toast("error", "这台电脑上的 Pier 版本较旧，请先升级，或在电脑上添加工作区");
			return;
		}
		router.push({ pathname: "/host/[hostId]/add-workspace", params: { hostId } });
	};
	const openWorkspace = (workspaceId: string) =>
		router.push({ pathname: "/host/[hostId]/workspace/[workspaceId]", params: { hostId, workspaceId } });

	return (
		<Screen>
			<Stack.Screen
				options={{
					title: host?.hostName ?? "电脑",
					headerRight: () => (
						<View style={styles.headerActions}>
							{online ? <HeaderAction label="添加工作区" glyph="+" onPress={addWorkspace} /> : null}
							<HeaderAction
								label="地址"
								onPress={() => router.push({ pathname: "/host/[hostId]/addresses", params: { hostId } })}
							/>
						</View>
					),
				}}
			/>
			<SectionList
				sections={sections}
				keyExtractor={(item) => item.id}
				contentContainerStyle={styles.list}
				stickySectionHeadersEnabled={false}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						tintColor={p.accent}
						onRefresh={async () => {
							setRefreshing(true);
							await store.loadWorkspaces();
							setRefreshing(false);
						}}
					/>
				}
				ListHeaderComponent={
					<View style={styles.header}>
						{hostId ? <ConnectionBanner hostId={hostId} /> : null}
						{pendingTotal ? (
							<Card flat style={[styles.banner, { borderColor: p.warning, backgroundColor: p.warningSoft }]}>
								<Text style={{ color: p.warning, fontWeight: "600" }}>有 {pendingTotal} 个请求等待你批准</Text>
							</Card>
						) : null}
						{view.connection === "open" && view.workspaces && !view.workspaces.length ? (
							<Card flat style={styles.banner}>
								<Muted>
									{store.canAddWorkspace()
										? "电脑上还没有工作区。选择电脑上的一个目录作为工作区，Agent 会在其中运行。"
										: "电脑上还没有工作区。这台电脑上的 Pier 版本较旧，请先在电脑的 Pier 中添加一个工作区目录。"}
								</Muted>
								{store.canAddWorkspace() ? (
									<Button
										title="添加工作区"
										icon="+"
										variant="primary"
										onPress={addWorkspace}
										testID="add-workspace-empty"
									/>
								) : null}
							</Card>
						) : null}
					</View>
				}
				renderSectionHeader={({ section }) => (
					<View style={styles.sectionHeader}>
						<Pressable
							testID={`workspace-${section.workspace.id}`}
							accessibilityRole="button"
							accessibilityLabel={`工作区设置：${section.workspace.name}`}
							onPress={() => openWorkspace(section.workspace.id)}
							style={({ pressed }) => [styles.sectionInfo, pressed && styles.pressed]}
						>
							<Avatar name={section.workspace.name} size={38} />
							<View style={styles.flex}>
								<View style={styles.nameRow}>
									<Title numberOfLines={1} style={styles.shrink}>
										{section.workspace.name}
									</Title>
									<Text style={[styles.moreGlyph, { color: p.faint }]}>⋯</Text>
								</View>
								<Text style={[styles.path, { color: p.faint }]} numberOfLines={1} ellipsizeMode="head">
									{section.workspace.path}
								</Text>
							</View>
						</Pressable>
						<Button
							title="新建"
							icon="+"
							variant="primary"
							small
							disabled={view.connection !== "open"}
							onPress={async () => {
								const workspace = section.workspace;
								// Let the user pick the agent when the computer can run more than pi.
								const runtimes = await store.availableRuntimes();
								if (runtimes.length < 2) {
									await createSession(workspace.id);
									return;
								}
								setPicker({ workspace, runtimes });
							}}
						/>
					</View>
				)}
				renderItem={({ item, index, section }) => (
					<SessionRow
						session={item}
						hostId={hostId}
						first={index === 0}
						last={index === section.data.length - 1}
						onMenu={setMenu}
					/>
				)}
				renderSectionFooter={({ section }) => (
					<View style={[styles.footer, section.total > 0 && styles.footerAfterList]}>
						{section.total > section.limit ? (
							<Pressable
								style={({ pressed }) => [styles.more, pressed && styles.pressed]}
								onPress={() => setLimits({ ...limits, [section.workspace.id]: section.limit + SESSIONS_PER_WORKSPACE })}
							>
								<Text style={[styles.moreText, { color: p.accent }]}>
									显示更多（还有 {section.total - section.limit} 个）
								</Text>
							</Pressable>
						) : section.total === 0 ? (
							<View style={[styles.none, { backgroundColor: p.card, borderColor: p.border }]}>
								<Muted>{section.archived ? "会话都已归档" : "还没有会话，点“新建”开始"}</Muted>
							</View>
						) : null}
						{section.archived ? (
							<Pressable
								accessibilityRole="button"
								style={({ pressed }) => [
									styles.archivedToggle,
									{ backgroundColor: p.elevated },
									pressed && styles.pressed,
								]}
								onPress={() => setShowArchived({ ...showArchived, [section.workspace.id]: !section.withArchived })}
							>
								<Text style={[styles.archivedText, { color: p.muted }]}>
									{section.withArchived ? "收起已归档" : `已归档 ${section.archived} 个`}
								</Text>
								<Text style={[styles.archivedGlyph, { color: p.faint }]}>{section.withArchived ? "▴" : "▾"}</Text>
							</Pressable>
						) : null}
					</View>
				)}
			/>
			{menu ? <SessionMenu session={menu} onClose={() => setMenu(undefined)} /> : null}
			{picker ? (
				<AgentPicker
					runtimes={picker.runtimes}
					workspaceName={picker.workspace.name}
					onPick={(runtime) => createSession(picker.workspace.id, runtime)}
					onClose={() => setPicker(undefined)}
				/>
			) : null}
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 48 },
	header: { gap: 10 },
	banner: { gap: 10 },
	bannerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
	headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
	sectionHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		marginTop: 16,
		marginBottom: 12,
		paddingHorizontal: 2,
	},
	path: { fontSize: 11.5, fontFamily: MONO, marginTop: 2 },
	sectionInfo: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
	nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
	shrink: { flexShrink: 1 },
	moreGlyph: { fontSize: 18, fontWeight: "700", marginTop: -2 },
	pressed: { opacity: 0.6 },
	session: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingVertical: 14,
		paddingHorizontal: 16,
		borderLeftWidth: StyleSheet.hairlineWidth,
		borderRightWidth: StyleSheet.hairlineWidth,
	},
	sessionFirst: {
		borderTopLeftRadius: RADIUS.lg,
		borderTopRightRadius: RADIUS.lg,
		borderTopWidth: StyleSheet.hairlineWidth,
	},
	sessionLast: {
		borderBottomLeftRadius: RADIUS.lg,
		borderBottomRightRadius: RADIUS.lg,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	separator: { position: "absolute", top: 0, left: 16, right: 0, height: StyleSheet.hairlineWidth },
	sessionMain: { flex: 1, gap: 5 },
	sessionTitle: { fontSize: 15.5, lineHeight: 22, fontWeight: "500" },
	sessionMeta: { fontSize: 12.5 },
	chevron: { fontSize: 22, marginTop: -2 },
	footer: { gap: 10 },
	footerAfterList: { marginTop: 10 },
	more: { paddingVertical: 4, alignItems: "center" },
	moreText: { fontSize: 14, fontWeight: "500" },
	archivedToggle: {
		alignSelf: "center",
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		height: 30,
		paddingHorizontal: 14,
		borderRadius: RADIUS.pill,
	},
	archivedText: { fontSize: 13, fontWeight: "500" },
	archivedGlyph: { fontSize: 13, fontWeight: "700" },
	none: {
		paddingVertical: 18,
		paddingHorizontal: 16,
		borderRadius: RADIUS.lg,
		borderWidth: StyleSheet.hairlineWidth,
		alignItems: "center",
	},
});
