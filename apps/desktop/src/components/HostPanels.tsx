import { useEffect, useRef, useState } from "react";
import { useAppState, useStore } from "../lib/store.tsx";
import { IconAlert, IconDownload, IconInfo, IconLoader } from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";

/** Connection / host lifecycle banner shown above the main area when something is off. */
export function HostBanner({ onShowLogs }: { onShowLogs: () => void }) {
	const store = useStore();
	const host = useAppState((s) => s.host);
	const connection = useAppState((s) => s.connection);
	const connectError = useAppState((s) => s.connectError);

	let level: "info" | "warning" | "error" = "info";
	let text: string | undefined;
	if (host.state === "starting") text = "正在启动 Pier Host…";
	else if (host.state === "restarting") {
		level = "warning";
		text = `Pier Host 意外退出，正在自动重启${host.error ? `（${host.error}）` : ""}`;
	} else if (host.state === "failed") {
		level = "error";
		text = `Pier Host 无法启动：${host.error ?? "未知错误"}`;
	} else if (host.state === "stopped") {
		level = "warning";
		text = host.error ?? "Pier Host 未运行";
	} else if (connectError) {
		level = "error";
		text = `无法连接到 Pier Host：${connectError}`;
	} else if (connection === "reconnecting") {
		level = "warning";
		text = "与 Pier Host 的连接中断，正在重连…（进行中的任务不受影响）";
	} else if (connection === "connecting" || connection === "none") text = "正在连接 Pier Host…";
	if (!text) return null;
	const canRestart = store.bridgeKind === "tauri" && (host.state === "failed" || host.state === "ready");
	return (
		<div className={`banner host-banner ${level}`}>
			{level === "info" ? (
				<IconLoader size={15} className="spin" />
			) : level === "warning" ? (
				<IconInfo size={15} />
			) : (
				<IconAlert size={15} />
			)}
			<span>{text}</span>
			<span className="banner-actions">
				{canRestart && level !== "info" ? (
					<button type="button" onClick={() => store.restartHost()}>
						重启 Host
					</button>
				) : null}
				<button type="button" className="ghost" onClick={onShowLogs}>
					查看日志
				</button>
			</span>
		</div>
	);
}

export function LogsPanel({ onClose }: { onClose: () => void }) {
	const store = useStore();
	const host = useAppState((s) => s.host);
	const hostInfo = useAppState((s) => s.hostInfo);
	const update = useAppState((s) => s.update);
	const [lines, setLines] = useState<string[]>([]);
	const scroller = useRef<HTMLPreElement>(null);

	useEffect(() => {
		let alive = true;
		void store.logs().then((initial) => {
			if (alive) setLines(initial);
		});
		const off = store.onLog((line) => setLines((current) => [...current, line].slice(-2000)));
		return () => {
			alive = false;
			off();
		};
	}, [store]);

	useEffect(() => {
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	});

	return (
		<Modal title="Pier Host" onClose={onClose} wide>
			<div className="host-facts">
				<span className={`fact state-${host.state}`}>
					<span className={`status-dot ${host.state === "ready" ? "ok" : host.state === "failed" ? "bad" : "wait"}`} />
					{host.state}
				</span>
				{host.version ? <span className="fact">Host v{host.version}</span> : null}
				{hostInfo ? <span className="fact">pi {hostInfo.piVersion}</span> : null}
				{host.pid ? <span className="fact">pid {host.pid}</span> : null}
				{host.url ? <span className="fact mono">{host.url}</span> : null}
				{host.restarts ? <span className="fact">自动重启 {host.restarts} 次</span> : null}
				{hostInfo ? (
					<span className="fact mono" title="模型、凭据与会话复用 pi 的配置">
						{hostInfo.agentDir}
					</span>
				) : null}
			</div>
			<pre className="logs" ref={scroller}>
				{lines.join("\n") || "（暂无日志）"}
			</pre>
			<div className="modal-actions spread">
				<CopyButton text={lines.join("\n")} label="复制日志" />
				<span className="modal-actions-group">
					{store.bridgeKind === "tauri" || update.state !== "unsupported" ? (
						<button
							type="button"
							title={`Pier v${update.currentVersion}`}
							onClick={() => {
								onClose();
								store.showUpdate(true);
							}}
						>
							<IconDownload size={14} />
							检查更新
						</button>
					) : null}
					{store.bridgeKind === "tauri" ? (
						<button type="button" onClick={() => store.restartHost()}>
							重启 Host
						</button>
					) : null}
				</span>
			</div>
		</Modal>
	);
}
