import type { PairingPhase } from "@pier/client";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAvoider } from "../src/components/KeyboardAvoider.tsx";
import { Button, Card, CardHeader, Icon, Muted, Screen, Title } from "../src/components/ui.tsx";
import { pairingErrorText, useMobileState, useStore } from "../src/store.ts";
import { MONO, RADIUS, usePalette } from "../src/theme.ts";

/** Corner brackets drawn over the camera preview. */
function ScanFrame({ color }: { color: string }) {
	return (
		<View style={styles.frame} pointerEvents="none">
			<View style={[styles.corner, styles.topLeft, { borderColor: color }]} />
			<View style={[styles.corner, styles.topRight, { borderColor: color }]} />
			<View style={[styles.corner, styles.bottomLeft, { borderColor: color }]} />
			<View style={[styles.corner, styles.bottomRight, { borderColor: color }]} />
		</View>
	);
}

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
			<KeyboardAvoider style={styles.flex}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					{phase.kind === "busy" ? (
						<Card style={styles.status}>
							<View style={[styles.statusIcon, { backgroundColor: p.accentSoft }]}>
								{phase.phase === "connecting" ? (
									<ActivityIndicator color={p.accent} size="large" />
								) : (
									<Icon name="desktop-outline" size={30} color={p.accent} />
								)}
							</View>
							<Title style={styles.center}>
								{phase.phase === "connecting"
									? `正在连接${phase.hostName ? `“${phase.hostName}”` : "电脑"}…`
									: "请在电脑上点击“允许连接”"}
							</Title>
							{phase.phase === "waitingForApproval" ? (
								<>
									<Muted style={styles.center}>确认电脑上显示的设备指纹与下面一致：</Muted>
									<Text style={[styles.fingerprint, { color: p.text, backgroundColor: p.elevated }]}>
										{fingerprint}
									</Text>
									<ActivityIndicator color={p.accent} />
								</>
							) : null}
						</Card>
					) : null}

					{phase.kind === "error" ? (
						<Card style={[styles.status, { borderColor: p.danger }]}>
							<View style={[styles.statusIcon, { backgroundColor: p.dangerSoft }]}>
								<Icon name="close-circle-outline" size={32} color={p.danger} />
							</View>
							<Title style={styles.center}>配对失败</Title>
							<Muted style={styles.center}>{phase.message}</Muted>
							<Button
								title="重新扫描"
								icon="scan-outline"
								variant="primary"
								onPress={() => setPhase({ kind: "scan" })}
							/>
						</Card>
					) : null}

					{scanning ? (
						<>
							<View style={styles.intro}>
								<Title style={styles.introTitle}>扫码配对</Title>
								<Muted>扫描电脑上 Pier“手机与远程访问”中显示的二维码。</Muted>
							</View>
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
									<ScanFrame color="#ffffff" />
									<View style={styles.cameraHint} pointerEvents="none">
										<Icon name="qr-code-outline" size={14} color="#fff" />
										<Text style={styles.cameraHintText}>将二维码放入框内</Text>
									</View>
								</View>
							) : (
								<Card style={styles.status}>
									<View style={[styles.statusIcon, { backgroundColor: p.accentSoft }]}>
										<Icon name="camera-outline" size={30} color={p.accent} />
									</View>
									<Muted style={styles.center}>需要相机权限才能扫码。你也可以在下方粘贴配对链接。</Muted>
									<Button
										title="允许使用相机"
										icon="camera"
										variant="primary"
										onPress={() => void requestPermission()}
									/>
								</Card>
							)}
							<Card style={styles.manual}>
								<CardHeader
									icon="link-outline"
									title="粘贴配对链接"
									subtitle="在电脑上点“复制配对链接”，再粘贴到这里"
								/>
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
										icon="clipboard-outline"
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
			</KeyboardAvoider>
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	content: { padding: 16, gap: 14 },
	intro: { gap: 4, paddingHorizontal: 4 },
	introTitle: { fontSize: 22, fontWeight: "800" },
	cameraBox: {
		aspectRatio: 1,
		borderRadius: 28,
		overflow: "hidden",
		borderWidth: StyleSheet.hairlineWidth,
		backgroundColor: "#000",
	},
	camera: { flex: 1 },
	frame: { position: "absolute", top: "18%", left: "18%", right: "18%", bottom: "18%" },
	corner: { position: "absolute", width: 34, height: 34 },
	topLeft: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 },
	topRight: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 },
	bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 },
	bottomRight: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 },
	cameraHint: {
		position: "absolute",
		bottom: 16,
		alignSelf: "center",
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 12,
		paddingVertical: 6,
		borderRadius: RADIUS.pill,
		backgroundColor: "rgba(0,0,0,0.5)",
	},
	cameraHintText: { color: "#fff", fontSize: 12.5, fontWeight: "600" },
	status: { gap: 14, alignItems: "stretch", paddingVertical: 26 },
	statusIcon: {
		alignSelf: "center",
		width: 72,
		height: 72,
		borderRadius: 24,
		alignItems: "center",
		justifyContent: "center",
	},
	center: { textAlign: "center" },
	fingerprint: {
		fontFamily: MONO,
		fontSize: 18,
		textAlign: "center",
		letterSpacing: 1,
		paddingVertical: 12,
		borderRadius: RADIUS.md,
		overflow: "hidden",
	},
	manual: { gap: 12 },
	input: {
		borderWidth: 1,
		borderRadius: RADIUS.md,
		paddingHorizontal: 14,
		paddingVertical: 12,
		fontSize: 14,
		fontFamily: MONO,
	},
	row: { flexDirection: "row", gap: 8 },
});
