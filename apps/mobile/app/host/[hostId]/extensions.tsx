import type {
	ExtensionListResult,
	ExtensionPackageInfo,
	ExtensionResourceInfo,
	ExtensionResourceType,
	ExtensionUpdateInfo,
} from "@pier/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import {
	ActionSheet,
	Button,
	Card,
	HeaderAction,
	Icon,
	type IconName,
	Muted,
	Pill,
	PromptSheet,
	Screen,
	SectionLabel,
	type SheetAction,
} from "../../../src/components/ui.tsx";
import { shortPath } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, usePalette } from "../../../src/theme.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const TYPE_LABEL: Record<ExtensionResourceType, string> = {
	extensions: "扩展",
	skills: "技能",
	prompts: "提示词模板",
	themes: "主题",
};

const TYPE_ICON: Record<ExtensionResourceType, IconName> = {
	extensions: "extension-puzzle-outline",
	skills: "school-outline",
	prompts: "chatbox-ellipses-outline",
	themes: "color-palette-outline",
};

const TYPES: ExtensionResourceType[] = ["extensions", "skills", "prompts", "themes"];

function packageName(pkg: ExtensionPackageInfo): string {
	return pkg.name ?? pkg.source.replace(/^(npm|git):/, "");
}

/** pi packages and resources on the connected computer: install, update, remove, enable and disable. */
export default function ExtensionsScreen() {
	const store = useStore();
	const p = usePalette();
	const { hostId, workspaceId } = useLocalSearchParams<{ hostId: string; workspaceId?: string }>();
	const online = useMobileState((s) => s.host.hostId === hostId && s.host.connection === "open");
	const workspace = useMobileState((s) =>
		workspaceId && s.host.hostId === hostId ? s.host.workspaces?.find((w) => w.id === workspaceId) : undefined,
	);
	const [list, setList] = useState<ExtensionListResult>();
	const [error, setError] = useState<string>();
	const [refreshing, setRefreshing] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [updates, setUpdates] = useState<ExtensionUpdateInfo[]>();
	const [installing, setInstalling] = useState(false);
	const [menu, setMenu] = useState<ExtensionPackageInfo>();
	const [resourceMenu, setResourceMenu] = useState<ExtensionResourceInfo>();

	const load = useCallback(async () => {
		try {
			setList(await store.listExtensions(workspaceId));
			setError(undefined);
		} catch (e) {
			setError(errorText(e));
		}
	}, [store, workspaceId]);

	useEffect(() => {
		if (online) void load();
	}, [online, load]);

	/** Run a change with a busy marker, then reload the list. */
	const run = async (key: string, label: string, action: () => Promise<unknown>, done?: string) => {
		setBusy(key);
		try {
			await action();
			if (done) store.toast("info", done);
		} catch (e) {
			store.toast("error", `${label}失败：${errorText(e)}`);
		} finally {
			setBusy(undefined);
			void load();
		}
	};

	const checkUpdates = () =>
		run("check", "检查更新", async () => {
			const found = await store.checkExtensionUpdates(workspaceId);
			setUpdates(found);
			store.toast("info", found.length ? `有 ${found.length} 个扩展包可以更新` : "所有扩展包都是最新的");
		});

	const packageActions = (pkg: ExtensionPackageInfo): SheetAction[] => {
		const actions: SheetAction[] = [];
		if (pkg.kind !== "local") {
			actions.push({
				label: "更新",
				description: "拉取这个包的最新版本",
				icon: "cloud-download-outline",
				onPress: () =>
					void run(
						`pkg:${pkg.source}`,
						"更新",
						() => store.updateExtensions(pkg.source, workspaceId),
						`已更新 ${packageName(pkg)}`,
					),
			});
		}
		actions.push({
			label: "移除",
			description: pkg.kind === "local" ? "从设置中移除（不删除目录）" : "从设置中移除并卸载",
			icon: "trash-outline",
			danger: true,
			confirm: {
				title: `移除“${packageName(pkg)}”？`,
				message: "它提供的扩展、技能、提示词模板和主题都不会再加载，已打开的 pi 会话会重新加载。",
				action: "移除",
			},
			onPress: () =>
				void run(
					`pkg:${pkg.source}`,
					"移除",
					() => store.removeExtension(pkg.source, pkg.scope, workspaceId),
					`已移除 ${packageName(pkg)}`,
				),
		});
		return actions;
	};

	const packages = list?.packages ?? [];
	const resources = list?.resources ?? [];
	const updatable = new Set((updates ?? []).map((u) => u.source));

	return (
		<Screen>
			<Stack.Screen
				options={{
					title: "pi 扩展",
					headerRight: () =>
						online && list ? (
							<HeaderAction label="安装扩展包" icon="add" text="安装" onPress={() => setInstalling(true)} />
						) : null,
				}}
			/>
			<ScrollView
				contentContainerStyle={styles.content}
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
			>
				<Muted style={styles.intro}>
					{workspace
						? `全局设置与工作区「${workspace.name}」的项目设置（.pi/settings.json）中的 pi 扩展包和资源。`
						: "电脑上 pi 的全局扩展包和资源（~/.pi/agent/settings.json），对所有工作区生效。只作用于 pi 会话。"}
				</Muted>
				{error ? (
					<Card flat style={[styles.errorBox, { backgroundColor: p.dangerSoft, borderColor: p.dangerSoft }]}>
						<Icon name="alert-circle-outline" size={18} color={p.danger} />
						<Text style={[styles.errorText, { color: p.danger }]}>{error}</Text>
					</Card>
				) : null}
				{!list && !error ? (
					<View style={styles.loading}>
						{online ? <ActivityIndicator color={p.accent} /> : <Muted>等待连接到电脑…</Muted>}
					</View>
				) : null}
				{list ? (
					<>
						<View style={styles.sectionHead}>
							<SectionLabel style={styles.flex}>扩展包（{packages.length}）</SectionLabel>
							{packages.some((pkg) => pkg.kind !== "local") ? (
								<View style={styles.headButtons}>
									<Button
										title="检查更新"
										icon="refresh"
										small
										variant="ghost"
										loading={busy === "check"}
										disabled={!!busy}
										onPress={() => void checkUpdates()}
									/>
									{updates?.length ? (
										<Button
											title="全部更新"
											small
											variant="tonal"
											loading={busy === "update-all"}
											disabled={!!busy}
											onPress={() =>
												void run(
													"update-all",
													"更新",
													() => store.updateExtensions(undefined, workspaceId),
													"扩展包已更新",
												).then(() => setUpdates(undefined))
											}
										/>
									) : null}
								</View>
							) : null}
						</View>
						<Card flat style={styles.group}>
							{packages.length ? (
								packages.map((pkg, index) => (
									<Pressable
										key={`${pkg.scope}:${pkg.source}`}
										onPress={() => setMenu(pkg)}
										style={({ pressed }) => [
											styles.row,
											index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
											pressed && { backgroundColor: p.elevated },
										]}
									>
										<View style={[styles.rowIcon, { backgroundColor: p.accentSoft }]}>
											<Icon name="cube-outline" size={17} color={p.accent} />
										</View>
										<View style={styles.flex}>
											<View style={styles.nameRow}>
												<Text style={[styles.name, { color: p.text }]} numberOfLines={1}>
													{packageName(pkg)}
												</Text>
												{pkg.version ? <Text style={[styles.version, { color: p.faint }]}>{pkg.version}</Text> : null}
											</View>
											{pkg.description ? (
												<Muted style={styles.desc} numberOfLines={2}>
													{pkg.description}
												</Muted>
											) : null}
											<View style={styles.tags}>
												<Pill text={pkg.scope === "project" ? "项目" : "全局"} />
												<Pill text={pkg.kind} />
												{!pkg.installedPath ? <Pill text="未安装" tone="warning" /> : null}
												{updatable.has(pkg.source) ? <Pill text="可更新" tone="accent" /> : null}
											</View>
										</View>
										{busy === `pkg:${pkg.source}` ? (
											<ActivityIndicator size="small" color={p.accent} />
										) : (
											<Icon name="ellipsis-horizontal" size={18} color={p.faint} />
										)}
									</Pressable>
								))
							) : (
								<Muted style={styles.empty}>还没有安装扩展包。点右上角「安装」，输入 npm 包名或 git 地址。</Muted>
							)}
						</Card>
						{TYPES.map((type) => {
							const items = resources.filter((r) => r.type === type);
							if (!items.length) return null;
							return (
								<View key={type}>
									<SectionLabel style={styles.label}>
										{TYPE_LABEL[type]}（{items.filter((r) => r.enabled).length}/{items.length} 已启用）
									</SectionLabel>
									<Card flat style={styles.group}>
										{items.map((resource, index) => (
											<Pressable
												key={`${resource.scope}:${resource.path}`}
												onLongPress={() => resource.deletable && setResourceMenu(resource)}
												style={[
													styles.row,
													index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border },
												]}
											>
												<Icon name={TYPE_ICON[type]} size={18} color={resource.enabled ? p.accent : p.faint} />
												<View style={styles.flex}>
													<Text style={[styles.name, { color: resource.enabled ? p.text : p.muted }]} numberOfLines={1}>
														{resource.name}
													</Text>
													<Text style={[styles.source, { color: p.faint }]} numberOfLines={1}>
														{resource.scope === "project" ? "项目 · " : ""}
														{resource.origin === "package" ? resource.source : shortPath(resource.path)}
													</Text>
												</View>
												{busy === `res:${resource.path}` ? (
													<ActivityIndicator size="small" color={p.accent} />
												) : (
													<Switch
														value={resource.enabled}
														disabled={!!busy}
														onValueChange={(enabled) =>
															void run(`res:${resource.path}`, enabled ? "启用" : "停用", () =>
																store.setExtensionEnabled(resource, enabled, workspaceId),
															)
														}
													/>
												)}
											</Pressable>
										))}
									</Card>
								</View>
							);
						})}
						{!resources.length ? (
							<Muted style={styles.empty}>pi 没有发现任何扩展、技能、提示词模板或主题。</Muted>
						) : null}
						<Muted style={styles.note}>修改会让电脑上已打开的 pi 会话重新加载。长按可删除的独立资源可以删除它。</Muted>
					</>
				) : null}
			</ScrollView>
			{menu ? (
				<ActionSheet
					title={packageName(menu)}
					subtitle={menu.source}
					actions={packageActions(menu)}
					onClose={() => setMenu(undefined)}
				/>
			) : null}
			{resourceMenu ? (
				<ActionSheet
					title={resourceMenu.name}
					subtitle={shortPath(resourceMenu.path)}
					actions={[
						{
							label: "删除",
							description: resourceMenu.source === "local" ? "从设置中移除（文件保留）" : "移到电脑上的 Pier 回收站",
							icon: "trash-outline",
							danger: true,
							confirm: {
								title: `删除“${resourceMenu.name}”？`,
								message:
									resourceMenu.type === "skills" && resourceMenu.source === "auto"
										? "技能及其脚本、资源会移入 Pier 回收站，其他读取同一目录的工具也会受影响。已打开的 pi 会话会重新加载。"
										: "pi 不会再加载它，已打开的 pi 会话会重新加载。",
								action: "删除",
							},
							onPress: () =>
								void run(
									`res:${resourceMenu.path}`,
									"删除",
									() => store.deleteExtension(resourceMenu, workspaceId),
									`已删除 ${resourceMenu.name}`,
								),
						},
					]}
					onClose={() => setResourceMenu(undefined)}
				/>
			) : null}
			{installing ? (
				<PromptSheet
					title="安装 pi 扩展包"
					message={`例如 npm:pi-foo、npm:@scope/pkg@1.2.0、git:github.com/user/repo 或电脑上的绝对路径。${
						workspace ? `安装到工作区「${workspace.name}」的项目设置。` : "安装到全局设置。"
					}`}
					placeholder="npm:包名"
					confirm="安装"
					mono
					onClose={() => setInstalling(false)}
					onSubmit={async (source) => {
						try {
							await store.installExtension(source, workspaceId ? "project" : "user", workspaceId);
							store.toast("info", `已安装 ${source}`);
							void load();
							return true;
						} catch (e) {
							store.toast("error", `安装失败：${errorText(e)}`);
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
	content: { padding: 16, paddingBottom: 48 },
	intro: { fontSize: 13, lineHeight: 19, marginHorizontal: 4, marginBottom: 6 },
	loading: { paddingVertical: 40, alignItems: "center" },
	errorBox: { flexDirection: "row", gap: 8, marginTop: 10 },
	errorText: { flex: 1, fontSize: 13.5 },
	sectionHead: { flexDirection: "row", alignItems: "center", marginTop: 16, marginBottom: 6 },
	headButtons: { flexDirection: "row", gap: 6 },
	label: { marginTop: 20, marginBottom: 8 },
	group: { padding: 0, overflow: "hidden" },
	row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
	rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
	nameRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
	name: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
	version: { fontSize: 12, fontFamily: MONO },
	desc: { fontSize: 12.5, lineHeight: 18, marginTop: 2 },
	tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
	source: { fontSize: 11.5, fontFamily: MONO, marginTop: 2 },
	empty: { padding: 16, fontSize: 13 },
	note: { marginTop: 14, marginHorizontal: 4, fontSize: 12, lineHeight: 18 },
});
