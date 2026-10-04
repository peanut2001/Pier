import type { WorkspaceFileEntry, WorkspaceFilesResult } from "@pier/protocol";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import {
	ActionSheet,
	confirmDestructive,
	HeaderAction,
	Icon,
	type IconName,
	Muted,
	PromptSheet,
	Screen,
	type SheetAction,
} from "../../../src/components/ui.tsx";
import { absolutePath, baseName, childPath, formatSize, relativeTime, shortPath } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, RADIUS, usePalette } from "../../../src/theme.ts";
import { canSaveToPhone, type PickedFile, pickDocuments, pickMedia, saveToPhone } from "../../../src/transfers.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|heic)$/i;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|json|rs|py|go|java|kt|swift|c|h|cpp|cc|rb|php|sh|toml|ya?ml|css|html|xml|sql)$/i;

function entryIcon(entry: WorkspaceFileEntry): IconName {
	if (entry.kind === "directory") return entry.symlink ? "link" : "folder";
	if (entry.kind === "other") return entry.symlink ? "link-outline" : "help-circle-outline";
	if (IMAGE.test(entry.name)) return "image-outline";
	if (/\.md$/i.test(entry.name)) return "document-text-outline";
	if (CODE.test(entry.name)) return "code-slash-outline";
	return "document-outline";
}

