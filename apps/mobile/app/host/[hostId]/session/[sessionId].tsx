import { type ChatController, isRole, userText } from "@pier/chat-state";
import type { ModelInfo, SessionSummary, ThinkingLevel } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "../../../../src/components/Composer.tsx";
import { PendingRequests } from "../../../../src/components/PendingRequests.tsx";
import { Transcript } from "../../../../src/components/Transcript.tsx";
import {
	Button,
	confirmDestructive,
	HeaderAction,
	Muted,
	SectionLabel,
	StatusDot,
} from "../../../../src/components/ui.tsx";
import { isBusy, RUN_STATE_LABEL, sessionTitle } from "../../../../src/format.ts";
import { useChatView, useMobileState, useStore } from "../../../../src/store.ts";
import { RADIUS, usePalette } from "../../../../src/theme.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function placeholderSummary(sessionId: string, workspaceId: string): SessionSummary {
	const now = new Date().toISOString();
	return {
		id: sessionId,
		workspaceId,
		cwd: "",
		createdAt: now,
		modifiedAt: now,
		messageCount: 0,
		firstMessage: "",
		active: false,
		state: "inactive",
	};
}

function SessionMenu({ chat, onClose }: { chat: ChatController; onClose: () => void }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const [models, setModels] = useState<ModelInfo[] | undefined>();
	const [busy, setBusy] = useState(false);
	const current = chat.chat.model;
	useEffect(() => {
		let alive = true;
		chat
			.listModels()
			.then((result) => {
				if (alive) setModels(result.models);
			})
			.catch(() => {
				if (alive) setModels([]);
			});
		return () => {
			alive = false;
		};
	}, [chat]);
	return (
		<Modal transparent animationType="slide" onRequestClose={onClose}>
			<Pressable style={styles.backdrop} onPress={onClose} />
			<View style={[styles.sheet, { backgroundColor: p.card, paddingBottom: insets.bottom + 16 }]}>
				<View style={[styles.grabber, { backgroundColor: p.border }]} />
				<ScrollView contentContainerStyle={styles.sheetContent}>
					<SectionLabel>模型</SectionLabel>
					{!models ? <ActivityIndicator color={p.accent} /> : null}
					{models?.length ? (
						<View style={[styles.group, { backgroundColor: p.bg }]}>
							{models.map((model, index) => {
								const selected = current?.provider === model.provider && current.id === model.id;
								return (
									<Pressable
										key={`${model.provider}/${model.id}`}
										style={({ pressed }) => [
											styles.option,
											index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
											selected && { backgroundColor: p.accentSoft },
											pressed && { backgroundColor: p.elevated },
										]}
										onPress={async () => {
											await chat.setModel(model.provider, model.id);
											onClose();
										}}
									>
										<View style={styles.flex}>
											<Text style={[styles.optionName, { color: selected ? p.accent : p.text }]} numberOfLines={1}>
												{model.name}
											</Text>
											<Muted>{model.provider}</Muted>
										</View>
										{selected ? <Text style={[styles.check, { color: p.accent }]}>✓</Text> : null}
									</Pressable>
								);
							})}
						</View>
					) : null}
					{current?.reasoning ? (
						<>
							<SectionLabel style={styles.sectionTitle}>思考等级</SectionLabel>
							<View style={[styles.levels, { backgroundColor: p.elevated }]}>
								{THINKING_LEVELS.map((level) => {
									const selected = chat.chat.thinkingLevel === level;
									return (
										<Pressable
											key={level}
											accessibilityRole="button"
											accessibilityLabel={level}
											onPress={() => void chat.setThinking(level)}
											style={[styles.level, selected && { backgroundColor: p.card }]}
										>
											<Text
												style={[styles.levelText, { color: selected ? p.accent : p.muted }]}
												numberOfLines={1}
												adjustsFontSizeToFit
											>
												{level}
											</Text>
										</Pressable>
									);
								})}
							</View>
						</>
					) : null}
					{chat.chat.capabilities?.compact === false ? null : (
						<>
							<SectionLabel style={styles.sectionTitle}>上下文</SectionLabel>
							<Button
								title="压缩上下文"
								loading={busy}
								onPress={async () => {
									setBusy(true);
									await chat.compact();
									setBusy(false);
									onClose();
								}}
							/>
						</>
					)}
					<SectionLabel style={styles.sectionTitle}>会话</SectionLabel>
					<Button
						title="删除会话"
						variant="danger"
						disabled={!chat.chat.session}
						onPress={() => {
							const session = chat.chat.session;
							if (!session) return;
							const running = isBusy(chat.chat.runState);
							confirmDestructive(
								`删除“${sessionTitle(session)}”？`,
								`${running ? "Agent 正在运行，会先中止。" : ""}会话文件会移到电脑上的 Pier 回收站（~/.pier/trash/sessions）。`,
								"删除",
								async () => {
									if (!(await store.deleteSession(session, running))) return;
									onClose();
									if (router.canGoBack()) router.back();
								},
							);
						}}
					/>
				</ScrollView>
			</View>
		</Modal>
	);
}

