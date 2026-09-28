import type { ChatController } from "@pier/chat-state";
import type { ImageInput } from "@pier/protocol";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { isBusy } from "../format.ts";
import { useStore } from "../store.ts";
import { usePalette } from "../theme.ts";

const MAX_IMAGES = 8;

export function Composer({ chat, runState }: { chat: ChatController; runState: string }) {
	const store = useStore();
	const p = usePalette();
	const [text, setText] = useState(() => store.draft(chat.sessionId));
	const [images, setImages] = useState<ImageInput[]>([]);
	const [sending, setSending] = useState(false);
	const busy = isBusy(runState as never);
	const canSend = (text.trim().length > 0 || images.length > 0) && !sending;

	const update = (value: string) => {
		setText(value);
		store.saveDraft(chat.sessionId, value);
	};

	const pickImages = async () => {
		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ["images"],
			allowsMultipleSelection: true,
			selectionLimit: MAX_IMAGES - images.length,
			base64: true,
			quality: 0.7,
		});
		if (result.canceled) return;
		const picked = result.assets
			.filter((asset) => asset.base64)
			.map((asset) => ({
				type: "image" as const,
				data: asset.base64 as string,
				mimeType: asset.mimeType?.startsWith("image/") ? asset.mimeType : "image/jpeg",
			}));
		setImages((current) => [...current, ...picked].slice(0, MAX_IMAGES));
	};

	const send = async (mode: "auto" | "steer" | "followUp") => {
		if (!canSend) return;
		setSending(true);
		const body = text.trim();
		const result = await chat.send(body, images, mode);
		setSending(false);
		if (result !== undefined) {
			update("");
			setImages([]);
		}
	};

	return (
		<View style={[styles.root, { borderColor: p.border, backgroundColor: p.card }]}>
			{images.length ? (
				<ScrollView horizontal style={styles.images} contentContainerStyle={styles.imagesContent}>
					{images.map((image, index) => (
						<Pressable
							// biome-ignore lint/suspicious/noArrayIndexKey: attachments have no id.
							key={index}
							onPress={() => setImages(images.filter((_, i) => i !== index))}
							accessibilityLabel="移除图片"
						>
							<Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={styles.thumb} />
							<Text style={styles.remove}>×</Text>
						</Pressable>
					))}
				</ScrollView>
			) : null}
			<View style={styles.row}>
				<Pressable onPress={() => void pickImages()} style={styles.iconButton} accessibilityLabel="添加图片">
					<Text style={[styles.icon, { color: p.muted }]}>＋</Text>
				</Pressable>
				<TextInput
					testID="composer-input"
					value={text}
					onChangeText={update}
					multiline
					placeholder={busy ? "引导 Agent，或排队下一条…" : "给 Agent 发消息"}
					placeholderTextColor={p.faint}
					style={[styles.input, { color: p.text, backgroundColor: p.bg, borderColor: p.border }]}
				/>
				{busy && !canSend ? (
					<Pressable
						onPress={() => void chat.abort()}
						style={[styles.send, { backgroundColor: p.dangerSoft }]}
						accessibilityLabel="中止"
						testID="abort-button"
					>
						<Text style={[styles.sendText, { color: p.danger }]}>■</Text>
					</Pressable>
				) : (
					<Pressable
						onPress={() => void send("auto")}
						disabled={!canSend}
						style={[styles.send, { backgroundColor: canSend ? p.accent : p.elevated }]}
						accessibilityLabel={busy ? "引导" : "发送"}
						testID="send-button"
					>
						<Text style={[styles.sendText, { color: canSend ? p.onAccent : p.faint }]}>↑</Text>
					</Pressable>
				)}
			</View>
			{busy && canSend ? (
				<View style={styles.modes}>
					<Text style={[styles.hint, { color: p.muted }]}>Agent 正在运行：↑ 立即引导</Text>
					<Pressable onPress={() => void send("followUp")}>
						<Text style={[styles.link, { color: p.accent }]}>改为排队到结束后</Text>
					</Pressable>
					<Pressable onPress={() => void chat.abort()}>
						<Text style={[styles.link, { color: p.danger }]}>中止</Text>
					</Pressable>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8, gap: 6 },
	row: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
	iconButton: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
	icon: { fontSize: 24 },
	input: {
		flex: 1,
		minHeight: 40,
		maxHeight: 140,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: 20,
		paddingHorizontal: 14,
		paddingTop: 10,
		paddingBottom: 10,
		fontSize: 15,
	},
	send: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
	sendText: { fontSize: 18, fontWeight: "700" },
	modes: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 44 },
	hint: { fontSize: 12, flex: 1 },
	link: { fontSize: 13, fontWeight: "600" },
	images: { maxHeight: 72 },
	imagesContent: { gap: 6, paddingHorizontal: 42 },
	thumb: { width: 64, height: 64, borderRadius: 8 },
	remove: {
		position: "absolute",
		top: 2,
		right: 4,
		color: "#fff",
		fontWeight: "700",
		textShadowColor: "#000",
		textShadowRadius: 3,
	},
});
