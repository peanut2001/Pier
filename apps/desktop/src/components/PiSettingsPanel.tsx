import type { ExtensionScope, PiSettingsFile, PiSettingsResult } from "@pier/protocol";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	BUILTIN_TOOLS,
	builtinDefault,
	type FieldDef,
	formatValue,
	getPath,
	isValidValue,
	type JsonScalar,
	parseListInput,
	parseNumberInput,
	parseSettingsText,
	SETTINGS_GROUPS,
	sameValue,
	unhandledKeys,
} from "../lib/pi-settings.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import {
	IconAlert,
	IconBraces,
	IconChevronDown,
	IconChevronRight,
	IconInfo,
	IconLoader,
	IconRefresh,
	IconSearch,
	IconSliders,
	IconUndo,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

type Mode = "form" | "json";

function errorText(error: unknown): string {
	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message))
		return "当前 Pier Host 版本不支持编辑 pi 设置，请更新 Pier";
	return message;
}

// ---- field editors -----------------------------------------------------------------------

/** A text input that keeps what the user types until it is committed (Enter / blur) or reverted (Esc). */
function DraftInput({
	value,
	placeholder,
	mono,
	numeric,
	disabled,
	onCommit,
}: {
	value: string;
	placeholder?: string;
	mono?: boolean;
	numeric?: boolean;
	disabled?: boolean;
	onCommit: (text: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const focused = useRef(false);
	useEffect(() => {
		if (!focused.current) setDraft(value);
	}, [value]);
	const commit = () => {
		if (draft !== value) onCommit(draft);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			(e.target as HTMLInputElement).blur();
		} else if (e.key === "Escape" && draft !== value) {
			// Keep Esc from leaving the settings screen while reverting.
			e.stopPropagation();
			setDraft(value);
		}
	};
	return (
		<input
			className={`pi-setting-input${mono ? " mono" : ""}${numeric ? " numeric" : ""}`}
			value={draft}
			placeholder={placeholder}
			disabled={disabled}
			inputMode={numeric ? "numeric" : undefined}
			spellCheck={false}
			autoCapitalize="off"
			autoCorrect="off"
			onFocus={() => {
				focused.current = true;
			}}
			onBlur={() => {
				focused.current = false;
				commit();
			}}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={onKeyDown}
		/>
	);
}

function DraftList({
	value,
	placeholder,
	disabled,
	onCommit,
}: {
	value: string[] | undefined;
	placeholder?: string;
	disabled?: boolean;
	onCommit: (items: string[] | undefined) => void;
}) {
	const text = (value ?? []).join("\n");
	const [draft, setDraft] = useState(text);
	const focused = useRef(false);
	useEffect(() => {
		if (!focused.current) setDraft(text);
	}, [text]);
	return (
		<textarea
			className="pi-setting-list mono"
			rows={Math.min(8, Math.max(2, draft.split("\n").length))}
			value={draft}
			placeholder={placeholder}
			disabled={disabled}
			spellCheck={false}
			onFocus={() => {
				focused.current = true;
			}}
			onBlur={() => {
				focused.current = false;
				const items = parseListInput(draft);
				if (!sameValue(items, value)) onCommit(items);
				else setDraft(text);
			}}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					setDraft(text);
				}
			}}
		/>
	);
}

interface FieldProps {
	field: FieldDef;
	/** Value stored in the edited file. */
	own: unknown;
	/** What applies when the file does not set it (inherited user value or built-in default). */
	fallback: unknown;
	/** The fallback comes from the user settings (editing a project file). */
	inherited: boolean;
	disabled: boolean;
	saving: boolean;
	onChange: (field: FieldDef, value: unknown) => void;
}

