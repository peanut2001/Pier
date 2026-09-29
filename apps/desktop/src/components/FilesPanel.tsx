import type { WorkspaceFileEntry, WorkspaceInfo } from "@pier/protocol";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, joinPath, relativeTime } from "../lib/format.ts";
import { hostCanDeleteFiles, LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import { terminals } from "../lib/terminals.ts";
import { ContextMenu, type ContextMenuItem, type ContextMenuPosition, contextMenuPosition } from "./ContextMenu.tsx";
import {
	IconAlert,
	IconChevronRight,
	IconChevronUp,
	IconCopy,
	IconExternal,
	IconFile,
	IconFolder,
	IconFolderOpen,
	IconLink,
	IconLoader,
	IconMessagePlus,
	IconPanelRight,
	IconRefresh,
	IconTerminal,
	IconTrash,
	IconX,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";

interface DirState {
	entries?: WorkspaceFileEntry[];
	error?: string;
	loading: boolean;
	truncated?: boolean;
	total?: number;
}

/** Expanded directories per workspace, kept while the app runs so switching back restores the tree. */
const expandedByWorkspace = new Map<string, Set<string>>();

const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
const revealLabel = /Mac/.test(platform)
	? "在访达中显示"
	: /Win/.test(platform)
		? "在资源管理器中显示"
		: "在文件管理器中显示";

/** The parent of a workspace-relative path (`""` for the workspace root). */
function parentPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function errorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持文件列表，请更新 Pier";
	if (code === "NOT_FOUND") return "目录不存在";
	if (code === "FORBIDDEN") return "无权访问该目录";
	return message;
}

/** Confirms and performs a permanent delete of one entry of the file panel. */
function DeleteDialog({
	workspace,
	entry,
	onClose,
}: {
	workspace: WorkspaceInfo;
	entry: WorkspaceFileEntry;
	onClose: () => void;
}) {
	const store = useStore();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const isDir = entry.kind === "directory" && !entry.symlink;
	const what = entry.symlink ? "符号链接" : isDir ? "文件夹" : "文件";
	const remove = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await store.deletePath(workspace.id, entry.path);
			store.toast("info", `已删除${what}「${entry.name}」`);
			onClose();
		} catch (e) {
			const code = (e as { code?: string }).code;
			setError(
				code === "NOT_FOUND"
					? `${what}已不存在`
					: code === "FORBIDDEN"
						? "没有权限删除，或它位于工作区之外"
						: errorText(e),
			);
			if (code === "NOT_FOUND") store.bumpFiles(workspace.id);
			setBusy(false);
		}
	};
	return (
		<Modal title={`删除${what}`} onClose={onClose}>
			<p>
				确定要永久删除{what}「<strong>{entry.name}</strong>」吗？
			</p>
			<code className="path">{joinPath(workspace.path, entry.path)}</code>
			<p className="muted small">
				{entry.symlink
					? "只删除这个链接，不影响它指向的内容。"
					: isDir
						? "文件夹中的所有文件和子文件夹都会一起删除。"
						: null}
				删除不会进入废纸篓 / 回收站，无法撤销。
			</p>
			{error ? <p className="error-text small">{error}</p> : null}
			<div className="modal-actions">
				{/* biome-ignore lint/a11y/noAutofocus: focus the safe choice so Enter does not delete. */}
				<button type="button" className="ghost" autoFocus disabled={busy} onClick={onClose}>
					取消
				</button>
				<button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
					{busy ? <IconLoader size={14} className="spin" /> : <IconTrash size={14} />}
					{busy ? "正在删除…" : "永久删除"}
				</button>
			</div>
		</Modal>
	);
}

