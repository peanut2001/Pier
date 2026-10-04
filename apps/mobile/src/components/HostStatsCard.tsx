import type { HostStats } from "@pier/protocol";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { formatPercent, formatRate, formatSize, formatUptime } from "../format.ts";
import { useMobileState, useStore } from "../store.ts";
import { type Palette, RADIUS, usePalette } from "../theme.ts";
import { Card, Icon, Muted } from "./ui.tsx";

/** How often the usage refreshes while the card is on screen. */
const POLL_MS = 3000;

function ratio(used: number, total: number): number {
	return total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
}

/** Share of the space usable by the user that is taken, like `df`. */
function diskRatio(disk: NonNullable<HostStats["disk"]>): number {
	return ratio(disk.used, disk.used + disk.available);
}

function levelColor(p: Palette, value: number): string {
	return value >= 0.9 ? p.danger : value >= 0.75 ? p.warning : p.accent;
}

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
	const p = usePalette();
	const color = levelColor(p, value);
	return (
		<View style={styles.meter}>
			<View style={styles.meterHead}>
				<Text style={[styles.meterLabel, { color: p.muted }]}>{label}</Text>
				<Text style={[styles.meterValue, { color }]}>{formatPercent(value)}</Text>
			</View>
			<View style={[styles.track, { backgroundColor: p.elevated }]}>
				<View style={[styles.fill, { backgroundColor: color, width: `${Math.max(2, Math.round(value * 100))}%` }]} />
			</View>
			<Text style={[styles.meterDetail, { color: p.faint }]} numberOfLines={1}>
				{detail}
			</Text>
		</View>
	);
}

/** CPU, memory, disk and network usage of the connected computer, refreshed while on screen. */
export function HostStatsCard() {
	const store = useStore();
	const p = usePalette();
	const online = useMobileState((s) => s.host.connection === "open");
	const supported = useMobileState((s) => !!s.host.info) && store.canReadHostStats();
	const [stats, setStats] = useState<HostStats>();
	const [error, setError] = useState<string>();

	useFocusEffect(
		useCallback(() => {
			if (!online || !supported) return;
			let alive = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const tick = async () => {
				try {
					const next = await store.hostStats();
					if (!alive) return;
					setStats(next);
					setError(undefined);
				} catch (e) {
					if (alive) setError(e instanceof Error ? e.message : String(e));
				}
				if (alive) timer = setTimeout(() => void tick(), POLL_MS);
			};
			void tick();
			return () => {
				alive = false;
				clearTimeout(timer);
			};
		}, [online, supported, store]),
	);

	if (!online || !supported) return null;
	if (!stats) {
		return (
			<Card flat style={styles.card}>
				<View style={styles.head}>
					<Icon name="pulse-outline" size={16} color={p.muted} />
					<Text style={[styles.title, { color: p.text }]}>主机状态</Text>
				</View>
				<Muted style={styles.hint}>{error ? `读取资源占用失败：${error}` : "正在读取资源占用…"}</Muted>
			</Card>
		);
	}
	const memory = ratio(stats.memory.used, stats.memory.total);
	return (
		<Card flat style={styles.card}>
			<View style={styles.head}>
				<Icon name="pulse-outline" size={16} color={p.muted} />
				<Text style={[styles.title, { color: p.text }]}>主机状态</Text>
				<Text style={[styles.uptime, { color: p.faint }]} numberOfLines={1}>
					已运行 {formatUptime(stats.uptime)}
				</Text>
			</View>
			<View style={styles.meters}>
				<Meter
					label="CPU"
					value={stats.cpu.usage}
					detail={[`${stats.cpu.cores} 核`, stats.cpu.loadAverage ? `负载 ${stats.cpu.loadAverage[0].toFixed(2)}` : ""]
						.filter(Boolean)
						.join(" · ")}
				/>
				<Meter
					label="内存"
					value={memory}
					detail={`${formatSize(stats.memory.used)} / ${formatSize(stats.memory.total)}`}
				/>
				{stats.disk ? (
					<Meter
						label="磁盘"
						value={diskRatio(stats.disk)}
						detail={`${formatSize(stats.disk.used)} / ${formatSize(stats.disk.used + stats.disk.available)}`}
					/>
				) : null}
			</View>
			<View style={[styles.foot, { borderColor: p.border }]}>
				{stats.network ? (
					<>
						<Icon name="arrow-down" size={13} color={p.muted} />
						<Text style={[styles.footText, { color: p.muted }]}>{formatRate(stats.network.rxRate)}</Text>
						<Icon name="arrow-up" size={13} color={p.muted} style={styles.gap} />
						<Text style={[styles.footText, { color: p.muted }]}>{formatRate(stats.network.txRate)}</Text>
					</>
				) : null}
				<Text style={[styles.footText, styles.right, { color: p.faint }]} numberOfLines={1}>
					Pier 占用 {formatSize(stats.hostRss)}
				</Text>
			</View>
		</Card>
	);
}

const styles = StyleSheet.create({
	card: { gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
	head: { flexDirection: "row", alignItems: "center", gap: 6 },
	title: { fontSize: 14.5, fontWeight: "600" },
	uptime: { flex: 1, textAlign: "right", fontSize: 12 },
	hint: { fontSize: 12.5 },
	meters: { flexDirection: "row", gap: 12 },
	meter: { flex: 1, gap: 5 },
	meterHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
	meterLabel: { fontSize: 12, fontWeight: "600" },
	meterValue: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
	track: { height: 5, borderRadius: RADIUS.pill, overflow: "hidden" },
	fill: { height: 5, borderRadius: RADIUS.pill },
	meterDetail: { fontSize: 11 },
	foot: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		paddingTop: 10,
		borderTopWidth: StyleSheet.hairlineWidth,
	},
	footText: { fontSize: 12, fontVariant: ["tabular-nums"] },
	gap: { marginLeft: 8 },
	right: { flex: 1, textAlign: "right" },
});
