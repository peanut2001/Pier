import { Link, Stack, useRouter } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Button, Card, confirmDestructive, Muted, Screen, StatusDot, Title } from "../src/components/ui.tsx";
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
		>
			<Card style={styles.hostCard}>
				<StatusDot color={dot} size={10} />
				<View style={styles.hostMain}>
					<Title>{host.hostName}</Title>
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
				<Text style={{ color: p.faint, fontSize: 22 }}>›</Text>
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
					headerRight: () => (
						<Link href="/settings" asChild>
							<Pressable hitSlop={10} accessibilityLabel="设置">
								<Text style={{ color: p.accent, fontSize: 16 }}>设置</Text>
							</Pressable>
						</Link>
					),
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
					ListEmptyComponent={
						<View style={styles.empty}>
							<Title style={styles.center}>连接你的电脑</Title>
							<Muted style={styles.center}>
								在电脑上的 Pier 中打开“手机”→ 开启远程访问 →
								显示配对二维码，然后在这里扫码。手机需要和电脑在同一局域网（或同一 Tailscale 网络）。
							</Muted>
						</View>
					}
					ListFooterComponent={
						<Button title="添加电脑" variant="primary" onPress={() => router.push("/pair")} testID="add-host" />
					}
				/>
			)}
		</Screen>
	);
}

const styles = StyleSheet.create({
	loading: { marginTop: 48 },
	list: { padding: 16, gap: 12 },
	hostCard: { flexDirection: "row", alignItems: "center", gap: 12 },
	hostMain: { flex: 1, gap: 2 },
	empty: { gap: 10, paddingVertical: 32, paddingHorizontal: 8 },
	center: { textAlign: "center" },
});
