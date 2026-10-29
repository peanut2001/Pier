import { requireSpeechClient } from "@pier/chat-state";
import type { PierClient } from "@pier/client";
import { SpeechMethodSchemas, type SpeechStatus } from "@pier/protocol";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { usePalette } from "../theme.ts";
import { Button, CardHeader, Muted, Sheet } from "./ui.tsx";

export function SpeechSettings({ client, onClose }: { client: PierClient | undefined; onClose: () => void }) {
	const p = usePalette();
	const [settings, setSettings] = useState<SpeechStatus>();
	const [key, setKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				const result = await requireSpeechClient(client).request("speech.status");
				if (active) setSettings(result);
			} catch (error) {
				if (active) setMessage(error instanceof Error ? error.message : "读取失败");
			}
		})();
		return () => {
			active = false;
		};
	}, [client]);
	return (
		<Sheet onClose={onClose}>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
				<CardHeader icon="mic-outline" title="语音输入" subtitle="配置当前电脑的语音识别服务" />
				<Muted>录音发送到你配置的语音转文字服务，设置保存在当前连接的电脑。每次最多 2 分钟，识别后可编辑再发送。</Muted>
				{settings ? (
					<>
						{(
							[
								{ key: "url", label: "接口地址", placeholder: "https://example.com/v1/audio/transcriptions" },
								{ key: "model", label: "模型", placeholder: "whisper-1" },
								{ key: "language", label: "识别语言", placeholder: "自动检测（或 zh / en）" },
							] as const
						).map((field) => (
							<View key={field.key} style={styles.field}>
								<Text style={{ color: p.text }}>{field.label}</Text>
								<TextInput
									accessibilityLabel={field.label}
									value={settings[field.key]}
									placeholder={field.placeholder}
									placeholderTextColor={p.faint}
									autoCapitalize="none"
									autoCorrect={false}
									editable={!pending}
									style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.elevated }]}
									onChangeText={(value) => setSettings({ ...settings, [field.key]: value })}
								/>
							</View>
						))}
						<Muted>填写完整的 OpenAI 兼容转写地址；更换地址时请重新填写 API Key。地址留空可停用。</Muted>
						<Text style={{ color: p.text }}>API Key</Text>
						<TextInput
							accessibilityLabel="语音 API Key"
							value={key}
							secureTextEntry
							autoCapitalize="none"
							autoCorrect={false}
							editable={!pending && !removeKey}
							placeholder={settings.hasApiKey ? "已保存，留空保留" : "本地服务可留空"}
							placeholderTextColor={p.faint}
							style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.elevated }]}
							onChangeText={setKey}
						/>
						{settings.hasApiKey ? (
							<View style={styles.row}>
								<Text style={{ color: p.text }}>移除已保存的 API Key</Text>
								<Switch
									accessibilityLabel="移除已保存的 API Key"
									value={removeKey}
									disabled={pending}
									onValueChange={setRemoveKey}
								/>
							</View>
						) : null}
						<Button
							title="保存语音设置"
							variant="primary"
							loading={pending}
							onPress={async () => {
								setPending(true);
								setMessage("");
								try {
									const parsed = SpeechMethodSchemas["speech.configure"].safeParse({
										...settings,
										apiKey: removeKey ? "" : key || undefined,
									});
									if (!parsed.success)
										throw new Error("请检查接口地址、模型和语言代码（留空或填写 zh、en 等两字母代码）");
									const result = await requireSpeechClient(client).request("speech.configure", parsed.data);
									setSettings(result);
									setKey("");
									setRemoveKey(false);
									setMessage("语音设置已保存");
								} catch (error) {
									setMessage(error instanceof Error ? error.message : "保存失败");
								} finally {
									setPending(false);
								}
							}}
						/>
					</>
				) : null}
				{message ? (
					<Text accessibilityLiveRegion="polite" style={{ color: p.text }}>
						{message}
					</Text>
				) : null}
				<Button title="关闭" variant="ghost" onPress={onClose} />
			</ScrollView>
		</Sheet>
	);
}

const styles = StyleSheet.create({
	form: { padding: 24, gap: 18 },
	field: { gap: 8 },
	input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
	row: { flexDirection: "row", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "center" },
});
