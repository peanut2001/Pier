import type { ChatController, ChatState } from "@pier/chat-state";
import type { ModelInfo, ThinkingLevel, WorkspaceInfo } from "@pier/protocol";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { LOCAL_NODE, useAppState, useStore } from "../lib/store.tsx";
import {
	IconArrowLeft,
	IconBrain,
	IconCheck,
	IconChevronRight,
	IconChevronUp,
	IconSearch,
	IconSettings,
	IconSparkles,
} from "./Icons.tsx";
import { useOutsideClick } from "./SessionControls.tsx";

export const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
	{ value: "off", label: "不思考" },
	{ value: "minimal", label: "极少" },
	{ value: "low", label: "低" },
	{ value: "medium", label: "中" },
	{ value: "high", label: "高" },
	{ value: "xhigh", label: "很高" },
	{ value: "max", label: "最高" },
];

const ORDER = THINKING_LEVELS.map((l) => l.value);

export function thinkingLabel(level: string): string {
	return THINKING_LEVELS.find((l) => l.value === level)?.label ?? level;
}

/** Thinking levels a model supports, lowest first (all of them for hosts before protocol 1.19). */
export function supportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model?.reasoning) return ["off"];
	const levels = model.thinkingLevels?.filter((l) => ORDER.includes(l));
	return levels?.length ? [...levels].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)) : ORDER;
}

/** The level the host would use for `level` on a model supporting `levels` (pi's clamping). */
export function clampThinking(level: string, levels: ThinkingLevel[]): ThinkingLevel {
	if (levels.includes(level as ThinkingLevel)) return level as ThinkingLevel;
	const index = ORDER.indexOf(level as ThinkingLevel);
	if (index >= 0) {
		const higher = ORDER.slice(index).find((l) => levels.includes(l));
		if (higher) return higher;
		const lower = ORDER.slice(0, index)
			.reverse()
			.find((l) => levels.includes(l));
		if (lower) return lower;
	}
	return levels[0] ?? "off";
}

/** A stepped slider for the thinking level, like a progress bar with one stop per level. */
function ThinkingSlider({
	levels,
	value,
	onChange,
}: {
	levels: ThinkingLevel[];
	value: ThinkingLevel;
	onChange: (level: ThinkingLevel) => void;
}) {
	const track = useRef<HTMLDivElement>(null);
	const [dragging, setDragging] = useState<number | undefined>();
	const committed = Math.max(0, levels.indexOf(value));
	const index = dragging ?? committed;
	const last = levels.length - 1;
	const percent = last > 0 ? (index / last) * 100 : 0;

	const indexAt = (clientX: number): number => {
		const rect = track.current?.getBoundingClientRect();
		if (!rect || last <= 0) return 0;
		const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		return Math.round(ratio * last);
	};
	const commit = (next: number) => {
		const level = levels[next];
		if (level && level !== value) onChange(level);
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.currentTarget.focus();
		setDragging(indexAt(e.clientX));
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (dragging !== undefined) setDragging(indexAt(e.clientX));
	};
	const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
		if (dragging === undefined) return;
		const next = indexAt(e.clientX);
		setDragging(undefined);
		commit(next);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step: Record<string, number> = {
			ArrowLeft: -1,
			ArrowDown: -1,
			ArrowRight: 1,
			ArrowUp: 1,
		};
		let next: number | undefined;
		if (e.key in step) next = Math.min(last, Math.max(0, committed + (step[e.key] ?? 0)));
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = last;
		if (next === undefined) return;
		e.preventDefault();
		commit(next);
	};

	return (
		<div
			ref={track}
			className={`thinking-slider${dragging !== undefined ? " dragging" : ""}`}
			role="slider"
			tabIndex={0}
			aria-label="思考程度"
			aria-valuemin={0}
			aria-valuemax={last}
			aria-valuenow={index}
			aria-valuetext={thinkingLabel(levels[index] ?? value)}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={() => setDragging(undefined)}
			onKeyDown={onKeyDown}
		>
			<div className="thinking-slider-rail">
				<div className="thinking-slider-fill" style={{ width: `calc(${percent}% + 24px)` }} />
				{levels.map((level, i) => (
					<span
						key={level}
						className={`thinking-slider-stop${i <= index ? " passed" : ""}`}
						style={{ left: `${last > 0 ? (i / last) * 100 : 0}%` }}
						title={thinkingLabel(level)}
					/>
				))}
				<span className="thinking-slider-thumb" style={{ left: `${percent}%` }} />
			</div>
		</div>
	);
}

