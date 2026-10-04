import {
	type ChatController,
	clampThinking,
	isRole,
	supportedThinkingLevels,
	thinkingLabel,
	userText,
} from "@pier/chat-state";
import type { ApprovalPolicy, ModelInfo, SessionSummary } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "../../../../src/components/Composer.tsx";
import { KeyboardAvoider } from "../../../../src/components/KeyboardAvoider.tsx";
import { PendingRequests } from "../../../../src/components/PendingRequests.tsx";
import { ThinkingSlider } from "../../../../src/components/ThinkingSlider.tsx";
import { Transcript } from "../../../../src/components/Transcript.tsx";
import {
	Button,
	confirmDestructive,
	HeaderAction,
	Icon,
	type IconName,
	Muted,
	PulseDot,
	Sheet,
	StatusDot,
} from "../../../../src/components/ui.tsx";
import { isBusy, POLICY_LABEL, POLICY_SUMMARY, RUN_STATE_LABEL, sessionTitle } from "../../../../src/format.ts";
import { useChatView, useMobileState, useStore } from "../../../../src/store.ts";
import { RADIUS, usePalette } from "../../../../src/theme.ts";

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

const POLICIES: ApprovalPolicy[] = ["ask", "smart", "auto"];

const POLICY_ICON: Record<ApprovalPolicy, IconName> = {
	ask: "hand-left-outline",
	smart: "shield-checkmark-outline",
	auto: "flash-outline",
};

