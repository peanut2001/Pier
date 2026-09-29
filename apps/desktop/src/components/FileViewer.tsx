import type { WorkspaceFileContent } from "@pier/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, languageForPath, relativeTime } from "../lib/format.ts";
import { isSensitiveFile } from "../lib/sensitive-files.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { IconAlert, IconFile, IconLoader, IconMessagePlus, IconRefresh, IconShieldAlert } from "./Icons.tsx";
import { CopyButton, Markdown } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";
import { Highlighted } from "./ToolCard.tsx";

function errorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持预览文件，请更新 Pier";
	if (code === "NOT_FOUND") return "文件不存在，可能已被移动或删除";
	if (code === "FORBIDDEN") return /outside/.test(message) ? "该文件位于工作区之外，无法预览" : "没有权限读取该文件";
	if (code === "BAD_REQUEST" && /Not a file/.test(message)) return "这不是普通文件，无法预览";
	return message;
}

const MARKDOWN = /\.(md|markdown|mdx)$/i;

function TextView({ file }: { file: WorkspaceFileContent }) {
	const text = file.text ?? "";
	const lines = useMemo(() => {
		const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
		return Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).join("\n");
	}, [text]);
	if (!text) return <div className="file-viewer-empty">空文件</div>;
	return (
		<div className="file-viewer-code">
			<pre className="file-viewer-gutter" aria-hidden="true">
				{lines}
			</pre>
			<pre className="file-viewer-text">
				<Highlighted code={text} language={languageForPath(file.path)} />
			</pre>
		</div>
	);
}

/**
 * Read-only preview of one workspace file: text with line numbers and syntax highlighting,
 * rendered Markdown, or an image. `onInsert` inserts the path into the composer when present.
 */
export function FileViewer({
	workspaceId,
	path,
	onClose,
	onInsert,
}: {
	workspaceId: string;
	path: string;
	onClose: () => void;
	onInsert?: (() => void) | undefined;
}) {
	const store = useStore();
	const [confirmed, setConfirmed] = useState(() => !isSensitiveFile(path));
	const [file, setFile] = useState<WorkspaceFileContent>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [rendered, setRendered] = useState(true);
	const request = useRef(0);

	const load = useCallback(async () => {
		const id = ++request.current;
		setLoading(true);
		setError(undefined);
		try {
			const result = await store.readFile(workspaceId, path);
			if (request.current === id) setFile(result);
		} catch (e) {
			if (request.current === id) setError(errorText(e));
		} finally {
			if (request.current === id) setLoading(false);
		}
	}, [store, workspaceId, path]);

	useEffect(() => {
		if (confirmed) void load();
	}, [confirmed, load]);

	const name = path.split("/").pop() ?? path;
	const isMarkdown = MARKDOWN.test(path) && file?.kind === "text";

	let body: ReactNode;
	if (!confirmed) {
		body = (
			<div className="file-viewer-notice warning">
				<IconShieldAlert size={22} />
				<div>
					<strong>这个文件可能包含私钥或凭据</strong>
					<p>内容会显示在屏幕上，请确认周围没有旁人或屏幕共享。</p>
				</div>
				<button type="button" className="subtle" onClick={() => setConfirmed(true)}>
					仍然显示
				</button>
			</div>
		);
	} else if (error) {
		body = (
			<div className="file-viewer-notice error">
				<IconAlert size={20} />
				<div>
					<strong>无法打开文件</strong>
					<p>{error}</p>
				</div>
				<button type="button" className="subtle" onClick={() => void load()}>
					重试
				</button>
			</div>
		);
	} else if (!file) {
		body = (
			<div className="file-viewer-empty">
				<IconLoader size={16} className="spin" />
				正在读取…
			</div>
		);
	} else if (file.kind === "image") {
		body = file.data ? (
			<div className="file-viewer-image">
				<img src={`data:${file.mimeType};base64,${file.data}`} alt={name} />
			</div>
		) : (
			<div className="file-viewer-empty">图片太大（{formatBytes(file.size)}），无法预览</div>
		);
	} else if (file.kind === "binary") {
		body = (
			<div className="file-viewer-empty">
				<IconFile size={16} />
				二进制文件，无法以文本显示
			</div>
		);
	} else {
		body = (
			<>
				{file.truncated ? (
					<div className="file-viewer-banner">文件较大（{formatBytes(file.size)}），仅显示开头部分</div>
				) : null}
				{isMarkdown && rendered ? (
					<div className="file-viewer-markdown">
						<Markdown text={file.text ?? ""} />
					</div>
				) : (
					<TextView file={file} />
				)}
			</>
		);
	}

	return (
		<Modal title={name} onClose={onClose} wide className="file-viewer">
			<div className="file-viewer-toolbar">
				<span className="file-viewer-meta" title={path}>
					<span className="file-viewer-path">{path}</span>
					{file ? (
						<span>
							{formatBytes(file.size)} · 修改于 {relativeTime(file.modifiedAt)}
						</span>
					) : null}
				</span>
				<span className="file-viewer-actions">
					{isMarkdown ? (
						<span className="segmented" role="tablist" aria-label="显示方式">
							<button
								type="button"
								className={rendered ? "active" : ""}
								role="tab"
								aria-selected={rendered}
								onClick={() => setRendered(true)}
							>
								预览
							</button>
							<button
								type="button"
								className={rendered ? "" : "active"}
								role="tab"
								aria-selected={!rendered}
								onClick={() => setRendered(false)}
							>
								源码
							</button>
						</span>
					) : null}
					{file?.kind === "text" && file.text ? <CopyButton text={file.text} label="复制内容" /> : null}
					<CopyButton text={path} label="复制路径" iconOnly />
					{onInsert ? (
						<button
							type="button"
							className="ghost icon"
							title="插入路径到输入框"
							onClick={() => {
								onInsert();
								onClose();
							}}
						>
							<IconMessagePlus size={14} />
						</button>
					) : null}
					<button
						type="button"
						className="ghost icon"
						title="重新读取"
						disabled={!confirmed || loading}
						onClick={() => void load()}
					>
						<IconRefresh size={14} className={loading ? "spin" : undefined} />
					</button>
				</span>
			</div>
			<div className="file-viewer-body">{body}</div>
		</Modal>
	);
}

/** The preview dialog opened from the file panel or a composer file chip. */
export function FilePreview() {
	const store = useStore();
	const preview = useAppState((s) => s.filePreview);
	const known = useAppState((s) => !!preview && s.workspaces.some((w) => w.id === preview.workspaceId));
	if (!preview || !known) return null;
	const { workspaceId, path, composerKey } = preview;
	return (
		<FileViewer
			key={`${workspaceId}:${path}`}
			workspaceId={workspaceId}
			path={path}
			onClose={() => store.closeFilePreview()}
			onInsert={composerKey ? () => store.insertFileIntoComposer(composerKey, path) : undefined}
		/>
	);
}