function FieldControl({ field, own, fallback, inherited, disabled, onChange }: FieldProps) {
	const store = useStore();
	const kind = field.kind;
	const valid = own !== undefined && isValidValue(kind, own);
	const shown = valid ? own : fallback;
	switch (kind.type) {
		case "boolean":
			return (
				<Switch
					checked={shown === true}
					disabled={disabled}
					label={field.label}
					onChange={(checked) => onChange(field, checked)}
				/>
			);
		case "enum": {
			const encode = (value: JsonScalar) => JSON.stringify(value);
			return (
				<select
					className="setting-select compact"
					value={valid ? encode(own as JsonScalar) : ""}
					disabled={disabled}
					onChange={(e) =>
						onChange(field, e.target.value === "" ? undefined : (JSON.parse(e.target.value) as JsonScalar))
					}
				>
					<option value="">
						{inherited ? "继承全局" : "默认"}（{formatValue(field, fallback)}）
					</option>
					{kind.options.map((option) => (
						<option key={encode(option.value)} value={encode(option.value)}>
							{option.label}
						</option>
					))}
				</select>
			);
		}
		case "number":
			return (
				<>
					<DraftInput
						value={valid ? String(own) : ""}
						placeholder={fallback === undefined ? field.defaultLabel : String(fallback)}
						numeric
						disabled={disabled}
						onCommit={(text) => {
							const parsed = parseNumberInput(field, text);
							if (parsed.error) {
								store.toast("error", parsed.error);
								return;
							}
							onChange(field, parsed.value);
						}}
					/>
					{kind.unit ? <span className="muted small pi-setting-unit">{kind.unit}</span> : null}
				</>
			);
		case "string":
			return (
				<DraftInput
					value={valid ? String(own) : ""}
					placeholder={typeof fallback === "string" && fallback ? fallback : kind.placeholder}
					{...(kind.mono ? { mono: true } : {})}
					disabled={disabled}
					onCommit={(text) => onChange(field, text.trim() ? text : undefined)}
				/>
			);
		case "list":
			return (
				<DraftList
					value={valid ? (own as string[]) : undefined}
					placeholder={Array.isArray(fallback) && fallback.length ? fallback.join("\n") : kind.placeholder}
					disabled={disabled}
					onCommit={(items) => onChange(field, items)}
				/>
			);
		case "tools": {
			const selected = new Set((shown as string[] | undefined) ?? []);
			const extra = [...selected].filter((tool) => !(BUILTIN_TOOLS as readonly string[]).includes(tool));
			return (
				<div className="pi-tool-chips">
					{[...BUILTIN_TOOLS, ...extra].map((tool) => (
						<button
							type="button"
							key={tool}
							className={`pi-tool-chip mono${selected.has(tool) ? " on" : ""}`}
							aria-pressed={selected.has(tool)}
							disabled={disabled}
							onClick={() => {
								const next = new Set(selected);
								if (next.has(tool)) next.delete(tool);
								else next.add(tool);
								const order = [...BUILTIN_TOOLS, ...extra];
								onChange(
									field,
									order.filter((t) => next.has(t)),
								);
							}}
						>
							{tool}
						</button>
					))}
				</div>
			);
		}
	}
}

function FieldRow(props: FieldProps & { disabledReason?: string | undefined }) {
	const { field, own, fallback, inherited, disabled, saving, onChange, disabledReason } = props;
	const set = own !== undefined;
	const valid = set && isValidValue(field.kind, own);
	const stacked = field.kind.type === "list" || field.kind.type === "tools";
	const key = field.path.join(".");
	const fallbackText = `${inherited ? "继承全局" : "默认"}：${formatValue(field, fallback)}`;
	return (
		<SettingRow
			stack={stacked}
			title={
				<span className="pi-setting-title">
					{field.label}
					{set ? (
						<span className={`mini-tag${valid ? " accent" : " warn"}`} title={valid ? undefined : JSON.stringify(own)}>
							{valid ? "已设置" : "值无效"}
						</span>
					) : null}
					{field.globalOnly ? <span className="mini-tag">仅全局</span> : null}
					{saving ? <IconLoader size={12} className="spin" /> : null}
				</span>
			}
			description={
				<>
					{field.description ? <span>{field.description} </span> : null}
					<span className="pi-setting-meta">
						<code>{key}</code> · {disabledReason ?? fallbackText}
					</span>
				</>
			}
		>
			<FieldControl {...props} disabled={disabled || saving} />
			{set ? (
				<button
					type="button"
					className="ghost icon"
					title={inherited ? "移除这一项（改用全局设置）" : "恢复默认（从 settings.json 中移除这一项）"}
					disabled={disabled || saving}
					onClick={() => onChange(field, undefined)}
				>
					<IconUndo size={14} />
				</button>
			) : stacked ? null : (
				<span className="pi-setting-reset-placeholder" />
			)}
		</SettingRow>
	);
}

// ---- JSON editor -------------------------------------------------------------------------

