import { type ChatController, type ChatState, resolveSlash, runBuiltin, type SlashActions } from "@pier/chat-state";
import type { WorkspaceInfo } from "@pier/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Draft, useStore } from "../lib/store.tsx";
import { IconArrowUp, IconImage, IconStop, IconX } from "./Icons.tsx";
import { PolicyPicker } from "./SessionControls.tsx";
import { SlashMenu, type SlashMenuEntry, useSlashMenu } from "./SlashMenu.tsx";

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
	const fileInput = useRef<HTMLInputElement>(null);
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
	const menu = useSlashMenu(controller, draft.text);

	const actions: SlashActions = {
		newSession: () => store.createSession(controller.workspaceId),
		fork: (entryId) => (chat.session ? store.forkSession(chat.session, entryId) : false),
		notify: (level, message) => store.toast(level, message),
	};

	async function send(mode: "auto" | "steer" | "followUp", override?: string) {
		const text = (override ?? draft.text).trim();
		if (closed || !chat.loaded || sending || (!text && !draft.images.length)) return;
		const images = draft.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
		const previous = { ...draft, text: override ?? draft.text };
		const cleared = { text: "", images: [] };

		let resolution = resolveSlash(text, menu.list.commands, menu.list.known);
		if (resolution.kind === "unknown" || (resolution.kind === "host" && !menu.list.known)) {
			// The list may be stale (or still loading) right after typing.
			const fresh = await controller.loadCommands();
			resolution = resolveSlash(text, fresh.commands, fresh.known);
		}
		if (resolution.kind === "unknown") {
			store.toast("error", `未知命令 /${resolution.name}，输入 / 查看可用的命令`);
			return;
		}

		setSending(true);
		if (resolution.kind === "builtin") {
			// Built-ins keep attached images; clear the text first because /new and /fork switch sessions.
			const kept = { ...previous, text: "" };
			setDraft(kept);
			store.saveDraft(sessionId, kept);
			const result = await runBuiltin(controller, resolution.name, resolution.args, actions);
			setSending(false);
			if (result.kind === "failed") setDraft(previous);
			else if (result.kind === "complete") setDraft({ ...previous, text: result.text });
			textarea.current?.focus();
			return;
		}

		setDraft(cleared);
		const result =
			resolution.kind === "host"
				? await controller.sendCommand(text, images, mode)
				: await controller.send(text, images, mode);
		setSending(false);
		if (result === undefined) setDraft(previous);
		textarea.current?.focus();
	}

	function pick(entry: SlashMenuEntry, tab = false) {
		const next = entry.pick(tab);
		if (next.run) void send(running ? "steer" : "auto", next.text);
		else setDraft((d) => ({ ...d, text: next.text }));
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
								<IconX size={11} />
							</button>
						</div>
					))}
				</div>
			) : null}
			<SlashMenu menu={menu} onPick={(entry) => pick(entry)} />
			<textarea
				ref={textarea}
				rows={1}
				value={draft.text}
				disabled={closed}
				placeholder={
					closed
						? "会话已关闭"
						: running
							? "补充指示以引导当前任务，Esc 停止…"
							: "描述你的任务…（Enter 发送，Shift+Enter 换行，/ 使用命令）"
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
					if (menu.open) {
						const entry = menu.entries[menu.active];
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							if (menu.entries.length) {
								e.preventDefault();
								menu.move(e.key === "ArrowDown" ? 1 : -1);
							}
							return;
						}
						if (e.key === "Escape") {
							e.preventDefault();
							menu.dismiss();
							return;
						}
						if (entry && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.altKey))) {
							e.preventDefault();
							pick(entry, e.key === "Tab");
							return;
						}
					}
					if (e.key === "Escape" && running) {
						e.preventDefault();
						void controller.abort();
					} else if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						void send(running ? (e.altKey ? "followUp" : "steer") : "auto");
					}
				}}
			/>
			<div className="composer-toolbar">
				<div className="composer-toolbar-left">
					<button
						type="button"
						className="ghost icon composer-attach"
						title="添加图片（也可以粘贴或拖入）"
						disabled={closed}
						onClick={() => fileInput.current?.click()}
					>
						<IconImage size={16} />
					</button>
					<input
						ref={fileInput}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={(e) => {
							const files = [...(e.target.files ?? [])];
							e.target.value = "";
							void addFiles(files);
						}}
					/>
					{workspace ? <PolicyPicker workspace={workspace} /> : null}
				</div>
				<div className="composer-actions">
					{running ? (
						<>
							<span className="composer-hint">Enter 引导 · Alt+Enter 排队</span>
							<button
								type="button"
								className="subtle"
								disabled={!canSend}
								onClick={() => void send("followUp")}
								title="Alt+Enter"
							>
								排队
							</button>
							<button
								type="button"
								className="subtle accent"
								disabled={!canSend}
								onClick={() => void send("steer")}
								title="Enter"
							>
								引导
							</button>
							<button
								type="button"
								className="round-button stop"
								onClick={() => void controller.abort()}
								title="停止（Esc）"
							>
								<IconStop size={14} />
							</button>
						</>
					) : (
						<button
							type="button"
							className="round-button send"
							disabled={!canSend}
							onClick={() => void send("auto")}
							title="发送（Enter）"
						>
							<IconArrowUp size={17} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
