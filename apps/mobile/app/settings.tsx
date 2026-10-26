import { type BenchResult, runChannelBenchmark } from "@pier/crypto";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppearanceSettings } from "../src/components/AppearanceSettings.tsx";
import { UpdateSettingsCard } from "../src/components/Update.tsx";
import { Button, Card, CardHeader, Icon, Muted, Screen } from "../src/components/ui.tsx";
import { APP_VERSION, useMobileState, useStore } from "../src/store.ts";
import { MONO, PAGE, RADIUS, usePalette } from "../src/theme.ts";

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
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

	useEffect(() => setName(deviceName), [deviceName]);

	const runBench = async () => {
		setRunning(true);
		setBench([]);
		// Yield between cases so the UI stays responsive.
		try {
			await runChannelBenchmark({
				budgetMs: 700,
				onProgress: async (result) => {
					setBench((current) => [...(current ?? []), result]);
					await new Promise((resolve) => setTimeout(resolve, 30));
				},
			});
		} catch {
			store.toast("error", "性能测试未完成，请重试");
		} finally {
			setRunning(false);
		}
	};

	return (
		<Screen safeBottom>
			<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
				<View style={styles.heading}>
					<View style={[styles.headingIcon, { backgroundColor: p.accentSoft }]}>
						<Icon name="options-outline" size={26} color={p.accentText} />
					</View>
					<View style={styles.headingCopy}>
						<Text style={[styles.headingTitle, { color: p.text }]}>让 Pier 更合你的习惯</Text>
						<Muted>管理外观、设备与应用更新。</Muted>
					</View>
				</View>
				<Text style={[styles.sectionTitle, { color: p.muted }]}>偏好设置</Text>
				<AppearanceSettings />
				<Text style={[styles.sectionTitle, { color: p.muted }]}>设备与配对</Text>
				<Card style={styles.card}>
					<CardHeader icon="phone-portrait-outline" title="设备身份" subtitle="让你的电脑更容易认出这台设备" />
					<Text style={[styles.fieldLabel, { color: p.text }]}>设备名称</Text>
					<TextInput
						value={name}
						onChangeText={setName}
						maxLength={100}
						style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
						selectionColor={p.accent}
						accessibilityLabel="设备名称"
					/>
					<View style={styles.saveRow}>
						<Muted style={styles.saveHint}>新名称将在下次配对时使用。</Muted>
						<Button
							title="保存名称"
							variant="primary"
							small
							disabled={!name.trim() || name.trim() === deviceName}
							onPress={() => void store.setDeviceName(name)}
						/>
					</View>
					<View style={[styles.fingerprintBox, { backgroundColor: p.elevated }]}>
						<View style={styles.fingerprintHeading}>
							<Icon name="shield-checkmark-outline" size={15} color={p.accentText} />
							<Text style={[styles.fieldLabel, { color: p.text }]}>设备密钥指纹</Text>
						</View>
						<Text selectable style={[styles.mono, { color: p.text }]}>
							{fingerprint}
						</Text>
						<Muted style={styles.fingerprintLabel}>配对时，请与电脑上显示的指纹核对。</Muted>
					</View>
				</Card>

				<Text style={[styles.sectionTitle, { color: p.muted }]}>更新与关于</Text>
				<UpdateSettingsCard />

				<Card style={styles.card}>
					<CardHeader
						icon="information-circle-outline"
						title="Pier Mobile"
						subtitle={`版本 ${APP_VERSION} · 构建 ${Constants.expoConfig?.version ?? "?"}`}
					/>
					<Muted>
						编码 Agent 的跨设备工作台。 从手机连接多台电脑，查看和驱动 pi、Claude Code 与 Codex 的会话。Agent
						始终运行在电脑上，模型与凭据使用各自的 Agent 配置。远程连接采用端到端加密，只有配对过的设备能连接。
					</Muted>
				</Card>
				<Text style={[styles.sectionTitle, { color: p.muted }]}>诊断工具</Text>
				<Card style={styles.card}>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="加密性能测试"
						accessibilityState={{ expanded: diagnosticsOpen }}
						aria-expanded={diagnosticsOpen}
						onPress={() => setDiagnosticsOpen(!diagnosticsOpen)}
						style={({ pressed }) => [styles.diagnosticToggle, pressed && { opacity: 0.7 }]}
					>
						<CardHeader
							icon="speedometer-outline"
							title="加密性能测试"
							subtitle="测量这台设备的加密与握手速度"
							tone="muted"
							right={<Icon name={diagnosticsOpen ? "chevron-up" : "chevron-down"} size={18} color={p.muted} />}
						/>
					</Pressable>
					{diagnosticsOpen ? (
						<View style={styles.diagnostics}>
							<Muted>
								{engine()} · {Device.modelName ?? Platform.OS}
							</Muted>
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
						</View>
					) : null}
				</Card>
			</ScrollView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	content: { ...PAGE, padding: 20, paddingBottom: 48, gap: 14 },
	card: { gap: 16 },
	heading: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 8 },
	headingIcon: { width: 52, height: 52, borderRadius: RADIUS.lg, alignItems: "center", justifyContent: "center" },
	headingCopy: { flex: 1, gap: 5 },
	headingTitle: { fontSize: 19, fontWeight: "700", letterSpacing: -0.5 },
	sectionTitle: { fontSize: 12, fontWeight: "600", marginTop: 10, marginLeft: 2, letterSpacing: 0.5 },
	fieldLabel: { fontSize: 13, fontWeight: "500" },
	saveRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 },
	saveHint: { flex: 1, minWidth: 130, fontSize: 12 },
	fingerprintHeading: { flexDirection: "row", gap: 7, alignItems: "center" },
	diagnosticToggle: { minHeight: 48, justifyContent: "center" },
	diagnostics: { gap: 14 },
	input: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
	mono: { fontFamily: MONO, fontSize: 13, letterSpacing: 0.5 },
	fingerprintBox: { borderRadius: RADIUS.md, padding: 14, gap: 10 },
	fingerprintLabel: { fontSize: 12 },
	bench: { borderRadius: RADIUS.md, padding: 12, gap: 4 },
	benchLine: { fontFamily: MONO, fontSize: 12 },
});
