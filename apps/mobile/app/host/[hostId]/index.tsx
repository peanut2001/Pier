import type { SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { Button, Card, confirmDestructive, Muted, Pill, Screen, Title } from "../../../src/components/ui.tsx";
import { isBusy, RUN_STATE_LABEL, relativeTime, sessionTitle } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { usePalette } from "../../../src/theme.ts";

const SESSIONS_PER_WORKSPACE = 15;

function ConnectionBanner({ hostId }: { hostId: string }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const view = useMobileState((s) => s.host);
	if (view.revoked) {
		return (
			<Card style={[styles.banner, { borderColor: p.danger }]}>
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
		<Card style={styles.banner}>
			<View style={styles.bannerRow}>
				<ActivityIndicator color={p.accent} />
				<Text style={{ color: p.text, flex: 1 }}>
					{view.connection === "reconnecting" ? "连接中断，正在重连…" : "正在连接…"}
				</Text>
				<Button title="立即重试" small onPress={() => store.retryNow()} />
			</View>
			{view.error ? <Muted>{view.error}</Muted> : null}
		</Card>
	);
}

function SessionRow({ session, hostId }: { session: SessionSummary; hostId: string }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const pending = session.pendingUi ?? 0;
	return (
		<Pressable
			testID={`session-${session.id}`}
			style={({ pressed }) => [styles.session, { borderColor: p.border }, pressed && { backgroundColor: p.elevated }]}
			onPress={() =>
				router.push({
					pathname: "/host/[hostId]/session/[sessionId]",
					params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
				})
			}
			onLongPress={() => {
				const running = isBusy(session.state);
				confirmDestructive(
					`删除“${sessionTitle(session)}”？`,
					`${running ? "Agent 正在运行，会先中止。" : ""}会话文件会移到电脑上的 Pier 回收站（~/.pier/trash/sessions）。`,
					"删除",
					() => void store.deleteSession(session, running),
				);
			}}
		>
			<View style={styles.sessionMain}>
				<Text style={[styles.sessionTitle, { color: p.text }]} numberOfLines={2}>
					{sessionTitle(session)}
				</Text>
				<Text style={[styles.sessionMeta, { color: p.muted }]}>
					{relativeTime(session.modifiedAt)} · {session.messageCount} 条消息
				</Text>
			</View>
			{pending ? (
				<Pill text={`待批准 ${pending}`} tone="warning" />
			) : isBusy(session.state) ? (
				<Pill text={RUN_STATE_LABEL[session.state]} tone="accent" />
			) : null}
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
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		if (hostId) store.openHost(hostId);
	}, [hostId, store]);

	const sections = useMemo(
		() =>
			(view.hostId === hostId ? (view.workspaces ?? []) : []).map((workspace: WorkspaceInfo) => {
				const sessions = view.sessions[workspace.id] ?? [];
				const limit = limits[workspace.id] ?? SESSIONS_PER_WORKSPACE;
				return { workspace, total: sessions.length, limit, data: sessions.slice(0, limit) };
			}),
		[view, hostId, limits],
	);

	const pendingTotal = sections.reduce(
		(sum, s) => sum + (view.sessions[s.workspace.id] ?? []).reduce((n, x) => n + (x.pendingUi ?? 0), 0),
		0,
	);

	return (
		<Screen>
			<Stack.Screen options={{ title: host?.hostName ?? "电脑" }} />
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
							<Card style={[styles.banner, { borderColor: p.warning, backgroundColor: p.warningSoft }]}>
								<Text style={{ color: p.warning, fontWeight: "600" }}>有 {pendingTotal} 个请求等待你批准</Text>
							</Card>
						) : null}
						{view.connection === "open" && view.workspaces && !view.workspaces.length ? (
							<Card>
								<Muted>电脑上还没有工作区。请先在电脑的 Pier 中添加一个工作区目录。</Muted>
							</Card>
						) : null}
					</View>
				}
				renderSectionHeader={({ section }) => (
					<View style={styles.sectionHeader}>
						<View style={styles.flex}>
							<Title>{section.workspace.name}</Title>
							<Muted style={styles.path}>{section.workspace.path}</Muted>
						</View>
						<Button
							title="新建"
							small
							disabled={view.connection !== "open"}
							onPress={async () => {
								const session = await store.createSession(section.workspace.id);
								if (session) {
									router.push({
										pathname: "/host/[hostId]/session/[sessionId]",
										params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
									});
								}
							}}
						/>
					</View>
				)}
				renderItem={({ item }) => <SessionRow session={item} hostId={hostId} />}
				renderSectionFooter={({ section }) =>
					section.total > section.limit ? (
						<Pressable
							style={styles.more}
							onPress={() => setLimits({ ...limits, [section.workspace.id]: section.limit + SESSIONS_PER_WORKSPACE })}
						>
							<Text style={{ color: p.accent }}>显示更多（还有 {section.total - section.limit} 个）</Text>
						</Pressable>
					) : section.total === 0 ? (
						<Muted style={styles.none}>还没有会话</Muted>
					) : null
				}
			/>
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	list: { padding: 14, paddingBottom: 40 },
	header: { gap: 10, marginBottom: 6 },
	banner: { gap: 10 },
	bannerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
	sectionHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 18, marginBottom: 8 },
	path: { fontSize: 12 },
	session: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 12,
		paddingHorizontal: 4,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	sessionMain: { flex: 1, gap: 3 },
	sessionTitle: { fontSize: 15 },
	sessionMeta: { fontSize: 12 },
	more: { paddingVertical: 12, alignItems: "center" },
	none: { paddingVertical: 8, paddingHorizontal: 4 },
});
