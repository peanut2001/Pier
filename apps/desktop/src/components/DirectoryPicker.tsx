import type { HostDirectoryListing } from "@pier/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppState, useStore } from "../lib/store.tsx";
import { IconArrowUp, IconFolder, IconHome, IconLoader, IconRefresh } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function baseName(path: string, separator: string): string {
	const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
	return trimmed.split(separator).pop() || trimmed;
}

/**
 * Browse the directories of a paired computer and pick one, e.g. as a workspace.
 * Opened with `store.pickNodeDirectory()`; this computer uses the system dialog instead.
 */
export function DirectoryPicker() {
	const store = useStore();
	const picker = useAppState((s) => s.directoryPicker);
	const node = picker?.node;
	const online = useAppState((s) => !!node && s.nodes[node]?.connection === "open");
	const [listing, setListing] = useState<HostDirectoryListing>();
	const [input, setInput] = useState("");
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [showHidden, setShowHidden] = useState(false);
	const request = useRef(0);
	useAppState((s) => s.peers);
	const name = node ? store.nodeName(node) : "";

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

	useEffect(() => {
		if (!picker) {
			request.current++;
			setListing(undefined);
			setError(undefined);
			setInput("");
			return;
		}
		void load();
	}, [picker, load]);

	if (!picker) return null;
	const close = () => store.resolveDirectoryPicker(null);
	const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));
	const hiddenCount = (listing?.entries.length ?? 0) - entries.length;

	return (
		<Modal title={`${picker.title} · ${name}`} onClose={close} className="directory-picker">
			<p className="muted small directory-picker-intro">
				浏览 {name} 上的目录。Agent 会在所选目录中读写文件、运行命令。
			</p>
			<form
				className="directory-picker-bar"
				onSubmit={(e) => {
					e.preventDefault();
					const path = input.trim();
					if (path) void load(path);
				}}
			>
				<button
					type="button"
					className="ghost icon"
					title="上一级目录"
					disabled={!listing?.parent || loading}
					onClick={() => listing?.parent && void load(listing.parent)}
				>
					<IconArrowUp size={15} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title="主目录"
					disabled={loading}
					onClick={() => void load(listing?.home)}
				>
					<IconHome size={15} />
				</button>
				<input
					className="mono"
					value={input}
					spellCheck={false}
					placeholder="输入绝对路径后按回车"
					onChange={(e) => setInput(e.target.value)}
				/>
				<button
					type="button"
					className="ghost icon"
					title="刷新"
					disabled={loading}
					onClick={() => void load(listing?.path)}
				>
					{loading ? <IconLoader size={15} className="spin" /> : <IconRefresh size={15} />}
				</button>
			</form>
			<div className="directory-picker-list">
				{error ? (
					<div className="directory-picker-empty error-text">{error}</div>
				) : !listing ? (
					<div className="directory-picker-empty muted">正在读取…</div>
				) : entries.length ? (
					entries.map((entry) => (
						<button
							type="button"
							key={entry.path}
							className="directory-picker-item"
							title={entry.path}
							disabled={loading}
							onClick={() => void load(entry.path)}
						>
							<IconFolder size={14} />
							<span className="directory-picker-name">{entry.name}</span>
							{entry.symlink ? <span className="mini-tag">链接</span> : null}
						</button>
					))
				) : (
					<div className="directory-picker-empty muted">没有子目录</div>
				)}
				{listing?.truncated ? (
					<div className="directory-picker-empty muted">
						只显示前 {listing.entries.length} 个（共 {listing.total} 个），可以直接输入路径。
					</div>
				) : null}
			</div>
			<label className="directory-picker-hidden muted small">
				<input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
				显示隐藏目录{hiddenCount > 0 ? `（${hiddenCount}）` : ""}
			</label>
			<div className="modal-actions">
				<button type="button" onClick={close}>
					取消
				</button>
				<button
					type="button"
					className="primary"
					disabled={!listing || loading || !online || !!error}
					title={listing?.path}
					onClick={() => listing && store.resolveDirectoryPicker(listing.path)}
				>
					选择「{listing ? baseName(listing.path, listing.separator) : "…"}」
				</button>
			</div>
		</Modal>
	);
}