function useWorkspaceTree(workspaceId: string) {
	const store = useStore();
	const [dirs, setDirs] = useState<Record<string, DirState>>({});
	const [expanded, setExpanded] = useState<Set<string>>(() => expandedByWorkspace.get(workspaceId) ?? new Set());
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	/** Latest request per directory, so a slow old answer never overwrites a newer one. */
	const requests = useRef(new Map<string, number>());
	const seq = useRef(0);

	const updateExpanded = useCallback(
		(fn: (set: Set<string>) => void) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				fn(next);
				expandedByWorkspace.set(workspaceId, next);
				return next;
			});
		},
		[workspaceId],
	);

	const load = useCallback(
		async (path: string) => {
			const id = ++seq.current;
			requests.current.set(path, id);
			setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true } }));
			try {
				const result = await store.listFiles(workspaceId, path);
				if (requests.current.get(path) !== id) return;
				setDirs((d) => ({
					...d,
					[path]: {
						entries: result.entries,
						loading: false,
						...(result.truncated ? { truncated: true, total: result.total } : {}),
					},
				}));
			} catch (error) {
				if (requests.current.get(path) !== id) return;
				// An expanded directory that disappeared collapses instead of showing an error.
				if (path && (error as { code?: string }).code === "NOT_FOUND") {
					updateExpanded((set) => {
						for (const p of [...set]) if (p === path || p.startsWith(`${path}/`)) set.delete(p);
					});
					setDirs((d) => {
						const { [path]: _gone, ...rest } = d;
						return rest;
					});
					return;
				}
				setDirs((d) => ({ ...d, [path]: { ...d[path], loading: false, error: errorText(error) } }));
			}
		},
		[store, workspaceId, updateExpanded],
	);

	const reload = useCallback(() => {
		void load("");
		for (const path of expandedRef.current) void load(path);
	}, [load]);

	const toggle = useCallback(
		(path: string) => {
			const open = !expandedRef.current.has(path);
			updateExpanded((set) => {
				if (open) set.add(path);
				else set.delete(path);
			});
			if (open) void load(path);
		},
		[load, updateExpanded],
	);

	const collapseAll = useCallback(() => updateExpanded((set) => set.clear()), [updateExpanded]);

	return { dirs, expanded, reload, toggle, collapseAll };
}

function entryTitle(entry: WorkspaceFileEntry): string {
	const parts = [entry.path];
	if (entry.kind === "file" && entry.size !== undefined) parts.push(formatBytes(entry.size));
	if (entry.modifiedAt) parts.push(`修改于 ${relativeTime(entry.modifiedAt)}`);
	if (entry.symlink) parts.push("符号链接");
	return parts.join(" · ");
}

function ResizeHandle() {
	const store = useStore();
	const width = useAppState((s) => s.filesPanelWidth);
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = width;
		const target = e.currentTarget;
		target.setPointerCapture(e.pointerId);
		document.body.classList.add("resizing-panel");
		const move = (ev: PointerEvent) => store.setFilesPanelWidth(startWidth + (startX - ev.clientX));
		const up = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", up);
			target.removeEventListener("pointercancel", up);
			document.body.classList.remove("resizing-panel");
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", up);
		target.addEventListener("pointercancel", up);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize affordance; width also persists.
		<div
			className="files-resize"
			title="拖动调整宽度，双击恢复默认"
			onPointerDown={onPointerDown}
			onDoubleClick={() => store.setFilesPanelWidth(280)}
		/>
	);
}

/**
 * `composerKey` is the draft key of the composer on screen (a session id, or the new-chat
 * draft); without it the panel only offers copying paths.
 */
