import { type BenchResult, runChannelBenchmark } from "@pier/crypto";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { UpdateSettingsCard } from "../src/components/Update.tsx";
import { Button, Card, CardHeader, Muted, Screen } from "../src/components/ui.tsx";
import { APP_VERSION, useMobileState, useStore } from "../src/store.ts";
import { MONO, RADIUS, usePalette } from "../src/theme.ts";

function engine(): string {
	const hermes = (globalThis as { HermesInternal?: { getRuntimeProperties?: () => Record<string, string> } })
		.HermesInternal;
	if (hermes) {
		const version = hermes.getRuntimeProperties?.()["OSS Release Version"];
		return `Hermes${version ? ` ${version}` : ""}`;
	}
	return Platform.OS === "web" ? "浏览器 JS 引擎" : "JSC";
}

export default function Settings() {
	const store = useStore();
	const p = usePalette();
	const deviceName = useMobileState((s) => s.deviceName);
	const fingerprint = useMobileState((s) => s.fingerprint);
	const [name, setName] = useState(deviceName);
	const [bench, setBench] = useState<BenchResult[] | undefined>();
	const [running, setRunning] = useState(false);

	useEffect(() => setName(deviceName), [deviceName]);

	const runBench = async () => {
		setRunning(true);
		setBench([]);
		// Yield between cases so the UI stays responsive.
		await runChannelBenchmark({
			budgetMs: 700,
			onProgress: async (result) => {
				setBench((current) => [...(current ?? []), result]);
				await new Promise((resolve) => setTimeout(resolve, 30));
			},
		});
		setRunning(false);
	};

	return (
		<Screen>
			<ScrollView contentContainerStyle={styles.content}>
				<Card style={styles.card}>
					<CardHeader
						icon="phone-portrait-outline"
						title="这台设备"
						subtitle="配对时电脑上显示的名称（之后再配对的电脑生效）"
					/>
					<TextInput
						value={name}
						onChangeText={setName}
						maxLength={100}
						style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
					/>
					<Button
						title="保存名称"
						small
						disabled={!name.trim() || name.trim() === deviceName}
						onPress={() => void store.setDeviceName(name)}
					/>
					<View style={[styles.fingerprintBox, { backgroundColor: p.elevated }]}>
						<Muted style={styles.fingerprintLabel}>设备密钥指纹 · 配对时与电脑上显示的核对</Muted>
						<Text selectable style={[styles.mono, { color: p.text }]}>
							{fingerprint}
						</Text>
					</View>
				</Card>

				<Card style={styles.card}>
					<CardHeader
						icon="speedometer-outline"
						title="加密性能测试"
						subtitle={`测量本机的 Noise 握手与帧加解密速度 · ${engine()} · ${Device.modelName ?? Platform.OS}`}
					/>
					<Button title="运行测试" icon="play" loading={running} onPress={() => void runBench()} />
					{bench?.length ? (
						<View style={[styles.bench, { backgroundColor: p.code }]}>
							{bench.map((r) => (
								<Text key={r.name} selectable style={[styles.benchLine, { color: p.codeText }]}>
									{r.name}: {r.meanMs.toFixed(2)} ms
									{r.mibPerSecond !== undefined ? ` · ${r.mibPerSecond.toFixed(1)} MiB/s` : ""}
								</Text>
							))}
						</View>
					) : null}
				</Card>

				<UpdateSettingsCard />

				<Card style={styles.card}>
					<CardHeader icon="information-circle-outline" title="关于" />
					<Muted>
						Pier Mobile {APP_VERSION}（{Constants.expoConfig?.version ?? "?"}）。编码 Agent 的跨设备工作台。
						从手机连接多台电脑，查看和驱动 pi、Claude Code 与 Codex 的会话。Agent 始终运行在电脑上，模型与凭据使用各自的
						Agent 配置。远程连接采用端到端加密，只有配对过的设备能连接。
					</Muted>
				</Card>
			</ScrollView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	content: { padding: 16, paddingBottom: 40, gap: 14 },
	card: { gap: 12 },
	input: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
	mono: { fontFamily: MONO, fontSize: 16, letterSpacing: 1 },
	fingerprintBox: { borderRadius: RADIUS.md, padding: 12, gap: 4 },
	fingerprintLabel: { fontSize: 12 },
	bench: { borderRadius: RADIUS.md, padding: 12, gap: 4 },
	benchLine: { fontFamily: MONO, fontSize: 12 },
});
