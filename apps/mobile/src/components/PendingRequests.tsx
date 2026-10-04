import type { UiRequest, UiResponse } from "@pier/protocol";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { FLOAT_SHADOW, MONO, RADIUS, usePalette } from "../theme.ts";
import { Button, Icon, type IconName } from "./ui.tsx";

function CardTitle({
	icon,
	label,
	title,
	color,
	soft,
	countdown,
}: {
	icon: IconName;
	label: string;
	title: string;
	color: string;
	soft: string;
	countdown?: string | undefined;
}) {
	const p = usePalette();
	return (
		<View style={styles.titleRow}>
			<View style={[styles.titleIcon, { backgroundColor: soft }]}>
				<Icon name={icon} size={18} color={color} />
			</View>
			<View style={styles.grow}>
				<Text style={[styles.badge, { color }]}>{label}</Text>
				<Text style={[styles.tool, { color: p.text }]} numberOfLines={2}>
					{title}
				</Text>
			</View>
			{countdown ? (
				<View style={[styles.countdownPill, { backgroundColor: p.elevated }]}>
					<Icon name="timer-outline" size={12} color={p.muted} />
					<Text style={[styles.countdown, { color: p.muted }]}>{countdown}</Text>
				</View>
			) : null}
		</View>
	);
}