function MenuSection({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
	const p = usePalette();
	return (
		<View style={styles.menuSection}>
			<View style={styles.menuSectionHead}>
				<Icon name={icon} size={15} color={p.muted} />
				<Text style={[styles.menuSectionTitle, { color: p.muted }]}>{title}</Text>
			</View>
			{children}
		</View>
	);
}

/** Approval-policy picker of the session's workspace. The policy applies to every session in it. */
function PolicySection({ workspaceId }: { workspaceId: string }) {
	const store = useStore();
	const p = usePalette();
	const workspace = useMobileState((s) => s.host.workspaces?.find((w) => w.id === workspaceId));
	const online = useMobileState((s) => s.host.connection === "open");
	const [saving, setSaving] = useState<ApprovalPolicy>();
	if (!workspace) return null;
	const canManage = online && store.canManageWorkspaces();
	return (
		<MenuSection icon="shield-outline" title="审批模式">
			<View style={[styles.group, { backgroundColor: p.bg }]}>
				{POLICIES.map((policy, index) => {
					const selected = workspace.policy === policy;
					const tint = policy === "auto" ? p.warning : p.accent;
					return (
						<Pressable
							key={policy}
							testID={`session-policy-${policy}`}
							accessibilityRole="radio"
							accessibilityState={{ selected, disabled: !canManage }}
							disabled={!canManage || saving !== undefined}
							style={({ pressed }) => [
								styles.option,
								index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
								pressed && { backgroundColor: p.elevated },
							]}
							onPress={async () => {
								if (selected) return;
								setSaving(policy);
								try {
									await store.setWorkspacePolicy(workspace.id, policy);
								} finally {
									setSaving(undefined);
								}
							}}
						>
							<View
								style={[
									styles.optionIcon,
									{ backgroundColor: selected ? (policy === "auto" ? p.warningSoft : p.accentSoft) : p.elevated },
								]}
							>
								<Icon name={POLICY_ICON[policy]} size={17} color={selected ? tint : p.muted} />
							</View>
							<View style={styles.flex}>
								<Text style={[styles.optionName, { color: selected ? tint : canManage ? p.text : p.muted }]}>
									{POLICY_LABEL[policy]}
								</Text>
								<Muted style={[styles.optionText, policy === "auto" ? { color: p.warning } : undefined]}>
									{POLICY_SUMMARY[policy]}
								</Muted>
							</View>
							{saving === policy ? (
								<ActivityIndicator size="small" color={p.accent} />
							) : selected ? (
								<Icon name="checkmark-circle" size={22} color={tint} />
							) : null}
						</Pressable>
					);
				})}
			</View>
			<Muted style={styles.policyNote}>
				{!online
					? "连接到电脑后才能修改。"
					: !canManage
						? "这台电脑上的 Pier 版本较旧，请先升级，或在电脑上修改审批模式。"
						: `对工作区「${workspace.name}」的所有会话立即生效。`}
			</Muted>
		</MenuSection>
	);
}

function SessionMenu({ chat, onClose }: { chat: ChatController; onClose: () => void }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const [models, setModels] = useState<ModelInfo[] | undefined>();
	const [busy, setBusy] = useState(false);
	const [sliding, setSliding] = useState(false);
	const [switching, setSwitching] = useState<string | undefined>();
	// Follow the session itself, so changes made on the computer show up here too.
	const view = useChatView(chat);
	const state = view?.chat ?? chat.chat;
	const current = state.model;
	const levels = supportedThinkingLevels(current);
	const level = clampThinking(state.thinkingLevel, levels);
	const groups = new Map<string, ModelInfo[]>();
	for (const model of models ?? []) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
	// Reload when the session's model changes (for example after models were edited on the computer).
	const modelKey = current ? JSON.stringify(current) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: modelKey only triggers a reload.
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
	}, [chat, modelKey]);
	return (
		<Sheet onClose={onClose}>
			<ScrollView contentContainerStyle={styles.sheetContent} scrollEnabled={!sliding}>
				<PolicySection workspaceId={chat.workspaceId} />
				{current ? (
					<View style={[styles.thinking, { backgroundColor: p.bg }]}>
						{levels.length > 1 ? (
							<ThinkingSlider
								levels={levels}
								value={level}
								onChange={(next) => chat.setThinking(next)}
								onDragging={setSliding}
							/>
						) : (
							<Muted>这个模型不支持调节思考程度</Muted>
						)}
					</View>
				) : null}
				<MenuSection icon="sparkles-outline" title="模型">
					{!models ? <ActivityIndicator color={p.accent} /> : null}
					{models && !models.length ? <Muted>没有可用的模型，请在电脑上的 Pier 里配置模型。</Muted> : null}
					{[...groups].map(([provider, list]) => (
						<View key={provider} style={styles.providerGroup}>
							<Text style={[styles.providerTitle, { color: p.faint }]}>{provider}</Text>
							<View style={[styles.group, { backgroundColor: p.bg }]}>
								{list.map((model, index) => {
									const key = `${model.provider}/${model.id}`;
									const selected = current?.provider === model.provider && current.id === model.id;
									return (
										<Pressable
											key={key}
											disabled={switching !== undefined}
											style={({ pressed }) => [
												styles.option,
												index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
												selected && { backgroundColor: p.accentSoft },
												pressed && { backgroundColor: p.elevated },
											]}
											onPress={async () => {
												if (selected) return;
												setSwitching(key);
												try {
													await chat.setModel(model.provider, model.id);
												} finally {
													setSwitching(undefined);
												}
											}}
										>
											<View style={styles.flex}>
												<View style={styles.optionHead}>
													<Text style={[styles.optionName, { color: selected ? p.accent : p.text }]} numberOfLines={1}>
														{model.name || model.id}
													</Text>
													{model.reasoning ? (
														<Text style={[styles.tag, { color: p.muted, backgroundColor: p.elevated }]}>推理</Text>
													) : null}
												</View>
												<Muted style={styles.optionText} numberOfLines={1}>
													{model.id}
												</Muted>
											</View>
											{switching === key ? (
												<ActivityIndicator size="small" color={p.accent} />
											) : selected ? (
												<Icon name="checkmark-circle" size={22} color={p.accent} />
											) : null}
										</Pressable>
									);
								})}
							</View>
						</View>
					))}
				</MenuSection>
				<View style={styles.menuActions}>
					{chat.chat.capabilities?.compact === false ? null : (
						<Button
							title="压缩上下文"
							icon="contract-outline"
							loading={busy}
							style={styles.flex}
							onPress={async () => {
								setBusy(true);
								await chat.compact();
								setBusy(false);
								onClose();
							}}
						/>
					)}
					<Button
						title="删除会话"
						icon="trash-outline"
						variant="danger"
						style={styles.flex}
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
				</View>
			</ScrollView>
		</Sheet>
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
	const sessionWorkspaceId = chat?.workspaceId || workspaceId;
	const policy = useMobileState((s) =>
		s.host.hostId === hostId ? s.host.workspaces?.find((w) => w.id === sessionWorkspaceId)?.policy : undefined,
	);
	const state = view?.chat;
	const firstUser = state?.messages.find((m) => isRole(m, "user"));
	const title = state?.session
		? sessionTitle({
				name: state.session.name,
				firstMessage:
					state.session.firstMessage || (firstUser && isRole(firstUser, "user") ? userText(firstUser.content) : ""),
			})
		: "会话";
	const running = !!state && isBusy(state.runState);
	const statusColor = revoked ? p.danger : connection !== "open" ? p.warning : running ? p.accent : p.ok;
	const modelLabel = state?.model
		? `${state.model.name}${
				supportedThinkingLevels(state.model).length > 1
					? ` · ${thinkingLabel(clampThinking(state.thinkingLevel, supportedThinkingLevels(state.model)))}`
					: ""
			}`
		: undefined;

	return (
		<KeyboardAvoider style={[styles.flex, { backgroundColor: p.bg }]} topOffset={insets.top + 44} contentInsetsBottom>
			<Stack.Screen
				options={{
					title,
					headerRight: () =>
						chat ? <HeaderAction label="会话选项" icon="ellipsis-horizontal" onPress={() => setMenu(true)} /> : null,
				}}
			/>
			<View style={[styles.statusBar, { borderColor: p.border }]}>
				<View style={[styles.chip, styles.chipShrink, { backgroundColor: p.elevated }]}>
					{running && connection === "open" ? (
						<PulseDot size={7} color={statusColor} />
					) : (
						<StatusDot size={7} color={statusColor} />
					)}
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
				{policy ? (
					<Pressable
						testID="session-policy-chip"
						onPress={() => chat && setMenu(true)}
						style={({ pressed }) => [
							styles.chip,
							{ backgroundColor: policy === "auto" ? p.warningSoft : p.elevated },
							pressed && styles.pressed,
						]}
						accessibilityLabel={`审批模式：${POLICY_LABEL[policy]}，点按切换`}
					>
						<Icon name={POLICY_ICON[policy]} size={13} color={policy === "auto" ? p.warning : p.muted} />
						<Text style={[styles.statusText, { color: policy === "auto" ? p.warning : p.text }]} numberOfLines={1}>
							{POLICY_LABEL[policy]}
						</Text>
						<Icon name="chevron-down" size={12} color={p.faint} />
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
				onLayout={() => {
					// Keep the latest messages in view when the keyboard shrinks the transcript.
					if (nearBottom.current) scroller.current?.scrollToEnd({ animated: false });
				}}
				onContentSizeChange={() => {
					if (nearBottom.current) scroller.current?.scrollToEnd({ animated: false });
				}}
			>
				{view?.error ? (
					<View style={[styles.error, { backgroundColor: p.dangerSoft }]}>
						<Icon name="alert-circle-outline" size={18} color={p.danger} />
						<Text style={[styles.errorText, { color: p.danger }]}>无法打开会话：{view.error}</Text>
					</View>
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
						<View style={[styles.queue, { backgroundColor: p.elevated }]}>
							<Icon name="time-outline" size={14} color={p.muted} />
							<Text style={[styles.queueText, { color: p.muted }]} numberOfLines={2}>
								已排队：
								{[...state.queue.steering, ...state.queue.followUp].map((t) => `“${t.slice(0, 30)}”`).join("、")}
							</Text>
						</View>
					) : null}
					<View style={{ paddingBottom: insets.bottom }}>
						<Composer
							chat={chat}
							runState={state.runState}
							{...(modelLabel ? { model: modelLabel } : {})}
							onModelPress={() => setMenu(true)}
						/>
					</View>
				</>
			) : null}
			{menu && chat ? <SessionMenu chat={chat} onClose={() => setMenu(false)} /> : null}
		</KeyboardAvoider>
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
		height: 28,
		borderRadius: RADIUS.pill,
		maxWidth: "65%",
	},
	chipShrink: { flexShrink: 1 },
	statusText: { fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
	pressed: { opacity: 0.7 },
	loading: { marginTop: 40 },
	error: { flexDirection: "row", gap: 8, margin: 16, padding: 14, borderRadius: RADIUS.md },
	errorText: { flex: 1, fontSize: 13.5, lineHeight: 19 },
	queue: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		marginHorizontal: 12,
		marginTop: 6,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: RADIUS.md,
	},
	queueText: { flex: 1, fontSize: 12.5 },
	sheetContent: { padding: 20, paddingTop: 14, gap: 20 },
	menuSection: { gap: 10 },
	menuSectionHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
	menuSectionTitle: { fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
	menuActions: { flexDirection: "row", gap: 10 },
	group: { borderRadius: RADIUS.lg, overflow: "hidden" },
	option: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
	optionIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
	optionName: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
	optionText: { fontSize: 12.5, lineHeight: 18 },
	policyNote: { fontSize: 12, marginHorizontal: 4 },
	thinking: { borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 12 },
	providerGroup: { gap: 6 },
	providerTitle: { fontSize: 12, fontWeight: "600", paddingHorizontal: 4 },
	optionHead: { flexDirection: "row", alignItems: "center", gap: 6 },
	tag: {
		fontSize: 10.5,
		fontWeight: "700",
		borderRadius: 6,
		paddingHorizontal: 6,
		paddingVertical: 1,
		overflow: "hidden",
	},
});
