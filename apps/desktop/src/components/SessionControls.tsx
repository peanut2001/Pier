import type { ChatController, ChatState } from "@pier/chat-state";
import type { ApprovalPolicy, ForkPoint, WorkspaceInfo } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { POLICY_LABEL, POLICY_SUMMARY } from "../lib/format.ts";
import { useAppState, useCanArchiveSessions, useCanManageWorkspace, useStore } from "../lib/store.tsx";
import {
	IconArchive,
	IconArchiveRestore,
	IconCheck,
	IconChevronUp,
	IconGitBranch,
	IconMinimize,
	IconMore,
	IconShield,
	IconShieldAlert,
	IconTrash,
	IconX,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";

export function useOutsideClick(open: boolean, close: () => void) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) close();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open, close]);
	return ref;
}

const POLICIES: ApprovalPolicy[] = ["ask", "smart", "auto"];

/** Approval-policy (permission mode) picker shown in the composer. Applies to the whole workspace. */
export function PolicyPicker({ workspace }: { workspace: WorkspaceInfo }) {
	const store = useStore();
	const [open, setOpen] = useState(false);
	const ref = useOutsideClick(open, () => setOpen(false));
	const current = workspace.policy;
	// Paired computers on protocol 1.10+ let this one change their policies too.
	const local = useCanManageWorkspace(workspace.id);
	return (
		<div className="dropdown" ref={ref}>
			<button
				type="button"
				className={`chip policy-chip ${current}`}
				disabled={!local}
				onClick={() => setOpen(!open)}
				title={local ? "权限模式（对整个工作区生效）" : "那台电脑的 Pier 版本较旧，只能在那台电脑上修改权限模式"}
			>
				{current === "auto" ? <IconShieldAlert size={14} /> : <IconShield size={14} />}
				{POLICY_LABEL[current]}
				<IconChevronUp size={13} className="chip-caret" />
			</button>
			{open ? (
				<div className="dropdown-menu up right policies">
					<div className="dropdown-group-title no-caps">如何审批 Agent 的工具调用？</div>
					{POLICIES.map((policy) => {
						const selected = policy === current;
						return (
							<button
								type="button"
								key={policy}
								className={`dropdown-item policy-item ${policy}${selected ? " selected" : ""}`}
								onClick={() => {
									setOpen(false);
									if (!selected) void store.setPolicy(workspace.id, policy);
								}}
							>
								<span className="policy-item-text">
									<span className="policy-item-title">{POLICY_LABEL[policy]}</span>
									<span className="policy-item-desc">{POLICY_SUMMARY[policy]}</span>
								</span>
								{selected ? <IconCheck size={15} className="policy-check" /> : null}
							</button>
						);
					})}
					<div className="dropdown-note">对工作区「{workspace.name}」的所有会话立即生效</div>
				</div>
			) : null}
		</div>
	);
}

