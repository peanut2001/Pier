import type { ChatState } from "@pier/chat-state";
import type { ForkPoint, ModelInfo, ThinkingLevel } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import type { ChatController } from "../lib/chat-controller.ts";
import { useStore } from "../lib/store.tsx";
import { Modal } from "./Modal.tsx";

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
	{ value: "off", label: "不思考" },
	{ value: "minimal", label: "极少" },
	{ value: "low", label: "低" },
	{ value: "medium", label: "中" },
	{ value: "high", label: "高" },
	{ value: "xhigh", label: "很高" },
	{ value: "max", label: "最高" },
];

function useOutsideClick(open: boolean, close: () => void) {
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

export function ModelPicker({ chat, controller }: { chat: ChatState; controller: ChatController }) {
	const [open, setOpen] = useState(false);
	const [models, setModels] = useState<ModelInfo[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [filter, setFilter] = useState("");
	const ref = useOutsideClick(open, () => setOpen(false));
	const current = chat.model;

	useEffect(() => {
		if (!open) return;
		setError(undefined);
		controller
			.listModels()
			.then((r) => setModels(r.models))
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, [open, controller]);

	const visible = (models ?? []).filter((m) =>
		`${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	const groups = new Map<string, ModelInfo[]>();
	for (const model of visible) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);

	return (
		<div className="dropdown" ref={ref}>
			<button type="button" className="chip" onClick={() => setOpen(!open)} title="切换模型">
				{current ? current.name || current.id : "未选择模型"} ▾
			</button>
			{open ? (
				<div className="dropdown-menu models">
					<input
						// biome-ignore lint/a11y/noAutofocus: the menu was just opened to search.
						autoFocus
						placeholder="搜索模型"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
					{error ? <div className="dropdown-empty error">{error}</div> : null}
					{!models && !error ? <div className="dropdown-empty">加载中…</div> : null}
					{models && !visible.length ? (
						<div className="dropdown-empty">没有可用模型。请先用 pi 登录或配置模型。</div>
					) : null}
					{[...groups].map(([provider, list]) => (
						<div key={provider} className="dropdown-group">
							<div className="dropdown-group-title">{provider}</div>
							{list.map((model) => {
								const selected = current?.provider === model.provider && current.id === model.id;
								return (
									<button
										type="button"
										key={model.id}
										className={`dropdown-item${selected ? " selected" : ""}`}
										onClick={() => {
											setOpen(false);
											if (!selected) void controller.setModel(model.provider, model.id);
										}}
									>
										<span>{model.name || model.id}</span>
										<span className="muted">
											{model.reasoning ? "推理 · " : ""}
											{model.id}
										</span>
									</button>
								);
							})}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

export function ThinkingPicker({ chat, controller }: { chat: ChatState; controller: ChatController }) {
	if (!chat.model?.reasoning) return null;
	return (
		<select
			className="chip"
			title="思考等级"
			value={chat.thinkingLevel}
			onChange={(e) => void controller.setThinking(e.target.value as ThinkingLevel)}
		>
			{THINKING_LEVELS.map((level) => (
				<option key={level.value} value={level.value}>
					思考：{level.label}
				</option>
			))}
		</select>
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
	const ref = useOutsideClick(open, () => {
		setOpen(false);
		setConfirmClose(false);
	});
	const session = chat.session;
	const idle = chat.runState === "idle";
	return (
		<>
			<div className="dropdown" ref={ref}>
				<button type="button" className="chip" onClick={() => setOpen(!open)} title="更多操作">
					⋯
				</button>
				{open ? (
					<div className="dropdown-menu right">
						<button
							type="button"
							className="dropdown-item"
							disabled={!idle}
							onClick={() => {
								setOpen(false);
								setDialog("compact");
							}}
						>
							压缩上下文…
						</button>
						<button
							type="button"
							className="dropdown-item"
							onClick={() => {
								setOpen(false);
								setDialog("fork");
							}}
						>
							从历史消息分叉…
						</button>
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
							{confirmClose ? "Agent 仍在运行：再次点击以中止并关闭" : "关闭会话"}
						</button>
					</div>
				) : null}
			</div>
			{dialog === "fork" ? <ForkDialog controller={controller} onClose={() => setDialog(undefined)} /> : null}
			{dialog === "compact" ? <CompactDialog controller={controller} onClose={() => setDialog(undefined)} /> : null}
		</>
	);
}
