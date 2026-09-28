import { type BenchResult, runChannelBenchmark } from "@pier/crypto";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Card, Muted, Screen, Title } from "../src/components/ui.tsx";
import { APP_VERSION, useMobileState, useStore } from "../src/store.ts";
import { MONO, usePalette } from "../src/theme.ts";

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
					<Title>这台设备</Title>
					<Muted>配对时电脑上显示的名称（之后再配对的电脑生效）。</Muted>
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
					<Muted>设备密钥指纹（配对时与电脑上显示的核对）：</Muted>
					<Text selectable style={[styles.mono, { color: p.text }]}>
						{fingerprint}
					</Text>
				</Card>

				<Card style={styles.card}>
					<Title>加密性能测试</Title>
					<Muted>
						测量本机的 Noise 握手与帧加解密速度（Spike 3）。{engine()} · {Device.modelName ?? Platform.OS}
					</Muted>
					<Button title="运行测试" loading={running} onPress={() => void runBench()} />
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

				<Card style={styles.card}>
					<Title>关于</Title>
					<Muted>
						Pier Mobile {APP_VERSION}（{Constants.expoConfig?.version ?? "?"}）。手机只是遥控器：Agent
						始终运行在你的电脑上， 模型与凭据保存在电脑的 pi 配置中。连接使用 Noise
						协议端到端加密，只有配对过的设备能连接。
					</Muted>
				</Card>
			</ScrollView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	content: { padding: 16, gap: 14 },
	card: { gap: 10 },
	input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
	mono: { fontFamily: MONO, fontSize: 16, letterSpacing: 1 },
	bench: { borderRadius: 8, padding: 10, gap: 4 },
	benchLine: { fontFamily: MONO, fontSize: 12 },
});