interface ModelMenuProps {
	/** The computer whose models these are (for "manage models"). */
	node: string;
	model?: ModelInfo;
	thinkingLevel?: string;
	/** Still resolving which model will be used (the chip shows a placeholder). */
	loading?: boolean;
	disabled?: boolean;
	loadModels: () => Promise<ModelInfo[]>;
	onModel: (model: ModelInfo) => void;
	onThinking: (level: ThinkingLevel) => void;
}

/**
 * The composer's model chip: a popover with the thinking-level slider and the current model,
 * which opens the model list (as in ChatGPT / Codex).
 */
function ModelMenu({ node, model, thinkingLevel, loading, disabled, loadModels, onModel, onThinking }: ModelMenuProps) {
	const store = useStore();
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"main" | "models">("main");
	const [models, setModels] = useState<ModelInfo[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [filter, setFilter] = useState("");
	const close = () => setOpen(false);
	const ref = useOutsideClick(open, close);
	const levels = supportedThinkingLevels(model);
	const canThink = levels.length > 1;
	const level = clampThinking(thinkingLevel ?? "medium", levels);

	// biome-ignore lint/correctness/useExhaustiveDependencies: load once per opening.
	useEffect(() => {
		if (!open) return;
		setError(undefined);
		setFilter("");
		loadModels()
			.then(setModels)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, [open]);

	const toggle = () => {
		if (open) {
			close();
			return;
		}
		setView(model ? "main" : "models");
		setOpen(true);
	};

	const visible = (models ?? []).filter((m) =>
		`${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	const groups = new Map<string, ModelInfo[]>();
	for (const m of visible) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);

	const manage = (
		<button
			type="button"
			className="dropdown-item manage-models"
			onClick={() => {
				close();
				store.openModels(node);
			}}
		>
			<span className="menu-label">
				<IconSettings size={14} />
				{models && !models.length ? "配置模型…" : "管理模型与服务商…"}
			</span>
		</button>
	);

	return (
		<div className="dropdown" ref={ref}>
			<button
				type="button"
				className={`chip composer-model-chip${open ? " open" : ""}`}
				disabled={disabled}
				onClick={toggle}
				title="切换模型与思考程度"
			>
				<span className="composer-model-name">
					{model ? model.name || model.id : loading ? "加载模型…" : "选择模型"}
				</span>
				{model && canThink ? <span className="composer-model-thinking">{thinkingLabel(level)}</span> : null}
				<IconChevronUp size={13} className="chip-caret" />
			</button>
			{open ? (
				<div className={`dropdown-menu up right model-menu${view === "models" ? " list" : ""}`}>
					{view === "main" && model ? (
						<>
							{canThink ? (
								<div className="thinking-panel">
									<div className="thinking-panel-head">
										<span className="thinking-panel-title">
											<IconBrain size={14} />
											思考程度
										</span>
										<span className="thinking-panel-value">{thinkingLabel(level)}</span>
									</div>
									<ThinkingSlider levels={levels} value={level} onChange={onThinking} />
									<div className="thinking-panel-scale">
										<span>更快</span>
										<span>更深入</span>
									</div>
								</div>
							) : (
								<div className="thinking-panel-none muted">这个模型不支持调节思考程度</div>
							)}
							<div className="dropdown-separator" />
							<button type="button" className="dropdown-item model-menu-current" onClick={() => setView("models")}>
								<span className="menu-label">
									<IconSparkles size={14} />
									<span className="model-menu-current-text">
										<span className="model-menu-current-name">{model.name || model.id}</span>
										<span className="muted">{model.provider}</span>
									</span>
								</span>
								<span className="model-menu-switch">
									切换模型
									<IconChevronRight size={14} />
								</span>
							</button>
						</>
					) : (
						<>
							<div className="model-menu-header">
								{model ? (
									<button type="button" className="ghost icon" title="返回" onClick={() => setView("main")}>
										<IconArrowLeft size={14} />
									</button>
								) : null}
								<span>选择模型</span>
							</div>
							<div className="dropdown-search">
								<IconSearch size={14} />
								<input
									// biome-ignore lint/a11y/noAutofocus: the list was just opened to search.
									autoFocus
									placeholder="搜索模型"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
								/>
							</div>
							<div className="model-menu-list">
								{error ? <div className="dropdown-empty error">{error}</div> : null}
								{!models && !error ? <div className="dropdown-empty">加载中…</div> : null}
								{models && !visible.length ? (
									<div className="dropdown-empty">{models.length ? "没有匹配的模型。" : "还没有可用的模型。"}</div>
								) : null}
								{[...groups].map(([provider, list]) => (
									<div key={provider} className="dropdown-group">
										<div className="dropdown-group-title">{provider}</div>
										{list.map((m) => {
											const selected = model?.provider === m.provider && model.id === m.id;
											return (
												<button
													type="button"
													key={m.id}
													className={`dropdown-item${selected ? " selected" : ""}`}
													onClick={() => {
														setView("main");
														if (!selected) onModel(m);
													}}
												>
													<span className="model-item-text">
														<span className="model-item-name">
															{m.name || m.id}
															{m.reasoning ? <span className="mini-tag">推理</span> : null}
														</span>
														<span className="muted">{m.id}</span>
													</span>
													{selected ? <IconCheck size={15} className="policy-check" /> : null}
												</button>
											);
										})}
									</div>
								))}
							</div>
							{manage}
						</>
					)}
				</div>
			) : null}
		</div>
	);
}

/** Model and thinking level of an open session, switched right away. */
export function SessionModelPicker({ chat, controller }: { chat: ChatState; controller: ChatController }) {
	const store = useStore();
	return (
		<ModelMenu
			node={store.nodeOf(controller.workspaceId)}
			model={chat.model}
			thinkingLevel={chat.thinkingLevel}
			loading={!chat.loaded}
			disabled={!!chat.closed}
			loadModels={() => controller.listModels().then((r) => r.models)}
			onModel={(m) => void controller.setModel(m.provider, m.id)}
			onThinking={(level) => void controller.setThinking(level)}
		/>
	);
}

/**
 * Model and thinking level for the chat the new-chat screen will create: starts from what the
 * workspace's computer would use, and is applied to the session before its first message.
 */
export function NewChatModelPicker({ workspace, disabled }: { workspace: WorkspaceInfo; disabled?: boolean }) {
	const store = useStore();
	const node = useAppState((s) => s.workspaceNodes[workspace.id] ?? s.node ?? LOCAL_NODE);
	const online = useAppState((s) => s.nodes[node]?.connection === "open");
	const choice = useAppState((s) => s.newChatModel[node]);
	// Reload the defaults when this computer's providers or default model change.
	const providers = useAppState((s) => s.providers);
	const [defaults, setDefaults] = useState<
		{ models: ModelInfo[]; model?: ModelInfo; thinkingLevel?: ThinkingLevel } | undefined
	>();

	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh when the provider list changes.
	useEffect(() => {
		if (!online) return;
		let live = true;
		store
			.listModels(workspace.id)
			.then((r) => {
				if (!live) return;
				setDefaults({
					models: r.models,
					...(r.current ? { model: r.current } : {}),
					...(r.thinkingLevel ? { thinkingLevel: r.thinkingLevel } : {}),
				});
			})
			.catch(() => {
				if (live) setDefaults({ models: [] });
			});
		return () => {
			live = false;
		};
	}, [store, workspace.id, online, providers]);

	// A picked model that is no longer available falls back to the default.
	const stale = !!choice?.model && !!defaults && !defaults.models.some((m) => sameModel(m, choice.model));
	useEffect(() => {
		if (stale) store.setNewChatModel(workspace.id, { model: undefined, thinkingLevel: undefined });
	}, [stale, store, workspace.id]);
	const picked =
		choice?.model && !stale ? (defaults?.models.find((m) => sameModel(m, choice.model)) ?? choice.model) : undefined;
	const model = picked ?? defaults?.model;
	const level =
		choice?.thinkingLevel ??
		(defaults?.model && sameModel(model, defaults.model) ? defaults.thinkingLevel : undefined) ??
		"medium";

	return (
		<ModelMenu
			node={node}
			{...(model ? { model } : {})}
			thinkingLevel={level}
			loading={!defaults}
			{...(disabled ? { disabled } : {})}
			loadModels={() =>
				store.listModels(workspace.id).then((r) => {
					setDefaults((d) => ({ ...d, models: r.models }));
					return r.models;
				})
			}
			onModel={(m) =>
				// Keep the level shown now (when the previous model could think), so what the chip
				// says is what the session gets; otherwise the new model starts from pi's default.
				store.setNewChatModel(workspace.id, {
					model: m,
					thinkingLevel:
						supportedThinkingLevels(model).length > 1
							? clampThinking(level, supportedThinkingLevels(model))
							: undefined,
				})
			}
			onThinking={(l) => store.setNewChatModel(workspace.id, { ...(model ? { model } : {}), thinkingLevel: l })}
		/>
	);
}

function sameModel(a: ModelInfo | undefined, b: ModelInfo | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}