function JsonEditor({
	file,
	scope,
	workspaceId,
	onSaved,
	onReload,
}: {
	file: PiSettingsFile;
	scope: ExtensionScope;
	workspaceId: string | undefined;
	onSaved: (file: PiSettingsFile) => void;
	onReload: () => Promise<void>;
}) {
	const store = useStore();
	const [draft, setDraft] = useState(file.text);
	const [base, setBase] = useState(file.text);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState(false);
	const dirty = draft !== base;
	const external = file.text !== base;

	// Follow the file while there are no unsaved edits.
	useEffect(() => {
		if (!dirty) {
			setDraft(file.text);
			setBase(file.text);
		}
	}, [file.text, dirty]);

	const parsed = useMemo(() => (draft.trim() ? parseSettingsText(draft) : { settings: {} }), [draft]);

	const save = async (force = false) => {
		if (saving || parsed.error) return;
		setSaving(true);
		try {
			const text = draft.trim() ? draft : "{}\n";
			const expected = force ? undefined : file.exists ? file.modifiedAt : undefined;
			const result = await store.writePiSettings(scope, workspaceId, text, expected);
			setConflict(false);
			setBase(result.file.text);
			setDraft(result.file.text);
			onSaved(result.file);
			store.toast("info", result.changed ? "已保存 settings.json" : "内容没有变化");
		} catch (error) {
			if ((error as { code?: string }).code === "CONFLICT") setConflict(true);
			else store.toast("error", `保存失败：${errorText(error)}`);
		} finally {
			setSaving(false);
		}
	};

	const format = () => {
		if (!parsed.settings) return;
		setDraft(`${JSON.stringify(parsed.settings, null, 2)}\n`);
	};

	/** Drop the edits; the effect above then follows the freshly read file. */
	const discard = () => {
		setConflict(false);
		setDraft(base);
		void onReload();
	};

	return (
		<SettingsCard className="pi-json-card">
			<div className="pi-json-head">
				<span className="muted small">
					{file.exists ? "直接编辑文件内容，保存前会检查 JSON 格式。" : "文件尚不存在，保存时创建。"}
				</span>
				<span className="pi-json-actions">
					<button type="button" className="ghost" disabled={!parsed.settings || saving} onClick={format}>
						格式化
					</button>
					<button
						type="button"
						className="ghost"
						disabled={!dirty || saving}
						onClick={() => {
							setDraft(base);
							setConflict(false);
						}}
					>
						撤销修改
					</button>
					<button
						type="button"
						className="primary"
						disabled={!dirty || saving || Boolean(parsed.error)}
						onClick={() => void save()}
					>
						{saving ? <IconLoader size={13} className="spin" /> : null}
						保存
					</button>
				</span>
			</div>
			{conflict ? (
				<div className="banner warning inline">
					<IconAlert size={15} />
					<span>文件在读取后被修改过（可能是终端中的 pi 或其他设备）。</span>
					<span className="banner-actions">
						<button type="button" onClick={discard}>
							放弃修改并重新读取
						</button>
						<button type="button" className="danger" onClick={() => void save(true)}>
							仍然覆盖
						</button>
					</span>
				</div>
			) : dirty && external ? (
				<div className="banner info inline">
					<IconInfo size={15} />
					<span>文件已在别处更新；保存时会提示冲突。</span>
				</div>
			) : null}
			<textarea
				className="pi-json-editor mono"
				value={draft}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				placeholder="{}"
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
						e.preventDefault();
						void save();
					} else if (e.key === "Escape") {
						e.stopPropagation();
					} else if (e.key === "Tab" && !e.shiftKey) {
						e.preventDefault();
						const target = e.currentTarget;
						const { selectionStart, selectionEnd } = target;
						setDraft(`${draft.slice(0, selectionStart)}  ${draft.slice(selectionEnd)}`);
						requestAnimationFrame(() => target.setSelectionRange(selectionStart + 2, selectionStart + 2));
					}
				}}
			/>
			<div className={`pi-json-status small${parsed.error ? " error-text" : " muted"}`}>
				{parsed.error ? `JSON 无效：${parsed.error}` : dirty ? "有未保存的修改（Ctrl/⌘ + S 保存）" : "与文件一致"}
			</div>
		</SettingsCard>
	);
}

// ---- page --------------------------------------------------------------------------------