function ForkDialog({ controller, onClose }: { controller: ChatController; onClose: () => void }) {
	const store = useStore();
	const [points, setPoints] = useState<ForkPoint[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	useEffect(() => {
		controller
			.forkPoints()
			.then((r) => setPoints(r.points))
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, [controller]);
	const session = controller.chat.session;
	return (
		<Modal title="从历史消息分叉" onClose={onClose}>
			<p className="muted">
				选择一条你发送过的消息：新会话会保留它之前的全部上下文，并把这条消息放进输入框供你修改后重新发送。原会话保持不变。
			</p>
			{error ? <div className="error-text">{error}</div> : null}
			{!points && !error ? <div className="muted">加载中…</div> : null}
			{points && !points.length ? <div className="muted">还没有可以分叉的消息。</div> : null}
			<div className="fork-list">
				{[...(points ?? [])].reverse().map((point) => (
					<button
						type="button"
						key={point.entryId}
						className="fork-item"
						onClick={() => {
							onClose();
							if (session) void store.forkSession(session, point.entryId);
						}}
					>
						{point.text.slice(0, 300) || "（空消息）"}
					</button>
				))}
			</div>
		</Modal>
	);
}

function CompactDialog({ controller, onClose }: { controller: ChatController; onClose: () => void }) {
	const [instructions, setInstructions] = useState("");
	return (
		<Modal title="压缩上下文" onClose={onClose}>
			<p className="muted">让模型把此前的对话总结成摘要，释放上下文窗口。可以补充希望摘要重点保留的内容。</p>
			<textarea
				rows={4}
				placeholder="可选：摘要要点，例如“保留所有未完成的 TODO 和已修改的文件列表”"
				value={instructions}
				onChange={(e) => setInstructions(e.target.value)}
			/>
			<div className="modal-actions">
				<button type="button" onClick={onClose}>
					取消
				</button>
				<button
					type="button"
					className="primary"
					onClick={() => {
						onClose();
						void controller.compact(instructions.trim() || undefined);
					}}
				>
					开始压缩
				</button>
			</div>
		</Modal>
	);
}

export function SessionMenu({ chat, controller }: { chat: ChatState; controller: ChatController }) {
	const store = useStore();
	const [open, setOpen] = useState(false);
	const [dialog, setDialog] = useState<"fork" | "compact" | undefined>();
	const [confirmClose, setConfirmClose] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const ref = useOutsideClick(open, () => {
		setOpen(false);
		setConfirmClose(false);
		setConfirmDelete(false);
	});
	const session = chat.session;
	const idle = chat.runState === "idle";
	const canArchive = useCanArchiveSessions(session?.workspaceId);
	// The sidebar list knows the current archive state; the chat's copy is from its snapshot.
	const archived = useAppState((s) =>
		session ? (s.sessions[session.workspaceId]?.find((x) => x.id === session.id)?.archived ?? session.archived) : false,
	);
	return (
		<>
			<div className="dropdown" ref={ref}>
				<button type="button" className="chip icon-chip" onClick={() => setOpen(!open)} title="更多操作">
					<IconMore size={16} />
				</button>
				{open ? (
					<div className="dropdown-menu right">
						{chat.capabilities?.compact === false ? null : (
							<button
								type="button"
								className="dropdown-item"
								disabled={!idle}
								onClick={() => {
									setOpen(false);
									setDialog("compact");
								}}
							>
								<span className="menu-label">
									<IconMinimize size={14} />
									压缩上下文…
								</span>
							</button>
						)}
						{chat.capabilities?.fork === false ? null : (
							<button
								type="button"
								className="dropdown-item"
								onClick={() => {
									setOpen(false);
									setDialog("fork");
								}}
							>
								<span className="menu-label">
									<IconGitBranch size={14} />
									从历史消息分叉…
								</span>
							</button>
						)}
						<button
							type="button"
							className={`dropdown-item${confirmClose ? " danger" : ""}`}
							disabled={!session}
							onClick={() => {
								if (!session) return;
								const running = chat.runState !== "idle" && chat.runState !== "inactive";
								if (running && !confirmClose) {
									setConfirmClose(true);
									return;
								}
								setOpen(false);
								setConfirmClose(false);
								void store.closeSession(session, running);
							}}
						>
							<span className="menu-label">
								<IconX size={14} />
								{confirmClose ? "Agent 仍在运行：再次点击以中止并关闭" : "关闭会话"}
							</span>
						</button>
						{canArchive ? (
							<button
								type="button"
								className="dropdown-item"
								disabled={!session}
								onClick={() => {
									if (!session) return;
									setOpen(false);
									void store.archiveSession(session, !archived);
								}}
							>
								<span className="menu-label">
									{archived ? <IconArchiveRestore size={14} /> : <IconArchive size={14} />}
									{archived ? "取消归档" : "归档会话"}
								</span>
							</button>
						) : null}
						<button
							type="button"
							className="dropdown-item danger"
							disabled={!session}
							onClick={() => {
								if (!session) return;
								if (!confirmDelete) {
									setConfirmDelete(true);
									return;
								}
								const running = chat.runState !== "idle" && chat.runState !== "inactive";
								setOpen(false);
								setConfirmDelete(false);
								void store.deleteSession(session, running);
							}}
						>
							<span className="menu-label">
								<IconTrash size={14} />
								{confirmDelete
									? chat.runState !== "idle" && chat.runState !== "inactive"
										? "Agent 仍在运行：再次点击以中止并删除"
										: "再次点击确认删除"
									: "删除会话"}
							</span>
						</button>
					</div>
				) : null}
			</div>
			{dialog === "fork" ? <ForkDialog controller={controller} onClose={() => setDialog(undefined)} /> : null}
			{dialog === "compact" ? <CompactDialog controller={controller} onClose={() => setDialog(undefined)} /> : null}
		</>
	);
}