export function FilesPanel({ workspace, composerKey }: { workspace: WorkspaceInfo; composerKey?: string }) {
	const store = useStore();
	const connection = useAppState((s) => s.connection);
	// Terminals and the file manager are on this computer: only for its own workspaces.
	const local = useAppState((s) => s.node === LOCAL_NODE);
	const canTerminal = terminals.supported && local;
	const canDelete = useAppState((s) => hostCanDeleteFiles(s.hostInfo));
	/** Entry awaiting delete confirmation. */
	const [deleting, setDeleting] = useState<WorkspaceFileEntry>();
	const version = useAppState((s) => s.filesVersion[workspace.id] ?? 0);
	const { dirs, expanded, reload, toggle, collapseAll } = useWorkspaceTree(workspace.id);
	const [selected, setSelected] = useState<string>();
	const [copied, setCopied] = useState<string>();
	/** Open context menu; without `entry` it is the menu for the workspace root (blank area). */
	const [menu, setMenu] = useState<{ position: ContextMenuPosition; entry?: WorkspaceFileEntry }>();
	const lastReload = useRef(0);
	/** Pending single-click preview, cancelled when the click turns out to be a double click. */
	const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(clickTimer.current), []);

	// Reload when opened, reconnected, or after an agent run in this workspace.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger.
	useEffect(() => {
		if (connection !== "open") return;
		lastReload.current = Date.now();
		reload();
	}, [connection, version, reload]);

	// Files often change outside Pier (an editor, git): refresh when the window regains focus.
	useEffect(() => {
		const onFocus = () => {
			if (Date.now() - lastReload.current < 2000) return;
			lastReload.current = Date.now();
			reload();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [reload]);

	const copyText = (text: string, badge?: string) => {
		void navigator.clipboard.writeText(text).then(
			() => {
				if (badge === undefined) return;
				setCopied(badge);
				setTimeout(() => setCopied((c) => (c === badge ? undefined : c)), 1200);
			},
			() => store.toast("error", "复制失败"),
		);
	};
	const copyPath = (entry: WorkspaceFileEntry) => copyText(entry.path, entry.path);
	const insert = (entry: WorkspaceFileEntry) => {
		if (composerKey) store.insertFileIntoComposer(composerKey, entry.path, entry.kind === "directory");
	};
	const refresh = () => {
		lastReload.current = Date.now();
		reload();
	};

	const menuItems = (entry?: WorkspaceFileEntry): ContextMenuItem[] => {
		const reveal = store.canRevealPaths;
		if (!entry) {
			return [
				{ label: "刷新", icon: <IconRefresh size={14} />, disabled: connection !== "open", onSelect: refresh },
				{ label: "全部折叠", icon: <IconChevronUp size={14} />, disabled: !expanded.size, onSelect: collapseAll },
				"separator",
				{ label: "复制工作区路径", icon: <IconCopy size={14} />, onSelect: () => copyText(workspace.path) },
				"separator",
				canTerminal && {
					label: "在终端中打开",
					icon: <IconTerminal size={14} />,
					onSelect: () => terminals.create({ workspace, cwd: workspace.path }),
				},
				reveal && {
					label: revealLabel,
					icon: <IconExternal size={14} />,
					onSelect: () => store.revealPath(workspace.path),
				},
			];
		}
		const isDir = entry.kind === "directory";
		const absolute = joinPath(workspace.path, entry.path);
		const open = isDir && expanded.has(entry.path);
		return [
			isDir
				? {
						label: open ? "折叠" : "展开",
						icon: open ? <IconFolder size={14} /> : <IconFolderOpen size={14} />,
						onSelect: () => toggle(entry.path),
					}
				: {
						label: "打开",
						icon: <IconFile size={14} />,
						disabled: entry.kind !== "file",
						onSelect: () => store.openFilePreview(workspace.id, entry.path, composerKey),
					},
			composerKey
				? { label: "插入路径到输入框", icon: <IconMessagePlus size={14} />, onSelect: () => insert(entry) }
				: null,
			"separator",
			{ label: "复制相对路径", icon: <IconCopy size={14} />, onSelect: () => copyPath(entry) },
			{
				label: "复制绝对路径",
				icon: <IconCopy size={14} />,
				onSelect: () => copyText(absolute, entry.path),
			},
			{ label: "复制名称", icon: <IconCopy size={14} />, onSelect: () => copyText(entry.name, entry.path) },
			"separator",
			canTerminal && {
				label: isDir ? "在终端中打开" : "在所在目录打开终端",
				icon: <IconTerminal size={14} />,
				onSelect: () =>
					terminals.create({ workspace, cwd: isDir ? absolute : joinPath(workspace.path, parentPath(entry.path)) }),
			},
			reveal && { label: revealLabel, icon: <IconExternal size={14} />, onSelect: () => store.revealPath(absolute) },
			"separator",
			canDelete && {
				label: "删除…",
				icon: <IconTrash size={14} />,
				hint: /Mac/.test(platform) ? "⌘⌫" : "Delete",
				danger: true,
				disabled: connection !== "open",
				onSelect: () => setDeleting(entry),
			},
		];
	};

	const renderDir = (path: string, depth: number) => {
		const dir = dirs[path];
		if (!dir || (!dir.entries && dir.loading)) {
			return (
				<div className="files-note" style={{ paddingLeft: 12 + depth * 14 }}>
					<IconLoader size={13} className="spin" />
					加载中…
				</div>
			);
		}
		if (dir.error && !dir.entries) {
			return (
				<div className="files-note error" style={{ paddingLeft: 12 + depth * 14 }}>
					<IconAlert size={13} />
					<span>{dir.error}</span>
				</div>
			);
		}
		const entries = dir.entries ?? [];
		if (!entries.length) {
			return (
				<div className="files-note" style={{ paddingLeft: 12 + depth * 14 + (depth ? 18 : 0) }}>
					{depth ? "空目录" : "工作区中还没有文件"}
				</div>
			);
		}
		return (
			<>
				{entries.map((entry) => {
					const isDir = entry.kind === "directory";
					const open = isDir && expanded.has(entry.path);
					return (
						<div key={entry.path}>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: the row's button is the focusable control; this only adds its context menu. */}
							<div
								className={`files-row${selected === entry.path ? " selected" : ""}${menu?.entry?.path === entry.path ? " menu-open" : ""}${entry.kind === "other" ? " dim" : ""}`}
								style={{ paddingLeft: 6 + depth * 14 }}
								onContextMenu={(event) => {
									event.preventDefault();
									event.stopPropagation();
									clearTimeout(clickTimer.current);
									setSelected(entry.path);
									setMenu({ position: contextMenuPosition(event), entry });
								}}
							>
								<button
									type="button"
									className="files-entry"
									title={entryTitle(entry)}
									{...(isDir ? { "aria-expanded": open } : {})}
									onKeyDown={(event) => {
										const del = event.key === "Delete" || (event.key === "Backspace" && event.metaKey);
										if (!del || !canDelete || connection !== "open") return;
										event.preventDefault();
										setSelected(entry.path);
										setDeleting(entry);
									}}
									onClick={(event) => {
										setSelected(entry.path);
										if (isDir) {
											toggle(entry.path);
											return;
										}
										clearTimeout(clickTimer.current);
										if (entry.kind !== "file" || event.detail > 1) return;
										// With a composer, wait briefly so a double click inserts the path instead.
										const open = () => store.openFilePreview(workspace.id, entry.path, composerKey);
										if (composerKey && event.detail === 1) clickTimer.current = setTimeout(open, 250);
										else open();
									}}
									onDoubleClick={() => {
										clearTimeout(clickTimer.current);
										if (!isDir) insert(entry);
									}}
								>
									<span className={`files-chevron${open ? " open" : ""}`}>
										{isDir ? <IconChevronRight size={12} /> : null}
									</span>
									<span className={`files-icon${isDir ? " dir" : ""}`}>
										{isDir ? open ? <IconFolderOpen size={14} /> : <IconFolder size={14} /> : <IconFile size={14} />}
									</span>
									<span className="files-name">{entry.name}</span>
									{entry.symlink ? <IconLink size={11} className="files-link" /> : null}
								</button>
								<span className="files-actions">
									{isDir && canTerminal ? (
										<button
											type="button"
											className="ghost icon"
											title="在终端中打开"
											onClick={() => terminals.create({ workspace, cwd: joinPath(workspace.path, entry.path) })}
										>
											<IconTerminal size={13} />
										</button>
									) : null}
									{composerKey ? (
										<button type="button" className="ghost icon" title="插入路径到输入框" onClick={() => insert(entry)}>
											<IconMessagePlus size={13} />
										</button>
									) : null}
									<button type="button" className="ghost icon" title="复制相对路径" onClick={() => copyPath(entry)}>
										<IconCopy size={13} />
									</button>
								</span>
								{copied === entry.path ? <span className="files-copied">已复制</span> : null}
							</div>
							{open ? renderDir(entry.path, depth + 1) : null}
						</div>
					);
				})}
				{dir.truncated ? (
					<div className="files-note" style={{ paddingLeft: 12 + depth * 14 + 18 }}>
						仅显示前 {entries.length} 项（共 {dir.total} 项）
					</div>
				) : null}
			</>
		);
	};

	const loading = Object.values(dirs).some((d) => d.loading);
	return (
		<aside className="files-panel" aria-label="工作区文件">
			<ResizeHandle />
			<header className="files-header">
				<div className="files-heading">
					<span className="files-title">文件</span>
					<span className="files-workspace" title={workspace.path}>
						{workspace.name}
					</span>
				</div>
				<button type="button" className="ghost icon" title="刷新" disabled={connection !== "open"} onClick={refresh}>
					<IconRefresh size={14} className={loading ? "spin" : undefined} />
				</button>
				<button type="button" className="ghost icon" title="全部折叠" disabled={!expanded.size} onClick={collapseAll}>
					<IconChevronUp size={14} />
				</button>
				<button type="button" className="ghost icon" title="关闭文件面板" onClick={() => store.toggleFilesPanel(false)}>
					<IconX size={14} />
				</button>
			</header>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: context menu for the blank area; every action is also in the header. */}
			<div
				className="files-tree"
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu({ position: contextMenuPosition(event) });
				}}
			>
				{connection === "open" || dirs[""] ? renderDir("", 0) : <div className="files-note">正在连接 Pier Host…</div>}
			</div>
			<div className="files-hint">
				{composerKey ? "单击查看内容，双击插入路径，右键更多操作" : "单击查看内容，右键更多操作"}
			</div>
			{menu ? (
				<ContextMenu
					position={menu.position}
					label={menu.entry ? menu.entry.name : workspace.name}
					items={menuItems(menu.entry)}
					onClose={() => setMenu(undefined)}
				/>
			) : null}
			{deleting ? <DeleteDialog workspace={workspace} entry={deleting} onClose={() => setDeleting(undefined)} /> : null}
		</aside>
	);
}

/** Header button that shows or hides the file panel. */
export function FilesPanelToggle() {
	const store = useStore();
	const open = useAppState((s) => s.filesPanel);
	return (
		<button
			type="button"
			className={`chip icon-chip${open ? " active" : ""}`}
			title={open ? "隐藏文件面板（Ctrl/⌘+Shift+E）" : "显示工作区文件（Ctrl/⌘+Shift+E）"}
			aria-pressed={open}
			onClick={() => store.toggleFilesPanel()}
		>
			<IconPanelRight size={15} />
		</button>
	);
}
