import { type ChatController, resolveSlash, runBuiltin, type SlashActions } from "@pier/chat-state";
import type { ImageInput } from "@pier/protocol";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { isBusy } from "../format.ts";
import { useStore } from "../store.ts";
import { SHADOW, usePalette } from "../theme.ts";
import { type SlashEntry, SlashMenu, useSlashMenu } from "./SlashMenu.tsx";

const MAX_IMAGES = 8;

export function Composer({ chat, runState }: { chat: ChatController; runState: string }) {
	const store = useStore();
	const router = useRouter();
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
	const menu = useSlashMenu(chat, text);

	const openSession = (session: { id: string; workspaceId: string } | undefined) => {
		const hostId = store.getState().host.hostId;
		if (!session || !hostId) return false;
		router.push({
			pathname: "/host/[hostId]/session/[sessionId]",
			params: { hostId, sessionId: session.id, workspaceId: session.workspaceId },
		});
		return true;
	};
	const actions: SlashActions = {
		newSession: async () => openSession(await store.createSession(chat.workspaceId)),
		fork: async (entryId) => openSession(await store.forkSession(chat.sessionId, entryId)),
		notify: (level, message) => store.toast(level === "error" ? "error" : "info", message),
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

	const send = async (mode: "auto" | "steer" | "followUp", override?: string) => {
		const body = (override ?? text).trim();
		if (sending || (!body && !images.length)) return;
		let resolution = resolveSlash(body, menu.list.commands, menu.list.known);
		if (resolution.kind === "unknown" || (resolution.kind === "host" && !menu.list.known)) {
			const fresh = await chat.loadCommands();
			resolution = resolveSlash(body, fresh.commands, fresh.known);
		}
		if (resolution.kind === "unknown") {
			store.toast("error", `未知命令 /${resolution.name}，输入 / 查看可用的命令`);
			return;
		}
		setSending(true);
		if (resolution.kind === "builtin") {
			const previous = override ?? text;
			update("");
			const result = await runBuiltin(chat, resolution.name, resolution.args, actions);
			setSending(false);
			if (result.kind === "failed") update(previous);
			else if (result.kind === "complete") update(result.text);
			return;
		}
		const result =
			resolution.kind === "host" ? await chat.sendCommand(body, images, mode) : await chat.send(body, images, mode);
		setSending(false);
		if (result !== undefined) {
			update("");
			setImages([]);
		}
	};

	const pick = (entry: SlashEntry) => {
		const next = entry.pick();
		if (next.run) void send(busy ? "steer" : "auto", next.text);
		else update(next.text);
	};

	return (
		<View style={[styles.root, { backgroundColor: p.bg }]}>
			<SlashMenu menu={menu} onPick={pick} />
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
			<View style={[styles.row, SHADOW, { backgroundColor: p.card, borderColor: p.border }]}>
				<Pressable
					onPress={() => void pickImages()}
					style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? p.border : p.elevated }]}
					accessibilityLabel="添加图片"
				>
					<Text style={[styles.icon, { color: p.muted }]}>+</Text>
				</Pressable>
				<TextInput
					testID="composer-input"
					value={text}
					onChangeText={update}
					multiline
					placeholder={busy ? "引导 Agent，或排队下一条…" : "给 Agent 发消息，/ 使用命令"}
					placeholderTextColor={p.faint}
					style={[styles.input, { color: p.text }]}
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
	root: { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 8, gap: 6 },
	row: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 6,
		padding: 5,
		borderRadius: 25,
		borderWidth: StyleSheet.hairlineWidth,
	},
	iconButton: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
	icon: { fontSize: 22, fontWeight: "500", marginTop: -2 },
	input: {
		flex: 1,
		minHeight: 38,
		maxHeight: 140,
		paddingHorizontal: 6,
		paddingTop: 9,
		paddingBottom: 9,
		fontSize: 15.5,
	},
	send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
	sendText: { fontSize: 18, fontWeight: "800" },
	modes: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 12 },
	hint: { fontSize: 12, flex: 1 },
	link: { fontSize: 13, fontWeight: "600" },
	images: { maxHeight: 72 },
	imagesContent: { gap: 8, paddingHorizontal: 4 },
	thumb: { width: 64, height: 64, borderRadius: 12 },
	remove: {
		position: "absolute",
		top: 4,
		right: 4,
		width: 20,
		height: 20,
		borderRadius: 10,
		overflow: "hidden",
		backgroundColor: "rgba(0,0,0,0.6)",
		color: "#fff",
		fontSize: 14,
		lineHeight: 20,
		textAlign: "center",
		fontWeight: "700",
	},
});
