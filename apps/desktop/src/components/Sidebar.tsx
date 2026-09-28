import type { ApprovalPolicy, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { useState } from "react";
import { POLICY_DESCRIPTION, POLICY_LABEL, relativeTime, sessionTitle } from "../lib/format.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { Modal } from "./Modal.tsx";

const SESSION_PAGE = 30;

export function useAddWorkspace(): () => Promise<void> {
	const store = useStore();
	return async () => {
		const path = await store.pickDirectory();
		if (path) await store.addWorkspace(path);
	};
}

function SessionBadge({ session }: { session: SessionSummary }) {
	const store = useStore();
	useAppState((s) => s.chatsVersion);
	const live = store.liveChat(session.id)?.chat;
	const pending = live?.pendingUi.length ?? 0;
	const state = live?.loaded ? live.runState : session.state;
	if (pending) return <span className="badge-dot attention" title={`${pending} 个待处理请求`} />;
	if (state === "streaming" || state === "retrying" || state === "compacting") {
		return <span className="badge-dot running" title="运行中" />;
	}
	return null;
}

function WorkspaceGroup({ workspace, onSettings }: { workspace: WorkspaceInfo; onSettings: () => void }) {
	const store = useStore();
	const expanded = useAppState((s) => !!s.expanded[workspace.id]);
	const sessions = useAppState((s) => s.sessions[workspace.id]);
	const selectedSessionId = useAppState((s) => s.selectedSessionId);
	const selectedWorkspaceId = useAppState((s) => s.selectedWorkspaceId);
	const [limit, setLimit] = useState(SESSION_PAGE);
	const selected = selectedWorkspaceId === workspace.id && !selectedSessionId;
	return (
		<div className="workspace-group">
			<div className={`workspace-row${selected ? " selected" : ""}`}>
				<button
					type="button"
					className={`chevron-button${expanded ? " open" : ""}`}
					onClick={() => store.toggleExpanded(workspace.id)}
					title={expanded ? "收起" : "展开"}
				>
					›
				</button>
				<button
					type="button"
					className="workspace-name"
					title={workspace.path}
					onClick={() => store.selectWorkspace(workspace.id)}
				>
					{workspace.name}
					{workspace.policy !== "smart" ? (
						<span className={`policy-tag ${workspace.policy}`}>{POLICY_LABEL[workspace.policy]}</span>
					) : null}
				</button>
				<button type="button" className="ghost icon" title="工作区设置" onClick={onSettings}>
					⚙
				</button>
				<button
					type="button"
					className="ghost icon"
					title="新建会话"
					onClick={() => void store.createSession(workspace.id)}
				>
					＋
				</button>
			</div>
			{expanded ? (
				<div className="session-list">
					{!sessions ? <div className="session-empty">加载中…</div> : null}
					{sessions && !sessions.length ? <div className="session-empty">还没有会话</div> : null}
					{sessions?.slice(0, limit).map((session) => (
						<button
							type="button"
							key={session.id}
							className={`session-row${session.id === selectedSessionId ? " selected" : ""}`}
							onClick={() => store.selectSession(session)}
							title={session.firstMessage || session.name || session.id}
						>
							<span className="session-row-title">{sessionTitle(session)}</span>
							<SessionBadge session={session} />
							<span className="session-row-time">{relativeTime(session.modifiedAt)}</span>
						</button>
					))}
					{sessions && sessions.length > limit ? (
						<button type="button" className="session-more" onClick={() => setLimit(limit + SESSION_PAGE)}>
							显示更多（还有 {sessions.length - limit} 个）
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function WorkspaceSettings({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
	const store = useStore();
	const [confirmRemove, setConfirmRemove] = useState(false);
	return (
		<Modal title={`工作区设置 · ${workspace.name}`} onClose={onClose}>
			<div className="field">
				<div className="field-label">目录</div>
				<code className="path">{workspace.path}</code>
			</div>
			<div className="field">
				<div className="field-label">工具审批策略</div>
				{(["ask", "smart", "auto"] as ApprovalPolicy[]).map((policy) => (
					<label key={policy} className={`policy-option${workspace.policy === policy ? " selected" : ""}`}>
						<input
							type="radio"
							name="policy"
							checked={workspace.policy === policy}
							onChange={() => void store.setPolicy(workspace.id, policy)}
						/>
						<div>
							<div className="policy-title">
								{POLICY_LABEL[policy]}
								{policy === "smart" ? <span className="muted">（默认）</span> : null}
							</div>
							<div className={`muted${policy === "auto" ? " warning-text" : ""}`}>{POLICY_DESCRIPTION[policy]}</div>
						</div>
					</label>
				))}
				<p className="muted small">
					危险命令（rm -r、sudo、git push --force 等）在“逐项审批”和“智能”策略下总是需要批准。
				</p>
			</div>
			<div className="modal-actions spread">
				<button
					type="button"
					className="danger"
					onClick={() => {
						if (!confirmRemove) {
							setConfirmRemove(true);
							return;
						}
						onClose();
						void store.removeWorkspace(workspace.id);
					}}
				>
					{confirmRemove ? "再次点击确认移除（不会删除任何文件）" : "从 Pier 移除工作区"}
				</button>
				<button type="button" onClick={onClose}>
					完成
				</button>
			</div>
		</Modal>
	);
}

export function Sidebar({ onShowLogs }: { onShowLogs: () => void }) {
	const store = useStore();
	const workspaces = useAppState((s) => s.workspaces);
	const host = useAppState((s) => s.host);
	const connection = useAppState((s) => s.connection);
	const hostInfo = useAppState((s) => s.hostInfo);
	const addWorkspace = useAddWorkspace();
	const [settingsFor, setSettingsFor] = useState<string | undefined>();
	const settingsWorkspace = workspaces.find((w) => w.id === settingsFor);

	const online = host.state === "ready" && connection === "open";
	const statusText = online
		? `已连接 · pi ${hostInfo?.piVersion ?? ""}`
		: connection === "reconnecting"
			? "正在重连…"
			: host.state === "failed"
				? "Host 启动失败"
				: host.state === "restarting"
					? "Host 正在重启…"
					: host.state === "stopped"
						? "未连接"
						: "正在启动…";

	return (
		<aside className="sidebar">
			<div className="brand">
				<span className="brand-name">Pier</span>
				<span className={`status-dot ${online ? "ok" : host.state === "failed" ? "bad" : "wait"}`} />
			</div>
			<div className="sidebar-section-title">
				<span>工作区</span>
				<button type="button" className="ghost icon" title="添加工作区" onClick={() => void addWorkspace()}>
					＋
				</button>
			</div>
			<div className="workspace-list">
				{workspaces.map((workspace) => (
					<WorkspaceGroup key={workspace.id} workspace={workspace} onSettings={() => setSettingsFor(workspace.id)} />
				))}
				{online && !workspaces.length ? (
					<button type="button" className="add-first" onClick={() => void addWorkspace()}>
						＋ 添加第一个工作区
					</button>
				) : null}
			</div>
			<div className="sidebar-footer">
				<button type="button" className="ghost" onClick={onShowLogs} title={hostInfo?.agentDir ?? ""}>
					{statusText}
				</button>
				{store.bridgeKind === "tauri" ? (
					<button type="button" className="ghost" onClick={() => store.quit()} title="退出 Pier（停止 Host）">
						退出
					</button>
				) : null}
			</div>
			{settingsWorkspace ? (
				<WorkspaceSettings workspace={settingsWorkspace} onClose={() => setSettingsFor(undefined)} />
			) : null}
		</aside>
	);
}
