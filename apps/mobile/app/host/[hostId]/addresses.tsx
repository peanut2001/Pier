import { fromBase64Url, keyFingerprint } from "@pier/crypto";
import { addressPort, DEFAULT_PIER_PORT, parsePeerAddresses } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { Button, Card, Muted, Screen, Title } from "../../../src/components/ui.tsx";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, usePalette } from "../../../src/theme.ts";

function fingerprintOf(publicKey: string | undefined): string {
	if (!publicKey) return "";
	try {
		return keyFingerprint(fromBase64Url(publicKey));
	} catch {
		return "";
	}
}

/** Edit the addresses used to reach a paired computer, e.g. after its IP changed. */
export default function HostAddresses() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const { hostId } = useLocalSearchParams<{ hostId: string }>();
	const host = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId));
	const [text, setText] = useState(() => host?.addresses.join("\n") ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const fingerprint = useMemo(() => fingerprintOf(host?.hostPublicKey), [host?.hostPublicKey]);

	if (!host) {
		return (
			<Screen>
				<Stack.Screen options={{ title: "连接地址" }} />
				<Muted style={styles.missing}>这台电脑已不在列表中。</Muted>
			</Screen>
		);
	}

	const defaultPort = addressPort(host.addresses[0]) ?? DEFAULT_PIER_PORT;
	const { addresses, invalid } = parsePeerAddresses(text, defaultPort);
	const unchanged = addresses.join(",") === host.addresses.join(",");
	const save = async () => {
		if (busy || invalid.length || !addresses.length) return;
		if (unchanged) {
			router.back();
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await store.setHostAddresses(host.hostId, addresses);
			store.toast("info", "已保存，正在用新地址连接");
			router.back();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};

	return (
		<Screen>
			<Stack.Screen options={{ title: `${host.hostName} 的地址` }} />
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<Card style={styles.card}>
						<Title>连接地址</Title>
						<Muted>
							电脑的 IP 变了时在这里修改，不用重新配对。每行一个地址，格式为 IP:端口（省略端口时使用 {defaultPort}
							），连接时按顺序尝试；也可以填域名或 Tailscale 地址。电脑上的地址可以在 Pier 的「设置 →
							设备与远程」中看到。
						</Muted>
						<TextInput
							testID="host-addresses-input"
							value={text}
							onChangeText={(value) => {
								setText(value);
								setError(undefined);
							}}
							multiline
							editable={!busy}
							placeholder={`192.168.1.20:${defaultPort}`}
							placeholderTextColor={p.faint}
							autoCapitalize="none"
							autoCorrect={false}
							textAlignVertical="top"
							style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
						/>
						{invalid.length ? (
							<Text style={[styles.small, { color: p.danger }]}>无法识别的地址：{invalid.join("、")}</Text>
						) : !addresses.length ? (
							<Muted>至少需要一个地址。</Muted>
						) : (
							<Muted>
								将依次尝试：<Text style={styles.mono}>{addresses.join("、")}</Text>
							</Muted>
						)}
						{fingerprint ? (
							<Muted>
								只会连接密钥指纹为 <Text style={styles.mono}>{fingerprint}</Text>{" "}
								的电脑；地址上如果是另一台电脑，连接会被拒绝。
							</Muted>
						) : null}
						{error ? <Text style={[styles.small, { color: p.danger }]}>{error}</Text> : null}
						<Button
							title="保存并重新连接"
							variant="primary"
							loading={busy}
							disabled={invalid.length > 0 || !addresses.length}
							onPress={() => void save()}
							testID="host-addresses-save"
						/>
					</Card>
				</ScrollView>
			</KeyboardAvoidingView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	content: { padding: 16, gap: 14 },
	card: { gap: 10 },
	missing: { padding: 24, textAlign: "center" },
	input: {
		borderWidth: 1,
		borderRadius: 12,
		paddingHorizontal: 12,
		paddingVertical: 11,
		fontSize: 14,
		fontFamily: MONO,
		minHeight: 110,
	},
	small: { fontSize: 13 },
	mono: { fontFamily: MONO },
});
