import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { relativeTime } from "../format.ts";
import { RADIUS, usePalette } from "../theme.ts";
import { formatBytes } from "../update-manifest.ts";
import { pendingUpdate, type UpdateStatus, updater, useUpdateStatus } from "../updater.ts";
import { Markdown } from "./Markdown.tsx";
import { Button, Card, CardHeader, Icon, Muted } from "./ui.tsx";

function ProgressBar({ status }: { status: UpdateStatus }) {
	const p = usePalette();
	const total = status.total ?? status.update?.size ?? 0;
	const ratio = total > 0 ? Math.min(1, status.downloaded / total) : 0;
	return (
		<View style={[styles.track, { backgroundColor: p.elevated }]}>
			<View style={[styles.fill, { backgroundColor: p.accent, width: `${Math.round(ratio * 100)}%` }]} />
		</View>
	);
}

function progressText(status: UpdateStatus): string {
	const total = status.total ?? status.update?.size;
	if (!total) return `正在下载 ${formatBytes(status.downloaded)}…`;
	const percent = Math.floor((Math.min(status.downloaded, total) / total) * 100);
	return `正在下载 ${percent}%（${formatBytes(status.downloaded)} / ${formatBytes(total)}）`;
}

/** The main action for a known update: download and install, install, or cancel the download. */
function UpdateAction({ status, small }: { status: UpdateStatus; small?: boolean }) {
	switch (status.state) {
		case "downloading":
			return <Button title="取消下载" small={small} onPress={() => updater.cancel()} />;
		case "installing":
			return <Button title="正在打开安装程序" small={small} variant="primary" loading onPress={() => {}} />;
		case "ready":
			return <Button title="安装" small={small} variant="primary" onPress={() => void updater.install()} />;
		default:
			return (
				<Button
					title={status.state === "error" ? "重试" : "下载并安装"}
					small={small}
					variant="primary"
					disabled={status.state === "checking"}
					onPress={() => void updater.install()}
				/>
			);
	}
}

/** Home screen banner while a new version is available. */
export function UpdateBanner() {
	const router = useRouter();
	const p = usePalette();
	const status = useUpdateStatus();
	const update = pendingUpdate(status);
	if (!update) return null;
	return (
		<Pressable onPress={() => router.push("/settings")} style={({ pressed }) => pressed && styles.pressed}>
			<Card flat style={[styles.banner, { backgroundColor: p.accentSoft, borderColor: p.accentSoft }]}>
				<View style={[styles.bannerIcon, { backgroundColor: p.accent }]}>
					<Icon name="rocket-outline" size={18} color={p.onAccent} />
				</View>
				<View style={styles.bannerText}>
					<Text style={[styles.bannerTitle, { color: p.text }]}>发现新版本 v{update.version}</Text>
					<Muted>
						{status.state === "downloading"
							? progressText(status)
							: status.state === "error"
								? (status.error ?? "更新失败")
								: `点击查看更新内容 · ${formatBytes(update.size)}`}
					</Muted>
					{status.state === "downloading" ? <ProgressBar status={status} /> : null}
				</View>
				<View style={styles.bannerActions}>
					<UpdateAction status={status} small />
					{status.state === "available" ? (
						<Button title="忽略" small variant="ghost" onPress={() => void updater.skip(update.version)} />
					) : null}
				</View>
			</Card>
		</Pressable>
	);
}

function statusLine(status: UpdateStatus): string {
	switch (status.state) {
		case "unsupported":
			return status.unsupportedReason ?? "当前版本不支持应用内更新。";
		case "idle":
			return "尚未检查更新。";
		case "checking":
			return "正在检查更新…";
		case "upToDate":
			return "已是最新版本。";
		case "downloading":
			return progressText(status);
		case "ready":
			return "安装包已下载并校验，点击“安装”完成更新。";
		case "installing":
			return "请在系统安装界面中确认更新。";
		case "error":
			return status.error ?? "更新失败。";
		default:
			return status.update ? `发现新版本 v${status.update.version}（${formatBytes(status.update.size)}）。` : "";
	}
}

/** "软件更新" card on the settings screen. */
export function UpdateSettingsCard() {
	const p = usePalette();
	const status = useUpdateStatus();
	const { update } = status;
	const supported = status.state !== "unsupported";
	const busy = status.state === "checking" || status.state === "downloading" || status.state === "installing";
	const skipped = update !== undefined && status.skippedVersion === update.version;
	return (
		<Card style={styles.card}>
			<CardHeader
				icon="cloud-download-outline"
				title="软件更新"
				subtitle={`当前版本 v${status.currentVersion}${status.lastChecked ? ` · 上次检查 ${relativeTime(status.lastChecked)}` : ""}`}
			/>
			<Text style={[styles.status, { color: status.state === "error" ? p.danger : p.text }]}>{statusLine(status)}</Text>
			{status.state === "downloading" ? <ProgressBar status={status} /> : null}

			{update ? (
				<View style={[styles.notes, { borderColor: p.border }]}>
					<Text style={[styles.notesTitle, { color: p.text }]}>
						v{update.version} 更新内容{update.date ? ` · ${new Date(update.date).toLocaleDateString()}` : ""}
					</Text>
					{update.notes ? <Markdown text={update.notes} /> : <Muted>没有发布说明。</Muted>}
				</View>
			) : null}

			{supported ? (
				<View style={styles.actions}>
					{update ? <UpdateAction status={status} small /> : null}
					<Button
						title="检查更新"
						small
						loading={status.state === "checking"}
						disabled={busy}
						onPress={() => void updater.check()}
					/>
					{update && status.state !== "downloading" ? (
						<Button
							title={skipped ? "恢复提醒" : "不再提醒此版本"}
							small
							variant="ghost"
							onPress={() => void updater.skip(skipped ? undefined : update.version)}
						/>
					) : null}
				</View>
			) : null}

			{supported ? (
				<>
					<View style={styles.switchRow}>
						<Text style={[styles.switchLabel, { color: p.text }]}>自动检查更新</Text>
						<Switch
							value={status.autoCheck}
							onValueChange={(value) => void updater.setAutoCheck(value)}
							trackColor={{ true: p.accent, false: p.elevated }}
							thumbColor="#fff"
						/>
					</View>
					<Muted>
						启动时和每隔几小时检查 GitHub 上的最新正式版。安装包下载后先核对大小与校验值，再交给系统安装；Android
						会校验签名，只接受 Pier 官方签名的安装包。首次更新时系统会要求允许 Pier 安装应用。更新不会清除已配对的电脑。
					</Muted>
				</>
			) : null}
		</Card>
	);
}

const styles = StyleSheet.create({
	pressed: { opacity: 0.8 },
	banner: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
	bannerIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
	bannerText: { flex: 1, gap: 4 },
	bannerTitle: { fontSize: 15, fontWeight: "700" },
	bannerActions: { alignItems: "flex-end", gap: 4 },
	card: { gap: 12 },
	status: { fontSize: 14, lineHeight: 20 },
	track: { height: 6, borderRadius: RADIUS.pill, overflow: "hidden" },
	fill: { height: 6, borderRadius: RADIUS.pill },
	notes: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: 12, gap: 6 },

	notesTitle: { fontSize: 14, fontWeight: "700" },
	actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
	switchLabel: { fontSize: 15, fontWeight: "600" },
});
