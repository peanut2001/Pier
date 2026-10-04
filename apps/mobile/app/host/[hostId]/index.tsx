import { agentRuntimeLabel } from "@pier/chat-state";
import type { AgentRuntimeId, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Platform,
	Pressable,
	RefreshControl,
	SectionList,
	StyleSheet,
	Text,
	View,
} from "react-native";
import {
	Avatar,
	Button,
	Card,
	confirmDestructive,
	HeaderAction,
	Muted,
	Pill,
	Screen,
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

function SessionRow({
	session,
	hostId,
	first,
	last,
}: {
	session: SessionSummary;
	hostId: string;
	first: boolean;
	last: boolean;
}) {
	const store = useStore();
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
			onLongPress={() => {
				const running = isBusy(session.state);
				const remove = () =>
					confirmDestructive(
						`删除“${sessionTitle(session)}”？`,
						`${running ? "Agent 正在运行，会先中止。" : ""}会话文件会移到电脑上的 Pier 回收站（~/.pier/trash/sessions）。`,
						"删除",
						() => void store.deleteSession(session, running),
					);
				// Older computers cannot archive; web has no action sheet.
				if (!store.canArchive() || Platform.OS === "web") {
					remove();
					return;
				}
				Alert.alert(sessionTitle(session), undefined, [
					{
						text: session.archived ? "取消归档" : "归档",
						onPress: () => void store.archiveSession(session, !session.archived),
					},
					{ text: "删除…", style: "destructive", onPress: remove },
					{ text: "取消", style: "cancel" },
				]);
			}}
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
						<Avatar name={section.workspace.name} size={38} />
						<View style={styles.flex}>
							<Title numberOfLines={1}>{section.workspace.name}</Title>
							<Text style={[styles.path, { color: p.faint }]} numberOfLines={1} ellipsizeMode="head">
								{section.workspace.path}
							</Text>
						</View>
						<Button
							title="新建"
							icon="+"
							variant="primary"
							small
							disabled={view.connection !== "open"}
							onPress={async () => {
								const workspaceId = section.workspace.id;
								const create = async (runtime?: AgentRuntimeId) => {
									const session = await store.createSession(workspaceId, runtime);
									if (session) {
										router.push({
											pathname: "/host/[hostId]/session/[sessionId]",
											params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
										});
									}
								};
								// Let the user pick the agent when the computer can run more than pi.
								const runtimes = await store.availableRuntimes();
								if (runtimes.length < 2 || Platform.OS === "web") {
									await create();
									return;
								}
								Alert.alert("由哪个 Agent 来做？", undefined, [
									...runtimes.map((r) => ({ text: r.name, onPress: () => void create(r.id) })),
									{ text: "取消", style: "cancel" as const },
								]);
							}}
						/>
					</View>
				)}
				renderItem={({ item, index, section }) => (
					<SessionRow session={item} hostId={hostId} first={index === 0} last={index === section.data.length - 1} />
				)}
				renderSectionFooter={({ section }) => (
					<>
						{section.total > section.limit ? (
							<Pressable
								style={styles.more}
								onPress={() => setLimits({ ...limits, [section.workspace.id]: section.limit + SESSIONS_PER_WORKSPACE })}
							>
								<Text style={{ color: p.accent }}>显示更多（还有 {section.total - section.limit} 个）</Text>
							</Pressable>
						) : section.total === 0 ? (
							<View style={[styles.none, { backgroundColor: p.card, borderColor: p.border }]}>
								<Muted>{section.archived ? "没有未归档的会话" : "还没有会话，点“新建”开始"}</Muted>
							</View>
						) : null}
						{section.archived ? (
							<Pressable
								style={styles.more}
								onPress={() => setShowArchived({ ...showArchived, [section.workspace.id]: !section.withArchived })}
							>
								<Text style={{ color: p.muted }}>
									{section.withArchived ? "隐藏已归档的会话" : `显示已归档的会话（${section.archived} 个）`}
								</Text>
							</Pressable>
						) : null}
					</>
				)}
			/>
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
	more: { paddingVertical: 12, alignItems: "center" },
	none: {
		paddingVertical: 18,
		paddingHorizontal: 16,
		borderRadius: RADIUS.lg,
		borderWidth: StyleSheet.hairlineWidth,
		alignItems: "center",
	},
});