function useCountdown(expiresAt: string | undefined): string | undefined {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!expiresAt) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [expiresAt]);
	if (!expiresAt) return undefined;
	const left = Math.max(0, Date.parse(expiresAt) - now);
	if (left > 10 * 60_000) return undefined;
	return `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;
}

function ApprovalCard({ request, respond }: { request: UiRequest; respond: (r: UiResponse) => void }) {
	const p = usePalette();
	const approval = request.approval;
	const [denying, setDenying] = useState(false);
	const [reason, setReason] = useState("");
	const countdown = useCountdown(request.expiresAt);
	if (!approval) return null;
	const high = approval.severity === "high";
	return (
		<View
			style={[styles.card, FLOAT_SHADOW, { backgroundColor: p.card, borderColor: high ? p.danger : p.warning }]}
			testID="approval-card"
		>
			<CardTitle
				icon={high ? "warning" : "hand-left"}
				label={high ? "高风险 · 需要批准" : "需要批准"}
				title={approval.toolName}
				color={high ? p.danger : p.warning}
				soft={high ? p.dangerSoft : p.warningSoft}
				countdown={countdown ? `${countdown} 后拒绝` : undefined}
			/>
			<Text selectable style={[styles.summary, { backgroundColor: p.code, color: p.codeText }]} numberOfLines={12}>
				{approval.summary}
			</Text>
			<Text style={[styles.reason, { color: p.muted }]}>{approval.reason}</Text>
			{denying ? (
				<View style={styles.actions}>
					<TextInput
						autoFocus
						value={reason}
						onChangeText={setReason}
						placeholder="拒绝理由（会告诉 Agent，可留空）"
						placeholderTextColor={p.faint}
						style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
					/>
					<View style={styles.row}>
						<Button
							title="确认拒绝"
							icon="close"
							variant="danger"
							small
							style={styles.grow}
							onPress={() => respond({ decision: "deny", ...(reason.trim() ? { reason: reason.trim() } : {}) })}
						/>
						<Button title="返回" small onPress={() => setDenying(false)} />
					</View>
				</View>
			) : (
				<View style={styles.actions}>
					<View style={styles.row}>
						<Button
							title="允许一次"
							icon="checkmark"
							variant="primary"
							small
							style={styles.grow}
							onPress={() => respond({ decision: "allow_once" })}
						/>
						<Button
							title="拒绝…"
							icon="close"
							variant="danger"
							small
							style={styles.grow}
							onPress={() => setDenying(true)}
						/>
					</View>
					{approval.sessionAllowable ? (
						<Button
							title={`本会话内允许${approval.sessionScope ? `：${approval.sessionScope}` : ""}`}
							icon="checkmark-done"
							variant="outline"
							small
							onPress={() => respond({ decision: "allow_session" })}
						/>
					) : null}
				</View>
			)}
		</View>
	);
}

function DialogCard({ request, respond }: { request: UiRequest; respond: (r: UiResponse) => void }) {
	const p = usePalette();
	const [value, setValue] = useState(request.prefill ?? "");
	const countdown = useCountdown(request.expiresAt);
	const label = request.kind === "confirm" ? "确认" : request.kind === "select" ? "选择" : "输入";
	return (
		<View style={[styles.card, FLOAT_SHADOW, { backgroundColor: p.card, borderColor: p.accent }]}>
			<CardTitle
				icon={request.kind === "confirm" ? "help-circle" : request.kind === "select" ? "list" : "create"}
				label={label}
				title={request.title}
				color={p.accent}
				soft={p.accentSoft}
				countdown={countdown ? `${countdown} 后超时` : undefined}
			/>
			{request.message ? <Text style={[styles.reason, { color: p.muted }]}>{request.message}</Text> : null}
			{request.kind === "confirm" ? (
				<View style={styles.row}>
					<Button title="是" variant="primary" small style={styles.grow} onPress={() => respond({ confirmed: true })} />
					<Button title="否" small style={styles.grow} onPress={() => respond({ confirmed: false })} />
				</View>
			) : request.kind === "select" ? (
				<View style={styles.actions}>
					{(request.options ?? []).map((option) => (
						<Button key={option} title={option} small onPress={() => respond({ value: option })} />
					))}
					<Button title="取消" variant="ghost" small onPress={() => respond({ cancelled: true })} />
				</View>
			) : (
				<View style={styles.actions}>
					<TextInput
						value={value}
						onChangeText={setValue}
						multiline={request.kind === "editor"}
						placeholder={request.placeholder ?? ""}
						placeholderTextColor={p.faint}
						style={[
							styles.input,
							request.kind === "editor" && styles.editor,
							{ color: p.text, borderColor: p.border, backgroundColor: p.bg },
						]}
					/>
					<View style={styles.row}>
						<Button title="提交" variant="primary" small style={styles.grow} onPress={() => respond({ value })} />
						<Button title="取消" small onPress={() => respond({ cancelled: true })} />
					</View>
				</View>
			)}
		</View>
	);
}

/** Dialogs and approvals waiting for an answer, shown above the composer. */
export function PendingRequests({
	requests,
	respond,
}: {
	requests: UiRequest[];
	respond: (requestId: string, response: UiResponse) => void;
}) {
	if (!requests.length) return null;
	return (
		<View style={styles.list}>
			{requests.map((request) =>
				request.kind === "approval" ? (
					<ApprovalCard key={request.id} request={request} respond={(r) => respond(request.id, r)} />
				) : (
					<DialogCard key={request.id} request={request} respond={(r) => respond(request.id, r)} />
				),
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	list: { gap: 10, paddingHorizontal: 12, paddingTop: 8 },
	card: { borderWidth: 1, borderRadius: RADIUS.lg, padding: 14, gap: 12 },
	titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
	titleIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
	badge: { fontSize: 11.5, fontWeight: "700", letterSpacing: 0.2 },
	tool: { fontSize: 15, fontWeight: "700" },
	countdownPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		paddingHorizontal: 8,
		paddingVertical: 3,
		borderRadius: RADIUS.pill,
	},
	countdown: { fontSize: 11.5, fontWeight: "600" },
	summary: {
		fontFamily: MONO,
		fontSize: 12.5,
		lineHeight: 18,
		padding: 12,
		borderRadius: RADIUS.md,
		overflow: "hidden",
	},
	reason: { fontSize: 13, lineHeight: 18 },
	actions: { gap: 8 },
	row: { flexDirection: "row", gap: 8 },
	grow: { flex: 1 },
	input: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
	editor: { minHeight: 100, textAlignVertical: "top" },
});
