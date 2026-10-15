import type { PierClient } from "@pier/client";
import { type HostProcess, type HostProcesses, parseProtocolVersion } from "@pier/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatSize } from "../lib/format.ts";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { IconLoader, IconRefresh } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { Select } from "./Select.tsx";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function HostProcessesPanel({ initialNode, onClose }: { initialNode: string; onClose(): void }) {
	const store = useStore();
	const [node, setNode] = useState(initialNode);
	const peers = useAppState((s) => s.peers);
	const localInfo = useAppState((s) => s.localHostInfo);
	const connection = useAppState((s) => s.nodes[node]?.connection);
	const client = store.nodeClient(node);
	const online = client?.state === "open" && (node === LOCAL_NODE || connection === "open");
	const version = parseProtocolVersion(client?.host?.protocolVersion ?? "");
	const supported = version?.major === 1 && version.minor >= 42;
	return (
		<Modal title="主机进程" onClose={onClose} wide className="host-processes-modal">
			<Select
				value={node}
				onChange={setNode}
				ariaLabel="查看主机"
				options={[
					{ value: LOCAL_NODE, label: `${localInfo?.hostName ?? "本机"} · 本机` },
					...peers.map((peer) => ({ value: peer.id, label: `${peer.name} · 远程` })),
				]}
			/>
			{!online ? (
				<div role="status">
					<p className="muted">这台主机当前未连接。连接后可查看和结束进程。</p>
					{node !== LOCAL_NODE ? (
						<button type="button" onClick={() => store.retryNode(node)}>
							重新连接
						</button>
					) : null}
				</div>
			) : !supported ? (
				<p className="muted" role="status">
					请先升级这台主机的 Pier（协议 1.42），再使用进程管理。
				</p>
			) : client ? (
				<ProcessList key={node} client={client} hostName={store.nodeName(node)} />
			) : null}
		</Modal>
	);
}

function ProcessList({ client, hostName }: { client: PierClient; hostName: string }) {
	const store = useStore();
	const [sample, setSample] = useState<HostProcesses>();
	const [error, setError] = useState("");
	const [actionError, setActionError] = useState("");
	const [loading, setLoading] = useState(false);
	const [working, setWorking] = useState(false);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<"memory" | "pid" | "name">("memory");
	const [confirmation, setConfirmation] = useState<{ process: HostProcess; force: boolean }>();
	const pending = useRef<Promise<void> | undefined>(undefined);
	const busy = useRef(false);
	const generation = useRef(0);
	const refresh = useCallback((): Promise<void> => {
		if (busy.current) return Promise.resolve();
		if (pending.current) return pending.current;
		const current = generation.current;
		setLoading(true);
		const request = client
			.request("host.processes", {}, { timeoutMs: 15_000 })
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
	}, [client]);
	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 5000);
		return () => {
			generation.current += 1;
			pending.current = undefined;
			clearInterval(timer);
		};
	}, [refresh]);
	const terminate = async () => {
		const selected = confirmation;
		if (!selected?.process.startToken || busy.current) return;
		busy.current = true;
		setWorking(true);
		setActionError("");
		const current = generation.current;
		try {
			await pending.current;
			if (current !== generation.current) return;
			await client.request(
				"host.killProcess",
				{
					pid: selected.process.pid,
					startToken: selected.process.startToken,
					force: selected.force,
				},
				{ timeoutMs: 15_000 },
			);
			store.toast("info", `已向 ${hostName} 的 ${selected.process.name}（PID ${selected.process.pid}）发送结束请求`);
			if (current === generation.current) setConfirmation(undefined);
		} catch (e) {
			if (current === generation.current) setActionError(message(e));
		} finally {
			busy.current = false;
			if (current === generation.current) {
				setWorking(false);
				void refresh();
			}
		}
	};
	const visible = (sample?.processes ?? [])
		.filter((p) =>
			`${p.pid} ${p.parentPid ?? ""} ${p.name} ${p.user ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
		)
		.sort((a, b) =>
			sort === "memory"
				? (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0) || a.pid - b.pid
				: sort === "name"
					? a.name.localeCompare(b.name) || a.pid - b.pid
					: a.pid - b.pid,
		);
	const windows = client.host?.platform === "win32";
	return (
		<>
			<div className="host-processes-toolbar">
				<input
					aria-label="筛选进程"
					placeholder="搜索进程名、PID 或用户…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<Select
					value={sort}
					onChange={setSort}
					ariaLabel="进程排序"
					options={[
						{ value: "memory", label: "内存从高到低" },
						{ value: "pid", label: "PID 从小到大" },
						{ value: "name", label: "进程名称" },
					]}
				/>
				<button type="button" className="ghost" disabled={loading || working} onClick={() => void refresh()}>
					{loading ? <IconLoader size={14} className="spin" /> : <IconRefresh size={14} />} 刷新
				</button>
			</div>
			<p className="muted small">
				每 5 秒刷新。按主机当前用户的权限操作；系统核心进程和 Pier Host 不可结束。
				{windows ? "Windows 的结束操作会直接终止进程。" : "普通结束会请求程序退出，无响应时可强制结束。"}
			</p>
			{error ? (
				<p className="banner error" role="alert">
					{error}
				</p>
			) : null}
			{actionError ? (
				<p className="banner error" role="alert">
					{actionError}
				</p>
			) : null}
			{confirmation ? (
				<div className="host-process-confirm" role="alert">
					<p>
						确认{confirmation.force ? "强制结束" : "结束"} {hostName} 上的 <strong>{confirmation.process.name}</strong>
						（PID {confirmation.process.pid}）？未保存的数据可能丢失。
					</p>
					<button type="button" className="danger" disabled={working} onClick={() => void terminate()}>
						{working ? "正在发送…" : "确认结束"}
					</button>
					<button type="button" className="ghost" disabled={working} onClick={() => setConfirmation(undefined)}>
						取消
					</button>
				</div>
			) : null}
			<div className="host-processes-table-wrap">
				<table className="host-processes-table">
					<thead>
						<tr>
							<th>PID</th>
							<th>进程</th>
							<th>父 PID</th>
							<th>用户 / UID</th>
							<th>内存</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((p) => (
							<tr key={`${p.pid}:${p.startToken ?? ""}`}>
								<td>
									<code>{p.pid}</code>
								</td>
								<td className="host-process-name">{p.name}</td>
								<td>{p.parentPid ?? "—"}</td>
								<td>{p.user ?? "—"}</td>
								<td>{p.memoryBytes === undefined ? "—" : formatSize(p.memoryBytes)}</td>
								<td className="host-process-actions">
									{p.canTerminate && p.startToken ? (
										<>
											<button
												type="button"
												className="ghost"
												disabled={working}
												onClick={() => setConfirmation({ process: p, force: false })}
											>
												结束
											</button>
											{!windows ? (
												<button
													type="button"
													className="ghost"
													disabled={working}
													onClick={() => setConfirmation({ process: p, force: true })}
												>
													强制结束
												</button>
											) : null}
										</>
									) : (
										<span className="muted">不可结束</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{!visible.length ? (
					<p className="muted">
						{sample ? (query ? "没有匹配的进程" : "未发现可读取的进程") : loading ? "正在读取进程…" : "暂无进程数据"}
					</p>
				) : null}
			</div>
			{sample ? (
				<p className="muted small">
					显示 {visible.length} / {sample.processes.length} 个进程{sample.truncated ? "（列表已截断）" : ""}
				</p>
			) : null}
		</>
	);
}
