import { agentRuntimeLabel } from "@pier/chat-state";
import type { ApprovalPolicy, PeerInfo, SessionSummary, WorkspaceInfo } from "@pier/protocol";
import { useEffect, useState } from "react";
import { POLICY_DESCRIPTION, POLICY_LABEL, relativeTime, sessionTitle } from "../lib/format.ts";
import {
	type ComputerInfo,
	LOCAL_NODE,
	useAppState,
	useCanArchiveSessions,
	useCanManageWorkspace,
	useComputers,
	useStore,
} from "../lib/store.tsx";
import { useHostStatus } from "./HostPanels.tsx";
import {
	IconArchive,
	IconArchiveRestore,
	IconBroom,
	IconChevronRight,
	IconFolder,
	IconFolderPlus,
	IconMessagePlus,
	IconMonitor,
	IconPanelLeft,
	IconPlus,
	IconSettings,
	IconTrash,
	Logo,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { platformName } from "./RemotePanel.tsx";
import { SessionCleanupDialog } from "./SessionCleanup.tsx";
import { useOutsideClick } from "./SessionControls.tsx";
import { updatePending } from "./UpdatePanel.tsx";

const SESSION_PAGE = 30;

export const SIDEBAR_SHORTCUT = "Ctrl/⌘+B";

/**
 * Header button that brings a collapsed sidebar back. Renders nothing while the sidebar is
 * shown (it has its own collapse button then).
 */
export function SidebarToggle({ floating = false }: { floating?: boolean }) {
	const store = useStore();
	const open = useAppState((s) => s.sidebar);
	if (open) return null;
	const button = (
		<button
			type="button"
			className="chip icon-chip sidebar-open-button"
			title={`显示侧边栏（${SIDEBAR_SHORTCUT}）`}
			aria-label="显示侧边栏"
			onClick={() => store.toggleSidebar(true)}
		>
			<IconPanelLeft size={15} />
		</button>
	);
	return floating ? <div className="home-toolbar left">{button}</div> : button;
}

/**
 * Pick a directory and add it as a workspace on a computer (this one by default, browsing a
 * paired computer's directories when needed).
 */
export function useAddWorkspace(node = LOCAL_NODE): () => Promise<void> {
	const store = useStore();
	return () => store.pickAndAddWorkspace(node);
}

/** Why workspaces cannot be added on a computer right now, if they cannot. */
export function addWorkspaceBlocker(computer: ComputerInfo): string | undefined {
	if (computer.state.revoked) return "已移除这台电脑，需要重新配对";
	if (!computer.online) return computer.local ? "Pier Host 未连接" : "未连接";
	if (!computer.canManage) return "Pier 版本较旧，请在那台电脑上添加";
	return undefined;
}

/** Status line of a computer in menus: platform / address for paired ones, and why it is unusable. */
function computerDetail(computer: ComputerInfo, peers: PeerInfo[]): string {
	const blocker = addWorkspaceBlocker(computer);
	if (computer.local) return blocker ?? "本机";
	const peer = peers.find((p) => p.id === computer.id);
	return (
		blocker ?? [peer?.platform ? platformName(peer.platform) : "", peer?.addresses[0] ?? ""].filter(Boolean).join(" · ")
	);
}

/**
 * Menu entries that add a workspace on one of the computers (this one, or a paired one), plus
 * pairing another computer. `onDone` closes the surrounding menu.
 */
export function AddWorkspaceItems({ onDone }: { onDone: () => void }) {
	const store = useStore();
	const computers = useComputers();
	const peers = useAppState((s) => s.peers);
	return (
		<>
			<div className="dropdown-group-title no-caps">在哪台电脑上添加工作区？</div>
			{computers.map((computer) => {
				const blocked = addWorkspaceBlocker(computer) !== undefined;
				return (
					<button
						type="button"
						key={computer.id}
						className="dropdown-item"
						disabled={blocked}
						onClick={() => {
							onDone();
							void store.pickAndAddWorkspace(computer.id);
						}}
					>
						<span className="node-item-text">
							<span className="node-item-name">
								<IconMonitor size={14} />
								{computer.name}
							</span>
							<span className="muted">{computerDetail(computer, peers)}</span>
						</span>
					</button>
				);
			})}
			<div className="dropdown-separator" />
			<button
				type="button"
				className="dropdown-item"
				onClick={() => {
					onDone();
					store.openAddPeer();
				}}
			>
				<span className="menu-label">
					<IconPlus size={14} />
					添加电脑…
				</span>
			</button>
		</>
	);
}

/**
 * The "add workspace" button of the sidebar: straight to the directory dialog while this is
 * the only computer, else a menu of the computers to add it on.
 */
function AddWorkspaceButton() {
	const store = useStore();
	const hasPeers = useAppState((s) => s.peers.length > 0);
	const [open, setOpen] = useState(false);
	const ref = useOutsideClick(open, () => setOpen(false));
	return (
		<div className="dropdown" ref={ref}>
			<button
				type="button"
				className="ghost icon"
				title="添加工作区"
				onClick={() => (hasPeers ? setOpen(!open) : void store.pickAndAddWorkspace())}
			>
				<IconPlus size={14} />
			</button>
			{open ? (
				<div className="dropdown-menu node-menu add-workspace-menu">
					<AddWorkspaceItems onDone={() => setOpen(false)} />
				</div>
			) : null}
		</div>
	);
}

function SessionBadge({ session }: { session: SessionSummary }) {
	const store = useStore();
	useAppState((s) => s.chatsVersion);
	const live = store.liveChat(session.id)?.chat;
	const pending = live?.pendingUi.length ?? 0;
	const state = live?.loaded ? live.runState : session.state;
	if (pending) return <span className="badge-dot attention" title={`${pending} 个待处理请求`} />;
	if (isRunning(state)) {
		return <span className="badge-dot running" title="运行中" />;
	}
	return null;
}

function isRunning(state: SessionSummary["state"]): boolean {
	return state === "streaming" || state === "retrying" || state === "compacting";
}

function SessionItem({
	session,
	selected,
	canArchive,
}: {
	session: SessionSummary;
	selected: boolean;
	canArchive: boolean;
}) {
	const store = useStore();
	useAppState((s) => s.chatsVersion);
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const live = store.liveChat(session.id)?.chat;
	const running = isRunning(live?.loaded ? live.runState : session.state);
	const archived = !!session.archived;
	return (
		<div className={`session-item${confirm ? " confirming" : ""}${archived ? " archived" : ""}`}>
			<button
				type="button"
				className={`session-row${selected ? " selected" : ""}`}
				onClick={() => store.selectSession(session)}
				title={session.firstMessage || session.name || session.id}
			>
				<span className="session-row-title">{sessionTitle(session)}</span>
				{session.runtime && session.runtime !== "pi" ? (
					<span
						className={`session-agent agent-${session.runtime}`}
						title={`由 ${agentRuntimeLabel(session.runtime)} 运行`}
					>
						{agentRuntimeLabel(session.runtime)}
					</span>
				) : null}
				<SessionBadge session={session} />
				<span className="session-row-time">{relativeTime(session.modifiedAt)}</span>
			</button>
			<span className="session-actions">
				{canArchive && !confirm ? (
					<button
						type="button"
						className="session-action"
						disabled={busy}
						title={archived ? "取消归档" : "归档会话"}
						aria-label={archived ? "取消归档" : "归档会话"}
						onClick={async () => {
							setBusy(true);
							await store.archiveSession(session, !archived);
							setBusy(false);
						}}
					>
						{archived ? <IconArchiveRestore size={13} /> : <IconArchive size={13} />}
					</button>
				) : null}
				<button
					type="button"
					className={`session-action delete${confirm ? " confirm" : ""}`}
					disabled={busy}
					title={confirm ? undefined : "删除会话"}
					aria-label={confirm ? "确认删除会话" : "删除会话"}
					onBlur={() => setConfirm(false)}
					onMouseLeave={() => setConfirm(false)}
					onClick={async () => {
						if (!confirm) {
							setConfirm(true);
							return;
						}
						setBusy(true);
						const deleted = await store.deleteSession(session, running);
						if (!deleted) {
							setBusy(false);
							setConfirm(false);
						}
					}}
				>
					{confirm ? running ? "中止并删除" : "删除" : <IconTrash size={13} />}
				</button>
			</span>
		</div>
	);
}

function WorkspaceGroup({ workspace, onSettings }: { workspace: WorkspaceInfo; onSettings: () => void }) {
	const store = useStore();
	// Workspaces of every computer are listed together; paired computers' ones show its name.
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const revoked = useAppState((s) => !!s.nodes[node]?.revoked);
	useAppState((s) => s.peers);
	const canManage = useCanManageWorkspace(workspace.id);
	const local = node === LOCAL_NODE;
	const nodeName = store.nodeName(node);
	const expanded = useAppState((s) => !!s.expanded[workspace.id]);
	const sessions = useAppState((s) => s.sessions[workspace.id]);
	const selectedSessionId = useAppState((s) => s.selectedSessionId);
	const selectedWorkspaceId = useAppState((s) => s.selectedWorkspaceId);
	const newChat = useAppState((s) => !!s.newChat);
	const canArchive = useCanArchiveSessions(workspace.id);
	const [limit, setLimit] = useState(SESSION_PAGE);
	const [archivedLimit, setArchivedLimit] = useState(SESSION_PAGE);
	const [showArchived, setShowArchived] = useState(false);
	const [cleanup, setCleanup] = useState(false);
	const selected = selectedWorkspaceId === workspace.id && !selectedSessionId && !newChat;
	const current = sessions?.filter((s) => !s.archived);
	const archived = sessions?.filter((s) => s.archived) ?? [];
	// An archived session that is open keeps the archive expanded, so it stays visible.
	const archivedOpen = showArchived || archived.some((s) => s.id === selectedSessionId);
	return (
		<div className="workspace-group">
			<div className={`workspace-row${selected ? " selected" : ""}${online ? "" : " offline"}`}>
				<button
					type="button"
					className={`chevron-button${expanded ? " open" : ""}`}
					onClick={() => store.toggleExpanded(workspace.id)}
					title={expanded ? "收起" : "展开"}
				>
					<IconChevronRight size={14} />
				</button>
				<button
					type="button"
					className="workspace-name"
					title={local ? workspace.path : `${nodeName}：${workspace.path}`}
					onClick={() => store.selectWorkspace(workspace.id)}
				>
					<IconFolder size={15} className="workspace-icon" />
					<span className="workspace-label">{workspace.name}</span>
					{workspace.policy !== "smart" ? (
						<span className={`policy-tag ${workspace.policy}`}>{POLICY_LABEL[workspace.policy]}</span>
					) : null}
					{local ? null : (
						<span
							className={`workspace-node${online ? "" : " offline"}`}
							title={online ? `在 ${nodeName} 上` : revoked ? `${nodeName} 已移除这台电脑` : `${nodeName} 未连接`}
						>
							<IconMonitor size={11} />
							<span className="workspace-node-name">{nodeName}</span>
						</span>
					)}
				</button>
				{canArchive && online && sessions?.length ? (
					<button type="button" className="ghost icon" title="清理会话…" onClick={() => setCleanup(true)}>
						<IconBroom size={14} />
					</button>
				) : null}
				{canManage && online ? (
					<button type="button" className="ghost icon" title="工作区设置" onClick={onSettings}>
						<IconSettings size={14} />
					</button>
				) : null}
				<button
					type="button"
					className="ghost icon"
					title={`在「${workspace.name}」中新建会话`}
					onClick={() => store.startNewChat(workspace.id)}
				>
					<IconPlus size={15} />
				</button>
			</div>
			{expanded ? (
				<div className="session-list">
					{!sessions ? (
						<div className="session-empty">{online || local ? "加载中…" : `${nodeName} 未连接，连接后显示会话`}</div>
					) : null}
					{sessions && !sessions.length ? <div className="session-empty">还没有会话</div> : null}
					{sessions?.length && !current?.length ? <div className="session-empty">没有未归档的会话</div> : null}
					{current?.slice(0, limit).map((session) => (
						<SessionItem
							key={session.id}
							session={session}
							selected={session.id === selectedSessionId}
							canArchive={canArchive}
						/>
					))}
					{current && current.length > limit ? (
						<button type="button" className="session-more" onClick={() => setLimit(limit + SESSION_PAGE)}>
							显示更多（还有 {current.length - limit} 个）
						</button>
					) : null}
					{archived.length ? (
						<>
							<button
								type="button"
								className={`session-archived-toggle${archivedOpen ? " open" : ""}`}
								onClick={() => setShowArchived(!archivedOpen)}
								aria-expanded={archivedOpen}
							>
								<IconChevronRight size={12} />
								<IconArchive size={12} />
								<span>已归档（{archived.length}）</span>
							</button>
							{archivedOpen ? (
								<div className="session-archived-list">
									{archived.slice(0, archivedLimit).map((session) => (
										<SessionItem
											key={session.id}
											session={session}
											selected={session.id === selectedSessionId}
											canArchive={canArchive}
										/>
									))}
									{archived.length > archivedLimit ? (
										<button
											type="button"
											className="session-more"
											onClick={() => setArchivedLimit(archivedLimit + SESSION_PAGE)}
										>
											显示更多（还有 {archived.length - archivedLimit} 个）
										</button>
									) : null}
								</div>
							) : null}
						</>
					) : null}
				</div>
			) : null}
			{cleanup ? <SessionCleanupDialog workspace={workspace} onClose={() => setCleanup(false)} /> : null}
		</div>
	);
}

export function WorkspaceSettings({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
	const store = useStore();
	const [confirmRemove, setConfirmRemove] = useState(false);
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? LOCAL_NODE);
	return (
		<Modal title={`工作区设置 · ${workspace.name}`} onClose={onClose}>
			<div className="field">
				<div className="field-label">目录</div>
				<code className="path">{workspace.path}</code>
				{node === LOCAL_NODE ? null : (
					<div className="muted small">在 {store.nodeName(node)} 上，Agent 在那台电脑上运行</div>
				)}
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
				<button type="button" className="primary" onClick={onClose}>
					完成
				</button>
			</div>
		</Modal>
	);
}

export function Sidebar({ open = true }: { open?: boolean }) {
	const store = useStore();
	const workspaces = useAppState((s) => s.workspaces);
	const noModels = useAppState((s) => s.localProviders?.availableCount === 0);
	const updateReady = updatePending(useAppState((s) => s.update));
	const addWorkspace = useAddWorkspace();
	const [settingsFor, setSettingsFor] = useState<string | undefined>();
	const settingsWorkspace = workspaces.find((w) => w.id === settingsFor);
	// Collapsing the sidebar dismisses its workspace-settings dialog instead of hiding it.
	useEffect(() => {
		if (!open) setSettingsFor(undefined);
	}, [open]);
	const newChat = useAppState((s) => !!s.newChat);
	const status = useHostStatus();
	const online = status.online;
	const attention = updateReady ? "有可用更新" : noModels ? "还没有可用模型" : undefined;

	return (
		<aside className="sidebar">
			<div className="brand">
				<Logo size={26} />
				<span className="brand-name">Pier</span>
				<button
					type="button"
					className="ghost icon sidebar-collapse"
					title={`收起侧边栏（${SIDEBAR_SHORTCUT}）`}
					aria-label="收起侧边栏"
					onClick={() => store.toggleSidebar(false)}
				>
					<IconPanelLeft size={16} />
				</button>
			</div>
			<div className="sidebar-actions">
				<button
					type="button"
					className={`new-session-button${newChat ? " selected" : ""}`}
					disabled={!online}
					title="新建会话：选择工作区后发送第一条消息"
					onClick={() => store.startNewChat()}
				>
					<IconMessagePlus size={16} />
					<span>新建会话</span>
				</button>
			</div>
			<div className="sidebar-section-title">
				<span>工作区</span>
				{online ? <AddWorkspaceButton /> : null}
			</div>
			<div className="workspace-list">
				{workspaces.map((workspace) => (
					<WorkspaceGroup key={workspace.id} workspace={workspace} onSettings={() => setSettingsFor(workspace.id)} />
				))}
				{online && !workspaces.length ? (
					<button type="button" className="add-first" onClick={() => void addWorkspace()}>
						<IconFolderPlus size={16} />
						添加第一个工作区
					</button>
				) : null}
			</div>
			<div className="sidebar-footer">
				<button
					type="button"
					className="settings-entry"
					onClick={() => store.openSettings(updateReady ? "about" : noModels && online ? "models" : "general")}
					title={`${status.text}${attention ? ` · ${attention}` : ""}`}
				>
					<span className="settings-entry-icon">
						<IconSettings size={15} />
						{attention ? <span className={`entry-dot ${updateReady ? "accent" : "warn"}`} /> : null}
					</span>
					<span className="settings-entry-label">设置</span>
					<span className={`status-dot ${status.dot}`} />
				</button>
			</div>
			{settingsWorkspace ? (
				<WorkspaceSettings workspace={settingsWorkspace} onClose={() => setSettingsFor(undefined)} />
			) : null}
		</aside>
	);
}
