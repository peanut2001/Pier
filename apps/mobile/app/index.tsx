import { Stack, useRouter } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { UpdateBanner } from "../src/components/Update.tsx";
import {
	Avatar,
	Button,
	Card,
	confirmDestructive,
	HeaderAction,
	Muted,
	Pill,
	Screen,
	SectionLabel,
	StatusDot,
	Title,
} from "../src/components/ui.tsx";
import { relativeTime } from "../src/format.ts";
import type { PairedHost } from "../src/hosts.ts";
import { useMobileState, useStore } from "../src/store.ts";
import { usePalette } from "../src/theme.ts";

function HostRow({ host }: { host: PairedHost }) {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const active = useMobileState((s) => (s.host.hostId === host.hostId ? s.host.connection : undefined));
	const revoked = useMobileState((s) => s.host.hostId === host.hostId && s.host.revoked);
	const dot = revoked ? p.danger : active === "open" ? p.ok : active ? p.warning : p.faint;
	return (
		<Pressable
			testID={`host-${host.hostId}`}
			onPress={() => router.push({ pathname: "/host/[hostId]", params: { hostId: host.hostId } })}
			onLongPress={() =>
				confirmDestructive(
					`移除“${host.hostName}”？`,
					"只会删除这台手机上的配对信息。要彻底撤销访问，请在电脑的“手机与远程访问”中移除这台设备。",
					"移除",
					() => void store.forgetHost(host.hostId),
				)
			}
			style={({ pressed }) => pressed && styles.pressed}
		>
			<Card style={styles.hostCard}>
				<Avatar name={host.hostName} size={46}>
					<View style={styles.avatarDot}>
						<StatusDot color={dot} size={12} ring={p.card} />
					</View>
				</Avatar>
				<View style={styles.hostMain}>
					<Text style={[styles.hostName, { color: p.text }]} numberOfLines={1}>
						{host.hostName}
					</Text>
					<Muted>
						{revoked
							? "已被电脑移除，需要重新配对"
							: active === "open"
								? "已连接"
								: host.lastConnectedAt
									? `上次连接 ${relativeTime(host.lastConnectedAt)}`
									: `配对于 ${relativeTime(host.pairedAt)}`}
					</Muted>
				</View>
				{revoked ? <Pill text="需重新配对" tone="danger" /> : null}
				<Text style={[styles.chevron, { color: p.faint }]}>›</Text>
			</Card>
		</Pressable>
	);
}

export default function Home() {
	const router = useRouter();
	const p = usePalette();
	const ready = useMobileState((s) => s.ready);
	const hosts = useMobileState((s) => s.hosts);
	return (
		<Screen>
			<Stack.Screen
				options={{
					headerRight: () => <HeaderAction label="设置" onPress={() => router.push("/settings")} />,
				}}
			/>
			{!ready ? (
				<ActivityIndicator style={styles.loading} color={p.accent} />
			) : (
				<FlatList
					data={hosts}
					keyExtractor={(h) => h.hostId}
					contentContainerStyle={styles.list}
					renderItem={({ item }) => <HostRow host={item} />}
					ListHeaderComponent={
						<>
							<UpdateBanner />
							{hosts.length ? <SectionLabel>我的电脑</SectionLabel> : null}
						</>
					}
					ListEmptyComponent={
						<View style={styles.empty}>
							<View style={[styles.hero, { backgroundColor: p.accentSoft }]}>
								<Text style={[styles.heroGlyph, { color: p.accent }]}>💻</Text>
							</View>
							<Title style={[styles.center, styles.emptyTitle]}>连接你的电脑</Title>
							<Muted style={styles.center}>
								在电脑上的 Pier 中打开“手机”→ 开启远程访问 →
								显示配对二维码，然后在这里扫码。手机需要和电脑在同一局域网（或同一 Tailscale 网络）。
							</Muted>
						</View>
					}
					ListFooterComponent={
						<Button
							title="添加电脑"
							icon="+"
							variant={hosts.length ? "tonal" : "primary"}
							onPress={() => router.push("/pair")}
							testID="add-host"
							style={styles.add}
						/>
					}
				/>
			)}
		</Screen>
	);
}

const styles = StyleSheet.create({
	loading: { marginTop: 48 },
	list: { padding: 16, gap: 12, flexGrow: 1 },
	pressed: { opacity: 0.75, transform: [{ scale: 0.99 }] },
	hostCard: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 14 },
	avatarDot: { position: "absolute", right: -3, bottom: -3 },
	hostMain: { flex: 1, gap: 3 },
	hostName: { fontSize: 17, fontWeight: "700" },
	chevron: { fontSize: 26, marginTop: -3 },
	empty: { gap: 12, paddingTop: 56, paddingBottom: 24, paddingHorizontal: 12, alignItems: "center" },
	hero: { width: 84, height: 84, borderRadius: 28, alignItems: "center", justifyContent: "center", marginBottom: 8 },
	heroGlyph: { fontSize: 38, fontWeight: "600" },
	emptyTitle: { fontSize: 22 },
	center: { textAlign: "center" },
	add: { marginTop: 8 },
});