export function PiSettings() {
	const store = useStore();
	const workspaces = useAppState((s) => s.localWorkspaces);
	const version = useAppState((s) => s.piSettingsVersion);
	const [workspaceId, setWorkspaceId] = useState("");
	const [mode, setMode] = useState<Mode>("form");
	const [data, setData] = useState<PiSettingsResult>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState<string>();
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const workspace = workspaces.find((w) => w.id === workspaceId);
	const scope: ExtensionScope = workspace ? "project" : "user";

	useEffect(() => {
		if (workspaceId && !workspaces.some((w) => w.id === workspaceId)) setWorkspaceId("");
	}, [workspaceId, workspaces]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setData(await store.getPiSettings(workspace?.id));
			setError(undefined);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setLoading(false);
		}
	}, [store, workspace?.id]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the host reports a change
	useEffect(() => {
		void load();
	}, [load, version]);

	const file = scope === "project" ? data?.project : data?.user;
	const own = file?.settings;
	const userSettings = data?.user.settings;
	const broken = file !== undefined && file.settings === undefined;

	// A file that cannot be parsed can only be fixed as text.
	useEffect(() => {
		if (broken) setMode("json");
	}, [broken]);

	const onChange = async (field: FieldDef, value: unknown) => {
		const key = field.path.join(".");
		if (saving || !file) return;
		if (sameValue(getPath(own, field.path), value)) return;
		setSaving(key);
		try {
			const result = await store.updatePiSettings(
				scope,
				workspace?.id,
				[value === undefined ? { path: field.path } : { path: field.path, value }],
				!field.terminal,
			);
			if (result) {
				setData((current) =>
					current
						? scope === "project" && current.project
							? { ...current, project: { ...result.file, workspaceId: current.project.workspaceId } }
							: { ...current, user: result.file }
						: current,
				);
			}
		} finally {
			setSaving(undefined);
		}
	};

	const onSaved = (saved: PiSettingsFile) =>
		setData((current) =>
			current
				? scope === "project" && current.project
					? { ...current, project: { ...saved, workspaceId: current.project.workspaceId } }
					: { ...current, user: saved }
				: current,
		);

	const q = query.trim().toLowerCase();
	const groups = useMemo(
		() =>
			SETTINGS_GROUPS.map((group) => ({
				...group,
				fields: group.fields.filter(
					(field) =>
						!q || `${field.label} ${field.description ?? ""} ${field.path.join(".")}`.toLowerCase().includes(q),
				),
			})).filter((group) => group.fields.length),
		[q],
	);
	const extraKeys = unhandledKeys(own);

	return (
		<>
			<p className="settings-intro">
				可视化编辑 pi 的 <code>settings.json</code>，与终端中的 pi 共用同一份配置。全局设置对所有工作区生效，工作区的{" "}
				<code>.pi/settings.json</code>{" "}
				覆盖全局中的同名项。修改会立即写入文件，空闲的会话随后重新加载；默认工具、传输方式等少数设置只对新会话生效。
			</p>

			<SettingsGroup>
				<SettingsCard>
					<SettingRow
						title="编辑的文件"
						description={
							file ? (
								<span className="mono" title={file.path}>
									{file.path}
									{file.exists ? "" : "（尚不存在，修改时创建）"}
								</span>
							) : (
								"选择全局设置或某个工作区的项目设置。"
							)
						}
					>
						<select
							className="setting-select compact"
							value={workspaceId}
							disabled={saving !== undefined}
							onChange={(e) => setWorkspaceId(e.target.value)}
						>
							<option value="">全局设置</option>
							{workspaces.map((w) => (
								<option key={w.id} value={w.id}>
									工作区「{w.name}」
								</option>
							))}
						</select>
						{file ? <CopyButton text={file.path} label="复制路径" iconOnly /> : null}
						<button
							type="button"
							className="ghost icon"
							title="重新读取"
							disabled={loading}
							onClick={() => void load()}
						>
							{loading ? <IconLoader size={14} className="spin" /> : <IconRefresh size={14} />}
						</button>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>

			{error ? (
				<div className="banner error inline models-error">
					<IconAlert size={15} />
					<span>读取设置失败：{error}</span>
				</div>
			) : null}

			{file ? (
				<>
					<div className="pi-settings-toolbar">
						<div className="segmented" role="tablist" aria-label="编辑方式">
							<button
								type="button"
								role="tab"
								aria-selected={mode === "form"}
								className={mode === "form" ? "active" : ""}
								disabled={broken}
								onClick={() => setMode("form")}
							>
								<IconSliders size={13} />
								表单
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={mode === "json"}
								className={mode === "json" ? "active" : ""}
								onClick={() => setMode("json")}
							>
								<IconBraces size={13} />
								JSON
							</button>
						</div>
						{mode === "form" ? (
							<div className="provider-search pi-settings-search">
								<IconSearch size={14} />
								<input placeholder="搜索设置" value={query} onChange={(e) => setQuery(e.target.value)} />
								{query ? (
									<button type="button" className="ghost icon" title="清除" onClick={() => setQuery("")}>
										<IconX size={13} />
									</button>
								) : null}
							</div>
						) : null}
					</div>

					{broken ? (
						<div className="banner error inline models-error">
							<IconAlert size={15} />
							<span>这个文件不是有效的 JSON 对象（{file.error}），pi 会忽略其中的设置。请在下方修复后保存。</span>
						</div>
					) : null}

					{mode === "json" ? (
						<JsonEditor
							key={file.path}
							file={file}
							scope={scope}
							workspaceId={workspace?.id}
							onSaved={onSaved}
							onReload={load}
						/>
					) : (
						<>
							{groups.map((group) => {
								const collapsed = group.collapsed && !q && !open[group.id];
								return (
									<SettingsGroup
										key={group.id}
										title={
											group.collapsed && !q ? (
												<button
													type="button"
													className="ghost pi-group-toggle"
													onClick={() => setOpen((s) => ({ ...s, [group.id]: !s[group.id] }))}
												>
													{collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
													{group.title}
												</button>
											) : (
												group.title
											)
										}
									>
										{group.description ? <p className="muted small settings-note">{group.description}</p> : null}
										{collapsed ? null : (
											<SettingsCard className="pi-settings-card">
												{group.fields.map((field) => {
													const projectOnlyBlocked = scope === "project" && field.globalOnly;
													const inherited = scope === "project" ? getPath(userSettings, field.path) : undefined;
													const useInherited = inherited !== undefined && isValidValue(field.kind, inherited);
													return (
														<FieldRow
															key={field.path.join(".")}
															field={field}
															own={getPath(own, field.path)}
															fallback={useInherited ? inherited : builtinDefault(field)}
															inherited={useInherited}
															disabled={
																Boolean(projectOnlyBlocked) || (saving !== undefined && saving !== field.path.join("."))
															}
															disabledReason={projectOnlyBlocked ? "只能在全局设置中配置" : undefined}
															saving={saving === field.path.join(".")}
															onChange={(f, v) => void onChange(f, v)}
														/>
													);
												})}
											</SettingsCard>
										)}
									</SettingsGroup>
								);
							})}
							{!groups.length ? (
								<SettingsCard>
									<div className="settings-empty">没有匹配的设置，可以在 JSON 中直接编辑。</div>
								</SettingsCard>
							) : null}
							{!q ? (
								<SettingsGroup title="其他">
									<SettingsCard>
										<SettingRow
											title="扩展、技能、提示词与主题"
											description="settings.json 中的 packages、extensions、skills、prompts、themes 在「扩展」页面管理。"
										>
											<button type="button" onClick={() => store.openSettings("extensions")}>
												打开扩展
											</button>
										</SettingRow>
										<SettingRow
											title="默认模型"
											description={
												scope === "user"
													? `defaultProvider / defaultModel：${
															typeof own?.defaultProvider === "string" && typeof own?.defaultModel === "string"
																? `${own.defaultProvider}/${own.defaultModel}`
																: "未设置"
														}`
													: "在「模型与服务商」中设置全局默认模型；工作区的默认模型可以在 JSON 中编辑。"
											}
										>
											<button type="button" onClick={() => store.openSettings("models")}>
												模型与服务商
											</button>
										</SettingRow>
										<SettingRow
											title="其他设置"
											description={
												extraKeys.length
													? `表单中未列出的设置：${extraKeys.join("、")}。可以在 JSON 中编辑（例如 modelThinkingLevels、compaction.modelOverrides）。`
													: "按模型的思考等级（modelThinkingLevels）、按模型的压缩参数（compaction.modelOverrides）等可以在 JSON 中编辑。"
											}
										>
											<button type="button" onClick={() => setMode("json")}>
												<IconBraces size={14} />
												编辑 JSON
											</button>
										</SettingRow>
									</SettingsCard>
								</SettingsGroup>
							) : null}
						</>
					)}
				</>
			) : !error ? (
				<p className="muted">正在读取设置…</p>
			) : null}
		</>
	);
}
