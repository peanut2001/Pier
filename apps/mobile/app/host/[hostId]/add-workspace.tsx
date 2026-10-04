import type { HostDirectoryEntry, HostDirectoryListing } from "@pier/protocol";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Muted, Pill, Screen } from "../../../src/components/ui.tsx";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, RADIUS, usePalette } from "../../../src/theme.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Last path segment of a host path (`/` or `\` separated), for button labels. */
function directoryBaseName(path: string, separator: string): string {
	const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
	return trimmed.split(separator).pop() || trimmed;
}

/** Browse the connected computer's directories and add one as a workspace. */
export default function AddWorkspace() {
	const store = useStore();
	const router = useRouter();
	const p = usePalette();
	const insets = useSafeAreaInsets();
	const { hostId } = useLocalSearchParams<{ hostId: string }>();
	const hostName = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId)?.hostName ?? "电脑");
	const online = useMobileState((s) => s.host.hostId === hostId && s.host.connection === "open");
	const [listing, setListing] = useState<HostDirectoryListing>();
	const [input, setInput] = useState("");
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [adding, setAdding] = useState(false);
	const [showHidden, setShowHidden] = useState(false);
	const request = useRef(0);

	const load = useCallback(
		async (path?: string) => {
			const id = ++request.current;
			setLoading(true);
			setError(undefined);
			try {
				const result = await store.listDirectories(path);
				if (request.current !== id) return;
				setListing(result);
				setInput(result.path);
			} catch (e) {
				if (request.current === id) setError(errorText(e));
			} finally {
				if (request.current === id) setLoading(false);
			}
		},
		[store],
	);

	// Start in the computer's home directory once connected.
	useEffect(() => {
		if (online && !listing && !loading && !error) void load();
	}, [online, listing, loading, error, load]);

	const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));
	const hiddenCount = (listing?.entries.length ?? 0) - entries.length;
	const name = listing ? directoryBaseName(listing.path, listing.separator) : "…";

	const add = async () => {
		if (!listing || adding) return;
		setAdding(true);
		const before = new Set((store.getState().host.workspaces ?? []).map((w) => w.id));
		const workspace = await store.addWorkspace(listing.path);
		setAdding(false);
		if (!workspace) return;
		store.toast(
			"info",
			before.has(workspace.id) ? `「${workspace.name}」已经是工作区` : `已添加工作区「${workspace.name}」`,
		);
		router.back();
	};

	const renderItem = ({ item }: { item: HostDirectoryEntry }) => (
		<Pressable
			testID={`directory-${item.name}`}
			disabled={loading}
			onPress={() => void load(item.path)}
			style={({ pressed }) => [styles.item, { borderColor: p.border, backgroundColor: pressed ? p.elevated : p.card }]}
		>
			<Text style={[styles.folder, { color: p.accent }]}>▸</Text>
			<Text style={[styles.itemName, { color: p.text }]} numberOfLines={1}>
				{item.name}
			</Text>
			{item.symlink ? <Pill text="链接" /> : null}
			<Text style={[styles.chevron, { color: p.faint }]}>›</Text>
		</Pressable>
	);

	return (
		<Screen>
			<Stack.Screen options={{ title: "添加工作区" }} />
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
				<View style={styles.top}>
					<Muted>浏览 {hostName} 上的目录，选择一个作为工作区。Agent 会在这个目录中读写文件、运行命令。</Muted>
					<View style={styles.bar}>
						<Button
							title="↑"
							small
							disabled={!listing?.parent || loading}
							onPress={() => listing?.parent && void load(listing.parent)}
							testID="directory-up"
						/>
						<Button
							title="⌂"
							small
							disabled={loading || !online}
							onPress={() => void load(listing?.home)}
							testID="directory-home"
						/>
						<TextInput
							testID="directory-path-input"
							value={input}
							onChangeText={setInput}
							onSubmitEditing={() => {
								const path = input.trim();
								if (path) void load(path);
							}}
							returnKeyType="go"
							placeholder="输入绝对路径后前往"
							placeholderTextColor={p.faint}
							autoCapitalize="none"
							autoCorrect={false}
							spellCheck={false}
							style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.card }]}
						/>
					</View>
				</View>
				<FlatList
					style={styles.flex}
					contentContainerStyle={styles.list}
					data={error ? [] : entries}
					keyExtractor={(e) => e.path}
					renderItem={renderItem}
					keyboardShouldPersistTaps="handled"
					ListEmptyComponent={
						<View style={styles.empty}>
							{error ? (
								<Text style={{ color: p.danger }}>{error}</Text>
							) : !online && !listing ? (
								<Muted>等待连接到电脑…</Muted>
							) : !listing || loading ? (
								<ActivityIndicator color={p.accent} />
							) : (
								<Muted>没有子目录</Muted>
							)}
						</View>
					}
					ListFooterComponent={
						listing?.truncated ? (
							<Muted style={styles.note}>
								只显示前 {listing.entries.length} 个（共 {listing.total} 个），可以直接输入路径。
							</Muted>
						) : null
					}
				/>
				<View
					style={[
						styles.footer,
						{ borderColor: p.border, backgroundColor: p.bg, paddingBottom: Math.max(insets.bottom, 12) },
					]}
				>
					<View style={styles.hiddenRow}>
						<Muted style={styles.flex}>显示隐藏目录{hiddenCount > 0 ? `（${hiddenCount}）` : ""}</Muted>
						<Switch value={showHidden} onValueChange={setShowHidden} testID="directory-show-hidden" />
					</View>
					{listing ? (
						<Text style={[styles.selected, { color: p.faint }]} numberOfLines={1} ellipsizeMode="head">
							{listing.path}
						</Text>
					) : null}
					<Button
						title={`添加「${name}」为工作区`}
						variant="primary"
						loading={adding}
						disabled={!listing || loading || !online || !!error}
						onPress={() => void add()}
						testID="directory-add"
					/>
				</View>
			</KeyboardAvoidingView>
		</Screen>
	);
}

const styles = StyleSheet.create({
	flex: { flex: 1 },
	top: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },
	bar: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
	input: {
		flex: 1,
		borderWidth: 1,
		borderRadius: RADIUS.md,
		paddingHorizontal: 12,
		paddingVertical: 9,
		fontSize: 13.5,
		fontFamily: MONO,
	},
	list: { paddingHorizontal: 16, paddingBottom: 16 },
	item: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingVertical: 13,
		paddingHorizontal: 14,
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: RADIUS.md,
		marginTop: 6,
	},
	folder: { fontSize: 14 },
	itemName: { flex: 1, fontSize: 15 },
	chevron: { fontSize: 20, marginTop: -2 },
	empty: { paddingVertical: 32, alignItems: "center" },
	note: { textAlign: "center", paddingVertical: 12 },
	footer: { gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
	hiddenRow: { flexDirection: "row", alignItems: "center", gap: 10 },
	selected: { fontSize: 12, fontFamily: MONO },
});
