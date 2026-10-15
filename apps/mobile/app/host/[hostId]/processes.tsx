import type { HostProcess, HostProcesses } from "@pier/protocol";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Card, confirmDestructive, Muted, Screen } from "../../../src/components/ui.tsx";
import { formatSize } from "../../../src/format.ts";
import { useMobileState, useStore } from "../../../src/store.ts";
import { MONO, PAGE, RADIUS, usePalette } from "../../../src/theme.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function ProcessesScreen() {
	const store = useStore();
	const { hostId } = useLocalSearchParams<{ hostId: string }>();
	const host = useMobileState((s) => s.host);
	const online = host.hostId === hostId && host.connection === "open";
	return (
		<Screen>
			<Stack.Screen options={{ title: "主机进程" }} />
			{!online ? (
				<Muted style={styles.hint}>这台主机当前未连接。</Muted>
			) : !store.canManageProcesses() ? (
				<Muted style={styles.hint}>请先升级这台主机的 Pier（协议 1.42），再使用进程管理。</Muted>
			) : (
				<ProcessList key={hostId} hostId={hostId} windows={host.info?.platform === "win32"} />
			)}
		</Screen>
	);
}

function ProcessList({ hostId, windows }: { hostId: string; windows: boolean }) {
	const store = useStore();
	const p = usePalette();
	const hostName = useMobileState((s) => s.hosts.find((h) => h.hostId === hostId)?.hostName ?? "电脑");
	const [sample, setSample] = useState<HostProcesses>();
	const [error, setError] = useState("");
	const [actionError, setActionError] = useState("");
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(false);
	const [working, setWorking] = useState(false);
	const active = useRef(false);
	const generation = useRef(0);
	const busy = useRef(false);
	const pending = useRef<Promise<void> | undefined>(undefined);
	const refresh = useCallback((): Promise<void> => {
		if (!active.current || busy.current) return Promise.resolve();
		if (pending.current) return pending.current;
		const current = generation.current;
		setLoading(true);
		const request = store
			.hostProcesses(hostId)
			.then((result) => {
				if (current !== generation.current) return;
				setSample(result);
				setError("");
			})
			.catch((e) => {
				if (current === generation.current) setError(message(e));
			})
			.finally(() => {
				if (pending.current === request) pending.current = undefined;
				if (current === generation.current) setLoading(false);
			});
		pending.current = request;
		return request;
	}, [hostId, store]);
	useFocusEffect(
		useCallback(() => {
			active.current = true;
			setWorking(busy.current);
			void refresh();
			const timer = setInterval(() => void refresh(), 5000);
			return () => {
				active.current = false;
				generation.current += 1;
				pending.current = undefined;
				clearInterval(timer);
			};
		}, [refresh]),
	);
	const terminate = async (proc: HostProcess, force: boolean) => {
		if (!active.current || busy.current || !proc.startToken) return;
		const current = generation.current;
		busy.current = true;
		setWorking(true);
		setActionError("");
		try {
			await pending.current;
			if (!active.current || current !== generation.current) return;
			await store.killHostProcess(hostId, { pid: proc.pid, startToken: proc.startToken, force });
			store.toast("info", `已向 ${hostName} 的 ${proc.name}（PID ${proc.pid}）发送结束请求`);
		} catch (e) {
			if (current === generation.current) setActionError(message(e));
		} finally {
			busy.current = false;
			if (active.current) setWorking(false);
			if (current === generation.current) void refresh();
		}
	};
	const confirm = (proc: HostProcess, force: boolean) =>
		confirmDestructive(
			force ? "强制结束进程" : "结束进程",
			`确认结束 ${hostName} 上的 ${proc.name}（PID ${proc.pid}）？未保存的数据可能丢失。`,
			"确认结束",
			() => void terminate(proc, force),
		);
	const visible = (sample?.processes ?? [])
		.filter((proc) =>
			`${proc.pid} ${proc.parentPid ?? ""} ${proc.name} ${proc.user ?? ""}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
		)
		.sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0) || a.pid - b.pid);
	return (
		<FlatList
			data={visible}
			keyExtractor={(proc) => `${proc.pid}:${proc.startToken ?? ""}`}
			contentContainerStyle={styles.list}
			keyboardShouldPersistTaps="handled"
			ListHeaderComponent={
				<View style={styles.header}>
					<TextInput
						accessibilityLabel="筛选进程"
						placeholder="搜索进程名、PID 或用户…"
						placeholderTextColor={p.faint}
						value={query}
						onChangeText={setQuery}
						style={[styles.input, { color: p.text, backgroundColor: p.elevated, borderColor: p.border }]}
					/>
					<Muted>
						按内存从高到低排列，每 5 秒刷新。按主机用户权限操作，系统核心进程和 Pier Host 不可结束。
						{windows ? "Windows 的结束操作会直接终止进程。" : "无响应时可强制结束。"}
					</Muted>
					<Button
						title="刷新"
						icon="refresh"
						small
						disabled={working}
						loading={loading}
						onPress={() => void refresh()}
					/>
					{error || actionError ? (
						<Text accessibilityRole="alert" style={{ color: p.danger }}>
							{actionError || error}
						</Text>
					) : null}
				</View>
			}
			ListEmptyComponent={
				<Muted style={styles.hint}>{loading ? "正在读取进程…" : query ? "没有匹配的进程" : "暂无进程数据"}</Muted>
			}
			ListFooterComponent={
				sample ? (
					<Muted style={styles.hint}>
						显示 {visible.length} / {sample.processes.length} 个进程{sample.truncated ? "（列表已截断）" : ""}
					</Muted>
				) : null
			}
			renderItem={({ item: proc }) => (
				<Card flat style={styles.row}>
					<View style={styles.rowHead}>
						<Text style={[styles.name, { color: p.text }]}>{proc.name}</Text>
						<Text style={[styles.pid, { color: p.muted }]}>PID {proc.pid}</Text>
					</View>
					<Muted>
						内存 {proc.memoryBytes === undefined ? "—" : formatSize(proc.memoryBytes)} · 用户 / UID {proc.user ?? "—"} ·
						父 PID {proc.parentPid ?? "—"}
					</Muted>
					{proc.canTerminate && proc.startToken ? (
						<View style={styles.actions}>
							<Button title="结束" small variant="danger" disabled={working} onPress={() => confirm(proc, false)} />
							{!windows ? (
								<Button title="强制结束" small variant="ghost" disabled={working} onPress={() => confirm(proc, true)} />
							) : null}
						</View>
					) : (
						<Muted>不可结束</Muted>
					)}
				</Card>
			)}
		/>
	);
}

const styles = StyleSheet.create({
	list: { ...PAGE, padding: 20, gap: 10 },
	header: { gap: 12, marginBottom: 8 },
	hint: { padding: 20 },
	input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: 12, fontSize: 14 },
	row: { gap: 10 },
	rowHead: { flexDirection: "row", gap: 10, alignItems: "center" },
	name: { flex: 1, fontSize: 15, fontWeight: "600" },
	pid: { fontSize: 12, fontFamily: MONO },
	actions: { flexDirection: "row", gap: 8 },
});
