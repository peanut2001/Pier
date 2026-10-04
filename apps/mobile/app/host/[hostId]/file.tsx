import type { WorkspaceFileContent } from "@pier/protocol";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Image,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoider } from "../../../src/components/KeyboardAvoider.tsx";
import {
	ActionSheet,
	Button,
	HeaderAction,
	Icon,
	Muted,
	Screen,
	type SheetAction,
} from "../../../src/components/ui.tsx";
import { absolutePath, baseName, formatSize, relativeTime, shortPath } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, RADIUS, usePalette } from "../../../src/theme.ts";
import { canSaveToPhone, saveToPhone } from "../../../src/transfers.ts";

/** Larger text files are shown but not edited on the phone. */
const MAX_EDIT_BYTES = 256 * 1024;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}

/** Preview of one workspace file: text (editable), image, or file details for anything else. */
export default function FileScreen() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const { width } = useWindowDimensions();
	const { hostId, workspaceId, path, edit } = useLocalSearchParams<{
		hostId: string;
		workspaceId: string;
		path: string;
		edit?: string;
	}>();
	const workspace = useMobileState((s) =>
		s.host.hostId === hostId ? s.host.workspaces?.find((w) => w.id === workspaceId) : undefined,
	);
	const online = useMobileState((s) => s.host.hostId === hostId && s.host.connection === "open");
	const [file, setFile] = useState<WorkspaceFileContent>();
	const [error, setError] = useState<string>();
	const [menu, setMenu] = useState(false);
	const [draft, setDraft] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [progress, setProgress] = useState<string>();
	const [imageRatio, setImageRatio] = useState(1);

	const load = useCallback(async () => {
		try {
			const result = await store.readFile(workspaceId, path);
			setFile(result);
			setError(undefined);
			return result;
		} catch (e) {
			setError(errorText(e));
			return undefined;
		}
	}, [store, workspaceId, path]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per connection; `edit` only applies to the first load.
	useEffect(() => {
		if (!online || file) return;
		void load().then((result) => {
			if (edit && result?.kind === "text" && !result.truncated) setDraft(result.text ?? "");
		});
	}, [online, load]);

	const lines = useMemo(() => (file?.kind === "text" ? (file.text ?? "").split("\n") : []), [file]);
	const name = baseName(path);
	const editable =
		store.canEditFiles() && file?.kind === "text" && !file.truncated && (file.size ?? 0) <= MAX_EDIT_BYTES;
	const editing = draft !== undefined;
	const fullPath = workspace ? absolutePath(workspace.path, path) : path;

	const save = async () => {
		if (!file || draft === undefined) return;
		setSaving(true);
		try {
			const result = await store.writeFile(workspaceId, path, draft, file.modifiedAt);
			setFile({ ...file, text: draft, size: result.size, modifiedAt: result.modifiedAt });
			setDraft(undefined);
			store.toast("info", `已保存 ${name}`);
		} catch (e) {
			store.toast(
				"error",
				errorCode(e) === "CONFLICT"
					? "文件在电脑上被修改过，为避免覆盖没有保存。请复制你的修改，重新打开文件后再编辑。"
					: `保存失败：${errorText(e)}`,
			);
		} finally {
			setSaving(false);
		}
	};

	const actions: SheetAction[] = [];
	if (editable && !editing) {
		actions.push({
			label: "编辑",
			description: "在手机上修改并保存到电脑",
			icon: "create-outline",
			onPress: () => setDraft(file?.text ?? ""),
		});
	}
	if (store.canTransferFiles() && canSaveToPhone) {
		actions.push({
			label: "下载到手机",
			description: "选择手机上的一个文件夹保存",
			icon: "download-outline",
			onPress: () => void saveToPhone(store, workspaceId, path, setProgress),
		});
	}
	if (file?.kind === "text") {
		actions.push({
			label: "复制内容",
			description: file.truncated ? "只包含已加载的部分" : undefined,
			icon: "clipboard-outline",
			onPress: async () => {
				await Clipboard.setStringAsync(file.text ?? "");
				store.toast("info", "已复制内容");
			},
		});
	}
	actions.push({
		label: "复制路径",
		description: shortPath(fullPath),
		icon: "copy-outline",
		onPress: async () => {
			await Clipboard.setStringAsync(fullPath);
			store.toast("info", "已复制路径");
		},
	});
	actions.push({
		label: "重新加载",
		icon: "refresh",
		onPress: () => {
			setDraft(undefined);
			void load();
		},
	});
	if (store.canEditFiles()) {
		actions.push({
			label: "删除",
			description: "永久删除，不进入回收站",
			icon: "trash-outline",
			danger: true,
			confirm: {
				title: `删除“${name}”？`,
				message: "文件会被永久删除，不会进入电脑的废纸篓 / 回收站。",
				action: "删除",
			},
			onPress: async () => {
				if (await store.deletePath(workspaceId, path)) {
					store.toast("info", `已删除 ${name}`);
					router.back();
				}
			},
		});
	}

	let body: React.ReactNode;
	if (error) {
		body = (
			<View style={styles.center}>
				<Icon name="alert-circle-outline" size={28} color={p.danger} />
				<Text style={[styles.errorText, { color: p.danger }]}>{error}</Text>
				<Button title="重试" icon="refresh" small variant="tonal" onPress={() => void load()} />
			</View>
		);
	} else if (!file) {
		body = (
			<View style={styles.center}>
				{online ? <ActivityIndicator color={p.accent} /> : <Muted>等待连接到电脑…</Muted>}
			</View>
		);
	} else if (editing) {
		body = (
			<TextInput
				testID="file-editor"
				value={draft}
				onChangeText={setDraft}
				multiline
				autoCapitalize="none"
				autoCorrect={false}
				spellCheck={false}
				textAlignVertical="top"
				scrollEnabled
				style={[styles.editor, { color: p.codeText, backgroundColor: p.code }]}
			/>
		);
	} else if (file.kind === "text") {
		const digits = String(lines.length).length;
		body = (
			<FlatList
				style={[styles.flex, { backgroundColor: p.code }]}
				contentContainerStyle={[styles.code, { paddingBottom: insets.bottom + 24 }]}
				data={lines}
				keyExtractor={(_, index) => String(index)}
				initialNumToRender={60}
				windowSize={11}
				renderItem={({ item, index }) => (
					<View style={styles.line}>
						<Text style={[styles.lineNo, { color: p.faint, width: digits * 7.5 + 8 }]}>{index + 1}</Text>
						<Text selectable style={[styles.lineText, { color: p.codeText }]}>
							{item || " "}
						</Text>
					</View>
				)}
				ListFooterComponent={
					file.truncated ? (
						<Muted style={styles.note}>
							文件较大，只显示了开头部分（共 {formatSize(file.size)}）。可以下载到手机查看完整内容。
						</Muted>
					) : null
				}
			/>
		);
	} else if (file.kind === "image" && file.data) {
		body = (
			<ScrollView contentContainerStyle={styles.imageBox} maximumZoomScale={5} minimumZoomScale={1} centerContent>
				<Image
					source={{ uri: `data:${file.mimeType ?? "image/png"};base64,${file.data}` }}
					onLoad={(e) => {
						const { width: w, height: h } = e.nativeEvent.source;
						if (w && h) setImageRatio(w / h);
					}}
					style={{ width: width - 32, aspectRatio: imageRatio, borderRadius: RADIUS.md }}
					resizeMode="contain"
				/>
			</ScrollView>
		);
	} else {
		body = (
			<View style={styles.center}>
				<Icon name={file.kind === "image" ? "image-outline" : "document-outline"} size={40} color={p.faint} />
				<Text style={[styles.binaryTitle, { color: p.text }]}>{name}</Text>
				<Muted style={styles.centerText}>
					{file.kind === "image" ? "图片太大，无法预览。" : "这个文件不是文本，无法预览。"}
				</Muted>
				{store.canTransferFiles() && canSaveToPhone ? (
					<Button
						title="下载到手机"
						icon="download-outline"
						variant="tonal"
						onPress={() => void saveToPhone(store, workspaceId, path, setProgress)}
					/>
				) : null}
			</View>
		);
	}

	return (
		<Screen>
			<Stack.Screen
				options={{
					title: name,
					headerRight: () =>
						editing ? (
							<View style={styles.headerButtons}>
								<HeaderAction label="取消编辑" text="取消" onPress={() => setDraft(undefined)} />
								<HeaderAction
									label="保存"
									icon="checkmark"
									text={saving ? "保存中" : "保存"}
									onPress={() => void save()}
								/>
							</View>
						) : file || error ? (
							<HeaderAction label="文件操作" icon="ellipsis-horizontal" onPress={() => setMenu(true)} />
						) : null,
				}}
			/>
			<View style={[styles.info, { borderColor: p.border }]}>
				<Text style={[styles.infoText, { color: p.faint }]} numberOfLines={1} ellipsizeMode="head">
					{shortPath(fullPath)}
				</Text>
				{file ? (
					<Text style={[styles.infoText, { color: p.faint }]}>
						{formatSize(file.size)} · {relativeTime(file.modifiedAt)}
					</Text>
				) : null}
			</View>
			{progress ? (
				<View style={[styles.progress, { backgroundColor: p.accentSoft }]}>
					<ActivityIndicator size="small" color={p.accent} />
					<Text style={[styles.progressText, { color: p.accent }]}>{progress}</Text>
				</View>
			) : null}
			<KeyboardAvoider style={styles.flex} topOffset={insets.top + 44}>
				{body}
			</KeyboardAvoider>
			{menu ? <ActionSheet title={name} actions={actions} onClose={() => setMenu(false)} /> : null}
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
	centerText: { textAlign: "center" },
	errorText: { fontSize: 13.5, textAlign: "center" },
	binaryTitle: { fontSize: 16, fontWeight: "600" },
	info: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 16,
		paddingBottom: 8,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	infoText: { fontSize: 11.5, fontFamily: MONO, flexShrink: 1 },
	progress: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		margin: 12,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: RADIUS.md,
	},
	progressText: { flex: 1, fontSize: 13, fontWeight: "600" },
	code: { paddingVertical: 10, paddingRight: 12 },
	line: { flexDirection: "row" },
	lineNo: { fontFamily: MONO, fontSize: 11.5, lineHeight: 18, textAlign: "right", paddingRight: 8 },
	lineText: { flex: 1, fontFamily: MONO, fontSize: 12, lineHeight: 18 },
	note: { padding: 16, fontSize: 12.5 },
	editor: { flex: 1, fontFamily: MONO, fontSize: 13, lineHeight: 19, padding: 12 },
	imageBox: { padding: 16, alignItems: "center" },
	headerButtons: { flexDirection: "row", gap: 6 },
});