export default function SessionScreen() {
	const { hostId, sessionId, workspaceId } = useLocalSearchParams<{
		hostId: string;
		sessionId: string;
		workspaceId: string;
	}>();
	const store = useStore();
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const connection = useMobileState((s) => (s.host.hostId === hostId ? s.host.connection : "none"));
	const revoked = useMobileState((s) => s.host.hostId === hostId && s.host.revoked);
	useMobileState((s) => s.chatsVersion);
	const [menu, setMenu] = useState(false);
	const scroller = useRef<ScrollView>(null);
	const nearBottom = useRef(true);

	useEffect(() => {
		if (hostId) store.openHost(hostId);
	}, [hostId, store]);

	const ready = connection !== "none" && connection !== "connecting" && store.activeClient !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-create after the host connection is replaced.
	const chat = useMemo(() => {
		if (!ready || !sessionId) return undefined;
		return store.chat(store.findSession(sessionId) ?? placeholderSummary(sessionId, workspaceId ?? ""));
	}, [ready, sessionId, workspaceId, store, store.activeClient]);
	const view = useChatView(chat);
	const state = view?.chat;
	const firstUser = state?.messages.find((m) => isRole(m, "user"));
	const title = state?.session
		? sessionTitle({
				name: state.session.name,
				firstMessage:
					state.session.firstMessage || (firstUser && isRole(firstUser, "user") ? userText(firstUser.content) : ""),
			})
		: "会话";

	return (
		<KeyboardAvoidingView
			style={[styles.flex, { backgroundColor: p.bg }]}
			behavior={Platform.OS === "ios" ? "padding" : undefined}
			keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}
		>
			<Stack.Screen
				options={{
					title,
					headerRight: () => (chat ? <HeaderAction label="会话选项" glyph="⋯" onPress={() => setMenu(true)} /> : null),
				}}
			/>
			<View style={[styles.statusBar, { borderColor: p.border }]}>
				<View style={[styles.chip, { backgroundColor: p.elevated }]}>
					<StatusDot
						size={7}
						color={
							revoked ? p.danger : connection !== "open" ? p.warning : state && isBusy(state.runState) ? p.accent : p.ok
						}
					/>
					<Text style={[styles.statusText, { color: p.muted }]} numberOfLines={1}>
						{revoked
							? "这台设备已被电脑移除，请返回重新配对"
							: connection === "open"
								? state
									? RUN_STATE_LABEL[state.runState]
									: "加载中"
								: "未连接，正在重连…"}
					</Text>
				</View>
				{state?.model ? (
					<Pressable
						onPress={() => chat && setMenu(true)}
						style={[styles.chip, styles.chipShrink, { backgroundColor: p.elevated }]}
						accessibilityLabel="切换模型"
					>
						<Text style={[styles.statusText, { color: p.text }]} numberOfLines={1}>
							{state.model.name}
							{state.model.reasoning ? <Text style={{ color: p.muted }}> · {state.thinkingLevel}</Text> : null}
						</Text>
						<Text style={[styles.statusText, { color: p.faint }]}>▾</Text>
					</Pressable>
				) : null}
			</View>
			<ScrollView
				ref={scroller}
				style={styles.flex}
				keyboardDismissMode="interactive"
				onScroll={(e) => {
					const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
					nearBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
				}}
				scrollEventThrottle={100}
				onContentSizeChange={() => {
					if (nearBottom.current) scroller.current?.scrollToEnd({ animated: false });
				}}
			>
				{view?.error ? (
					<Muted style={styles.error}>无法打开会话：{view.error}</Muted>
				) : !state?.loaded ? (
					<ActivityIndicator style={styles.loading} color={p.accent} />
				) : (
					<Transcript chat={state} />
				)}
			</ScrollView>
			{chat && state ? (
				<>
					<PendingRequests requests={state.pendingUi} respond={(id, response) => void chat.respond(id, response)} />
					{state.queue.steering.length || state.queue.followUp.length ? (
						<Muted style={styles.queue}>
							已排队：{[...state.queue.steering, ...state.queue.followUp].map((t) => `“${t.slice(0, 30)}”`).join("、")}
						</Muted>
					) : null}
					<View style={{ paddingBottom: insets.bottom }}>
						<Composer chat={chat} runState={state.runState} />
					</View>
				</>
			) : null}
			{menu && chat ? <SessionMenu chat={chat} onClose={() => setMenu(false)} /> : null}
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	statusBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 14,
		paddingBottom: 8,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 10,
		paddingVertical: 5,
		borderRadius: RADIUS.pill,
		maxWidth: "60%",
	},
	chipShrink: { flexShrink: 1 },
	statusText: { fontSize: 12.5, fontWeight: "500", flexShrink: 1 },
	loading: { marginTop: 40 },
	error: { padding: 20 },
	queue: { paddingHorizontal: 16, paddingTop: 6 },
	backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
	sheet: { maxHeight: "78%", borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl },
	grabber: { alignSelf: "center", width: 38, height: 5, borderRadius: 3, marginTop: 8 },
	sheetContent: { padding: 18, paddingTop: 12, gap: 10 },
	group: { borderRadius: RADIUS.md, overflow: "hidden" },
	option: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
	optionName: { fontSize: 15, fontWeight: "600" },
	check: { fontSize: 17, fontWeight: "700" },
	sectionTitle: { marginTop: 12 },
	levels: { flexDirection: "row", padding: 3, borderRadius: RADIUS.md, gap: 2 },
	level: { flex: 1, paddingVertical: 8, borderRadius: RADIUS.sm + 1, alignItems: "center" },
	levelText: { fontSize: 13, fontWeight: "600" },
});
