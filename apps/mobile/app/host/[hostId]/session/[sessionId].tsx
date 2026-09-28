import { type ChatController, contentText, isRole } from "@pier/chat-state";
import type { ModelInfo, SessionSummary, ThinkingLevel } from "@pier/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
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
import { Button, Muted, Title } from "../../../../src/components/ui.tsx";
import { RUN_STATE_LABEL, sessionTitle } from "../../../../src/format.ts";
import { useChatView, useMobileState, useStore } from "../../../../src/store.ts";
import { usePalette } from "../../../../src/theme.ts";

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
				<ScrollView contentContainerStyle={styles.sheetContent}>
					<Title>模型</Title>
					{!models ? <ActivityIndicator color={p.accent} /> : null}
					{models?.map((model) => {
						const selected = current?.provider === model.provider && current.id === model.id;
						return (
							<Pressable
								key={`${model.provider}/${model.id}`}
								style={[styles.option, { borderColor: selected ? p.accent : p.border }]}
								onPress={async () => {
									await chat.setModel(model.provider, model.id);
									onClose();
								}}
							>
								<Text style={{ color: p.text, fontWeight: selected ? "700" : "400" }}>{model.name}</Text>
								<Muted>{model.provider}</Muted>
							</Pressable>
						);
					})}
					{current?.reasoning ? (
						<>
							<Title style={styles.sectionTitle}>思考等级</Title>
							<View style={styles.levels}>
								{THINKING_LEVELS.map((level) => (
									<Button
										key={level}
										title={level}
										small
										variant={chat.chat.thinkingLevel === level ? "primary" : "secondary"}
										onPress={() => void chat.setThinking(level)}
									/>
								))}
							</View>
						</>
					) : null}
					<Title style={styles.sectionTitle}>上下文</Title>
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
					state.session.firstMessage || (firstUser && isRole(firstUser, "user") ? contentText(firstUser.content) : ""),
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
					headerRight: () =>
						chat ? (
							<Pressable hitSlop={10} onPress={() => setMenu(true)} accessibilityLabel="会话选项">
								<Text style={{ color: p.accent, fontSize: 16 }}>选项</Text>
							</Pressable>
						) : null,
				}}
			/>
			<View style={[styles.statusBar, { borderColor: p.border }]}>
				<Text style={[styles.statusText, { color: p.muted }]} numberOfLines={1}>
					{revoked
						? "这台设备已被电脑移除，请返回重新配对"
						: connection === "open"
							? state
								? RUN_STATE_LABEL[state.runState]
								: "加载中"
							: "未连接，正在重连…"}
					{state?.model ? ` · ${state.model.name}` : ""}
					{state?.model?.reasoning ? ` · 思考 ${state.thinkingLevel}` : ""}
				</Text>
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
	statusBar: { paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
	statusText: { fontSize: 12 },
	loading: { marginTop: 40 },
	error: { padding: 20 },
	queue: { paddingHorizontal: 14, paddingTop: 6 },
	backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
	sheet: { maxHeight: "75%", borderTopLeftRadius: 16, borderTopRightRadius: 16 },
	sheetContent: { padding: 18, gap: 10 },
	option: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 2 },
	sectionTitle: { marginTop: 10 },
	levels: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
