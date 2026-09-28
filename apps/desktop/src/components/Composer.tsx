import type { ChatController, ChatState } from "@pier/chat-state";
import type { WorkspaceInfo } from "@pier/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Draft, useStore } from "../lib/store.tsx";
import { PolicyPicker } from "./SessionControls.tsx";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function readImage(file: File): Promise<Draft["images"][number]> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve({ data: url.slice(url.indexOf(",") + 1), mimeType: file.type, name: file.name || "图片" });
		};
		reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
		reader.readAsDataURL(file);
	});
}

export function Composer({
	chat,
	controller,
	workspace,
}: {
	chat: ChatState;
	controller: ChatController;
	workspace?: WorkspaceInfo;
}) {
	const store = useStore();
	const sessionId = chat.sessionId;
	const [draft, setDraft] = useState<Draft>(() => store.draft(sessionId));
	const textarea = useRef<HTMLTextAreaElement>(null);
	const [sending, setSending] = useState(false);
	const [dragging, setDragging] = useState(false);

	// The parent remounts the composer per session (`key={sessionId}`), so the draft state
	// always belongs to `sessionId`.
	useEffect(() => {
		textarea.current?.focus();
	}, []);

	useEffect(() => {
		store.saveDraft(sessionId, draft);
	}, [store, sessionId, draft]);

	// An extension asked to prefill the editor.
	const editorNonce = chat.editorText?.nonce;
	// biome-ignore lint/correctness/useExhaustiveDependencies: react to new requests only.
	useEffect(() => {
		if (chat.editorText) {
			setDraft((d) => ({ ...d, text: chat.editorText?.text ?? "" }));
			textarea.current?.focus();
		}
	}, [editorNonce]);

	useLayoutEffect(() => {
		const el = textarea.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
	});

	const running = chat.runState === "streaming" || chat.runState === "retrying" || chat.runState === "compacting";
	const closed = !!chat.closed;
	const canSend = !closed && chat.loaded && !sending && (draft.text.trim().length > 0 || draft.images.length > 0);

	async function send(mode: "auto" | "steer" | "followUp") {
		if (!canSend) return;
		const text = draft.text.trim();
		const images = draft.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
		setSending(true);
		const previous = draft;
		setDraft({ text: "", images: [] });
		const result = await controller.send(text, images, mode);
		setSending(false);
		if (result === undefined) setDraft(previous);
		textarea.current?.focus();
	}

	async function addFiles(files: Iterable<File>) {
		const images: Draft["images"] = [];
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > MAX_IMAGE_BYTES) {
				store.toast("warning", `图片 ${file.name} 超过 20 MB，已忽略`);
				continue;
			}
			images.push(await readImage(file));
		}
		if (images.length) setDraft((d) => ({ ...d, images: [...d.images, ...images].slice(0, 16) }));
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target for pasted/dragged images.
		<div
			className={`composer${dragging ? " dragging" : ""}`}
			onDragOver={(e) => {
				if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDragging(false);
				void addFiles(e.dataTransfer.files);
			}}
		>
			{draft.images.length ? (
				<div className="composer-images">
					{draft.images.map((image, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional attachments.
						<div key={i} className="composer-image">
							<img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
							<button
								type="button"
								title="移除"
								onClick={() => setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))}
							>
								×
							</button>
						</div>
					))}
				</div>
			) : null}
			<textarea
				ref={textarea}
				rows={1}
				value={draft.text}
				disabled={closed}
				placeholder={
					closed
						? "会话已关闭"
						: running
							? "Agent 运行中：Enter 引导当前任务，Alt+Enter 排队到完成后，Esc 停止"
							: "输入任务…（Enter 发送，Shift+Enter 换行，可粘贴图片）"
				}
				onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
				onPaste={(e) => {
					const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
					if (files.length) {
						e.preventDefault();
						void addFiles(files);
					}
				}}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing || e.keyCode === 229) return;
					if (e.key === "Escape" && running) {
						e.preventDefault();
						void controller.abort();
					} else if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						void send(running ? (e.altKey ? "followUp" : "steer") : "auto");
					}
				}}
			/>
			<div className="composer-actions">
				{workspace ? <PolicyPicker workspace={workspace} /> : null}
				{running ? (
					<>
						<button type="button" className="danger" onClick={() => void controller.abort()} title="Esc">
							停止
						</button>
						<button type="button" disabled={!canSend} onClick={() => void send("followUp")} title="Alt+Enter">
							排队
						</button>
						<button type="button" className="primary" disabled={!canSend} onClick={() => void send("steer")}>
							引导
						</button>
					</>
				) : (
					<button type="button" className="primary" disabled={!canSend} onClick={() => void send("auto")}>
						发送
					</button>
				)}
			</div>
		</div>
	);
}