/** One directory of a workspace: browse, open, upload, download and delete files. */
export default function FilesScreen() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const {
		hostId,
		workspaceId,
		path = "",
	} = useLocalSearchParams<{
		hostId: string;
		workspaceId: string;
		path?: string;
	}>();
	const workspace = useMobileState((s) =>
		s.host.hostId === hostId ? s.host.workspaces?.find((w) => w.id === workspaceId) : undefined,
	);
	const online = useMobileState((s) => s.host.hostId === hostId && s.host.connection === "open");
	const [listing, setListing] = useState<WorkspaceFilesResult>();
	const [error, setError] = useState<string>();
	const [refreshing, setRefreshing] = useState(false);
	const [menu, setMenu] = useState<WorkspaceFileEntry>();
	const [addMenu, setAddMenu] = useState(false);
	const [naming, setNaming] = useState(false);
	const [progress, setProgress] = useState<string>();
	const request = useRef(0);

	const load = useCallback(async () => {
		const id = ++request.current;
		try {
			const result = await store.listFiles(workspaceId, path);
			if (request.current !== id) return;
			setListing(result);
			setError(undefined);
		} catch (e) {
			if (request.current === id) setError(errorText(e));
		}
	}, [store, workspaceId, path]);

	// Reload on return, e.g. after deleting or editing a file in the viewer.
	useFocusEffect(
		useCallback(() => {
			if (online) void load();
		}, [online, load]),
	);

	const title = path ? baseName(path) : (workspace?.name ?? "文件");
	const canTransfer = store.canTransferFiles();
	const canEdit = store.canEditFiles();

	const openEntry = (entry: WorkspaceFileEntry) => {
		if (entry.kind === "directory") {
			router.push({ pathname: "/host/[hostId]/files", params: { hostId, workspaceId, path: entry.path } });
		} else if (entry.kind === "file") {
			router.push({ pathname: "/host/[hostId]/file", params: { hostId, workspaceId, path: entry.path } });
		}
	};

	const upload = async (files: PickedFile[]) => {
		if (!files.length) return;
		const existing = new Set((listing?.entries ?? []).map((e) => e.name));
		const run = async () => {
			let done = 0;
			for (const file of files) {
				const source = file.open();
				try {
					await store.uploadFile(workspaceId, childPath(path, file.name), source, {
						overwrite: existing.has(file.name),
						onProgress: (sent) =>
							setProgress(
								`正在上传 ${file.name}${files.length > 1 ? `（${done + 1}/${files.length}）` : ""}：${
									source.size ? Math.round((sent / source.size) * 100) : 100
								}%`,
							),
					});
					done += 1;
				} catch (e) {
					store.toast("error", `上传 ${file.name} 失败：${errorText(e)}`);
				} finally {
					source.close();
				}
			}
			setProgress(undefined);
			if (done) store.toast("info", done === 1 ? `已上传 ${files[0]?.name}` : `已上传 ${done} 个文件`);
			void load();
		};
		const replaced = files.filter((f) => existing.has(f.name)).map((f) => f.name);
		if (replaced.length) {
			confirmDestructive(
				"替换同名文件？",
				`这个目录中已经有 ${replaced.slice(0, 3).join("、")}${replaced.length > 3 ? ` 等 ${replaced.length} 个文件` : ""}，上传会覆盖它们。`,
				"替换",
				() => void run(),
			);
		} else await run();
	};

	const pick = (from: "documents" | "media") => {
		// Let the action sheet finish closing before the system picker presents (iOS).
		setTimeout(async () => {
			try {
				await upload(from === "documents" ? await pickDocuments() : await pickMedia());
			} catch (e) {
				store.toast("error", `无法选择文件：${errorText(e)}`);
			}
		}, 350);
	};

	const entryActions = (entry: WorkspaceFileEntry): SheetAction[] => {
		const actions: SheetAction[] = [];
		if (entry.kind === "file" && canTransfer && canSaveToPhone) {
			actions.push({
				label: "下载到手机",
				description: "选择手机上的一个文件夹保存",
				icon: "download-outline",
				onPress: () => void saveToPhone(store, workspaceId, entry.path, setProgress),
			});
		}
		actions.push({
			label: "复制路径",
			description: workspace ? shortPath(absolutePath(workspace.path, entry.path)) : entry.path,
			icon: "copy-outline",
			onPress: async () => {
				await Clipboard.setStringAsync(workspace ? absolutePath(workspace.path, entry.path) : entry.path);
				store.toast("info", "已复制路径");
			},
		});
		if (canEdit) {
			actions.push({
				label: "删除",
				description: entry.kind === "directory" ? "永久删除目录及其中所有内容" : "永久删除，不进入回收站",
				icon: "trash-outline",
				danger: true,
				confirm: {
					title: `删除“${entry.name}”？`,
					message: `${entry.kind === "directory" ? "目录中的所有内容都会被删除。" : ""}文件会被永久删除，不会进入电脑的废纸篓 / 回收站。`,
					action: "删除",
				},
				onPress: async () => {
					if (await store.deletePath(workspaceId, entry.path)) {
						store.toast("info", `已删除 ${entry.name}`);
						void load();
					}
				},
			});
		}
		return actions;
	};

	const renderItem = ({ item }: { item: WorkspaceFileEntry }) => {
		const directory = item.kind === "directory";
		return (
			<Pressable
				testID={`file-${item.name}`}
				onPress={() => openEntry(item)}
				onLongPress={() => setMenu(item)}
				style={({ pressed }) => [
					styles.item,
					{ borderColor: p.border, backgroundColor: pressed ? p.elevated : p.card },
				]}
			>
				<View style={[styles.icon, { backgroundColor: directory ? p.accentSoft : p.elevated }]}>
					<Icon name={entryIcon(item)} size={17} color={directory ? p.accent : p.muted} />
				</View>
				<View style={styles.flex}>
					<Text style={[styles.name, { color: item.kind === "other" ? p.muted : p.text }]} numberOfLines={1}>
						{item.name}
					</Text>
					{!directory ? (
						<Text style={[styles.meta, { color: p.faint }]} numberOfLines={1}>
							{[item.size !== undefined ? formatSize(item.size) : "", relativeTime(item.modifiedAt)]
								.filter(Boolean)
								.join(" · ")}
						</Text>
					) : null}
				</View>
				{directory ? (
					<Icon name="chevron-forward" size={17} color={p.faint} />
				) : (
					<Pressable hitSlop={10} onPress={() => setMenu(item)} accessibilityLabel={`${item.name} 的操作`}>
						<Icon name="ellipsis-horizontal" size={18} color={p.faint} />
					</Pressable>
				)}
			</Pressable>
		);
	};

	return (
		<Screen>
			<Stack.Screen
				options={{
					title,
					headerRight: () =>
						online && canTransfer ? (
							<HeaderAction label="上传或新建" icon="add" onPress={() => setAddMenu(true)} />
						) : null,
				}}
			/>
			<View style={[styles.pathBar, { borderColor: p.border }]}>
				<Icon name="folder-open-outline" size={14} color={p.faint} />
				<Text style={[styles.pathText, { color: p.faint }]} numberOfLines={1} ellipsizeMode="head">
					{workspace ? shortPath(absolutePath(workspace.path, path)) : path || "/"}
				</Text>
			</View>
			{progress ? (
				<View style={[styles.progress, { backgroundColor: p.accentSoft }]}>
					<ActivityIndicator size="small" color={p.accent} />
					<Text style={[styles.progressText, { color: p.accent }]} numberOfLines={1}>
						{progress}
					</Text>
				</View>
			) : null}
			<FlatList
				style={styles.flex}
				contentContainerStyle={styles.list}
				data={error ? [] : (listing?.entries ?? [])}
				keyExtractor={(e) => e.path}
				renderItem={renderItem}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						tintColor={p.accent}
						colors={[p.accent]}
						onRefresh={async () => {
							setRefreshing(true);
							await load();
							setRefreshing(false);
						}}
					/>
				}
				ListEmptyComponent={
					<View style={styles.empty}>
						{error ? (
							<>
								<Icon name="alert-circle-outline" size={26} color={p.danger} />
								<Text style={[styles.errorText, { color: p.danger }]}>{error}</Text>
							</>
						) : !online ? (
							<Muted>等待连接到电脑…</Muted>
						) : !listing ? (
							<ActivityIndicator color={p.accent} />
						) : (
							<>
								<Icon name="folder-open-outline" size={26} color={p.faint} />
								<Muted>空目录</Muted>
							</>
						)}
					</View>
				}
				ListFooterComponent={
					listing?.truncated ? (
						<Muted style={styles.note}>
							只显示前 {listing.entries.length} 项（共 {listing.total} 项）
						</Muted>
					) : listing?.entries.length ? (
						<Muted style={styles.note}>长按文件或目录可以下载、复制路径或删除</Muted>
					) : null
				}
			/>
			{menu ? (
				<ActionSheet
					title={menu.name}
					subtitle={
						menu.kind === "directory"
							? "目录"
							: [menu.size !== undefined ? formatSize(menu.size) : "", relativeTime(menu.modifiedAt)]
									.filter(Boolean)
									.join(" · ")
					}
					actions={entryActions(menu)}
					onClose={() => setMenu(undefined)}
				/>
			) : null}
			{addMenu ? (
				<ActionSheet
					title={`添加到「${title}」`}
					actions={[
						{
							label: "上传文件",
							description: "从手机的文件中选择",
							icon: "document-attach-outline",
							onPress: () => pick("documents"),
						},
						{
							label: "上传照片或视频",
							description: "从相册中选择",
							icon: "images-outline",
							onPress: () => pick("media"),
						},
						{
							label: "新建文件",
							description: "在这个目录中创建一个空文件",
							icon: "create-outline",
							onPress: () => setNaming(true),
						},
					]}
					onClose={() => setAddMenu(false)}
				/>
			) : null}
			{naming ? (
				<PromptSheet
					title="新建文件"
					message={`在「${title}」中创建，可以带子目录，例如 notes/todo.md`}
					placeholder="文件名"
					confirm="创建"
					mono
					onClose={() => setNaming(false)}
					onSubmit={async (name) => {
						if ((listing?.entries ?? []).some((e) => e.name === name)) {
							store.toast("error", `已经有名为 ${name} 的文件或目录`);
							return false;
						}
						try {
							const result = await store.createFile(workspaceId, childPath(path, name));
							void load();
							router.push({
								pathname: "/host/[hostId]/file",
								params: { hostId, workspaceId, path: result.path, edit: "1" },
							});
							return true;
						} catch (e) {
							store.toast("error", `创建失败：${errorText(e)}`);
							return false;
						}
					}}
				/>
			) : null}
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	pathBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		paddingHorizontal: 16,
		paddingBottom: 8,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	pathText: { flex: 1, fontSize: 12, fontFamily: MONO },
	progress: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginHorizontal: 16,
		marginTop: 8,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: RADIUS.md,
	},
	progressText: { flex: 1, fontSize: 13, fontWeight: "600" },
	list: { paddingHorizontal: 16, paddingBottom: 40 },
	item: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingVertical: 10,
		paddingHorizontal: 12,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: RADIUS.md + 2,
		marginTop: 6,
	},
	icon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
	name: { fontSize: 15, fontWeight: "500" },
	meta: { fontSize: 11.5, marginTop: 2 },
	empty: { paddingVertical: 40, alignItems: "center", gap: 8 },
	errorText: { fontSize: 13.5, textAlign: "center", paddingHorizontal: 16 },
	note: { textAlign: "center", paddingVertical: 14, fontSize: 12 },
});
