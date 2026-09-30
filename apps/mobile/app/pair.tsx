import type { PairingPhase } from "@pier/client";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { Button, Card, Muted, Screen, Title } from "../src/components/ui.tsx";
import { pairingErrorText, useMobileState, useStore } from "../src/store.ts";
import { MONO, usePalette } from "../src/theme.ts";

type Phase =
	| { kind: "scan" }
	| { kind: "busy"; phase: PairingPhase; hostName?: string }
	| { kind: "error"; message: string };

/** Rebuild the pairing link when the app was opened through a `pier://pair?...` deep link. */
function uriFromParams(params: Record<string, string | string[] | undefined>): string | undefined {
	if (!params.code || !params.pk) return undefined;
	const query = Object.entries(params)
		.filter(([k, v]) => typeof v === "string" && k !== "from")
		.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
		.join("&");
	return `pier://pair?${query}`;
}

export default function Pair() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const params = useLocalSearchParams();
	const fingerprint = useMobileState((s) => s.fingerprint);
	const ready = useMobileState((s) => s.ready);
	const [permission, requestPermission] = useCameraPermissions();
	const [phase, setPhase] = useState<Phase>({ kind: "scan" });
	const [manual, setManual] = useState("");
	const busy = useRef(false);

	const start = useCallback(
		async (uri: string) => {
			if (busy.current) return;
			busy.current = true;
			const hostName = /[?&]name=([^&]*)/.exec(uri)?.[1];
			setPhase({ kind: "busy", phase: "connecting", ...(hostName ? { hostName: decodeURIComponent(hostName) } : {}) });
			try {
				const hostId = await store.pair(uri, (next) =>
					setPhase((current) => (current.kind === "busy" ? { ...current, phase: next } : current)),
				);
				store.toast("info", "配对成功");
				// Opened from that host's screen (re-pair after revocation): just go back to it.
				if (params.from === hostId && router.canGoBack()) router.back();
				else router.replace({ pathname: "/host/[hostId]", params: { hostId } });
			} catch (error) {
				setPhase({ kind: "error", message: pairingErrorText(error) });
			} finally {
				busy.current = false;
			}
		},
		[store, router, params.from],
	);

	useEffect(() => {
		const uri = uriFromParams(params);
		if (uri && ready) void start(uri);
	}, [params, ready, start]);

	const scanning = phase.kind === "scan";
	return (
		<Screen>
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					{phase.kind === "busy" ? (
						<Card style={styles.status}>
							<ActivityIndicator color={p.accent} size="large" />
							<Title style={styles.center}>
								{phase.phase === "connecting"
									? `正在连接${phase.hostName ? `“${phase.hostName}”` : "电脑"}…`
									: "请在电脑上点击“允许连接”"}
							</Title>
							{phase.phase === "waitingForApproval" ? (
								<>
									<Muted style={styles.center}>确认电脑上显示的设备指纹与下面一致：</Muted>
									<Text style={[styles.fingerprint, { color: p.text }]}>{fingerprint}</Text>
								</>
							) : null}
						</Card>
					) : null}

					{phase.kind === "error" ? (
						<Card style={[styles.status, { borderColor: p.danger }]}>
							<Title style={styles.center}>配对失败</Title>
							<Muted style={styles.center}>{phase.message}</Muted>
							<Button title="重新扫描" variant="primary" onPress={() => setPhase({ kind: "scan" })} />
						</Card>
					) : null}

					{scanning ? (
						<>
							<Muted>扫描电脑上 Pier“手机与远程访问”中显示的二维码。</Muted>
							{Platform.OS === "web" ? null : !permission ? (
								<ActivityIndicator color={p.accent} />
							) : permission.granted ? (
								<View style={[styles.cameraBox, { borderColor: p.border }]}>
									<CameraView
										style={styles.camera}
										facing="back"
										barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
										onBarcodeScanned={({ data }) => {
											if (data.startsWith("pier://pair")) void start(data);
										}}
									/>
								</View>
							) : (
								<Card style={styles.status}>
									<Muted style={styles.center}>需要相机权限才能扫码。你也可以在下方粘贴配对链接。</Muted>
									<Button title="允许使用相机" variant="primary" onPress={() => void requestPermission()} />
								</Card>
							)}
							<Card style={styles.manual}>
								<Muted>或粘贴配对链接（电脑上“复制配对链接”）：</Muted>
								<TextInput
									testID="pair-uri-input"
									value={manual}
									onChangeText={setManual}
									placeholder="pier://pair?..."
									placeholderTextColor={p.faint}
									autoCapitalize="none"
									autoCorrect={false}
									style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
								/>
								<View style={styles.row}>
									<Button
										title="粘贴"
										small
										onPress={async () => setManual((await Clipboard.getStringAsync()).trim())}
									/>
									<Button
										title="连接"
										variant="primary"
										small
										style={styles.flex}
										disabled={!manual.trim().startsWith("pier://")}
										onPress={() => void start(manual.trim())}
										testID="pair-connect"
									/>
								</View>
							</Card>
						</>
					) : null}
				</ScrollView>
			</KeyboardAvoidingView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	content: { padding: 16, gap: 14 },
	cameraBox: { aspectRatio: 1, borderRadius: 24, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
	camera: { flex: 1 },
	status: { gap: 14, alignItems: "stretch", paddingVertical: 24 },
	center: { textAlign: "center" },
	fingerprint: { fontFamily: MONO, fontSize: 18, textAlign: "center", letterSpacing: 1 },
	manual: { gap: 10 },
	input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14 },
	row: { flexDirection: "row", gap: 8 },
});
