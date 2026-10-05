import type {
	ExtensionListResult,
	ExtensionPackageInfo,
	ExtensionResourceInfo,
	ExtensionResourceType,
	ExtensionScope,
	ExtensionUpdateInfo,
} from "@pier/protocol";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { hostSpeaksMinor } from "../lib/settings-target.ts";
import { useAppState, useSettingsWorkspaces, useStore } from "../lib/store.tsx";
import { ExtensionCatalog } from "./ExtensionCatalog.tsx";
import {
	IconAlert,
	IconChevronDown,
	IconChevronRight,
	IconDownload,
	IconLoader,
	IconPuzzle,
	IconRefresh,
	IconSearch,
	IconTrash,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Select } from "./Select.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

const TYPE_LABEL: Record<ExtensionResourceType, string> = {
	extensions: "扩展",
	skills: "技能",
	prompts: "提示词",
	themes: "主题",
};

const SCOPE_LABEL: Record<ExtensionScope, string> = { user: "全局", project: "项目" };

const KIND_LABEL: Record<ExtensionPackageInfo["kind"], string> = { npm: "npm", git: "git", local: "本地" };

/** Top-level skills / prompts / themes shown before "show all". */
const COLLAPSED_OTHERS = 8;

function errorText(error: unknown): string {
	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持扩展管理，请更新 Pier";
	return message;
}

function packageKey(pkg: { scope: ExtensionScope; source: string }): string {
	return `${pkg.scope}\n${pkg.source}`;
}

/** Summary such as "2 个扩展 · 1 个技能". */
function countText(resources: ExtensionResourceInfo[]): string {
	const counts = new Map<ExtensionResourceType, number>();
	for (const r of resources) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
	const parts = (Object.keys(TYPE_LABEL) as ExtensionResourceType[])
		.filter((type) => counts.get(type))
		.map((type) => `${counts.get(type)} 个${TYPE_LABEL[type]}`);
	return parts.join(" · ") || "没有可加载的资源";
}

/** A button that asks for a second click before running a destructive action. */
function ConfirmButton({
	label,
	confirmLabel,
	title,
	disabled,
	onConfirm,
}: {
	label: string;
	confirmLabel: string;
	title?: string;
	disabled?: boolean;
	onConfirm: () => void;
}) {
	const [armed, setArmed] = useState(false);
	return (
		<button
			type="button"
			className={armed ? "danger" : "ghost"}
			title={title}
			disabled={disabled}
			onBlur={() => setArmed(false)}
			onClick={() => {
				if (!armed) {
					setArmed(true);
					return;
				}
				setArmed(false);
				onConfirm();
			}}
		>
			<IconTrash size={13} />
			{armed ? confirmLabel : label}
		</button>
	);
}

function ResourceRow({
	resource,
	busy,
	onToggle,
	onDelete,
	nested,
}: {
	resource: ExtensionResourceInfo;
	busy: boolean;
	onToggle: (resource: ExtensionResourceInfo, enabled: boolean) => void;
	onDelete?: (resource: ExtensionResourceInfo) => void;
	nested?: boolean;
}) {
	return (
		<div className={`provider-row extension-row${nested ? " nested" : ""}${resource.enabled ? "" : " disabled"}`}>
			<div className="provider-main">
				<div className="provider-name">
					<span className="extension-name">{resource.name}</span>
					{nested || resource.type === "extensions" ? null : (
						<span className="mini-tag">{TYPE_LABEL[resource.type]}</span>
					)}
					{nested ? null : <span className="mini-tag">{SCOPE_LABEL[resource.scope]}</span>}
					{nested && resource.type !== "extensions" ? (
						<span className="mini-tag">{TYPE_LABEL[resource.type]}</span>
					) : null}
					{resource.enabled ? null : <span className="mini-tag warn">已停用</span>}
				</div>
				<div className="muted small mono" title={resource.path}>
					{resource.path}
				</div>
			</div>
			<div className="row-actions">
				{onDelete && resource.deletable ? (
					<ConfirmButton
						label="删除"
						confirmLabel={resource.source === "auto" ? "确认删除" : "确认移除"}
						title={
							resource.source === "auto"
								? "从扩展目录移到 Pier 回收站（~/.pier/trash/extensions）"
								: "从 settings.json 的 extensions 中移除这一项（文件保留）"
						}
						disabled={busy}
						onConfirm={() => onDelete(resource)}
					/>
				) : null}
				<Switch
					checked={resource.enabled}
					disabled={busy}
					label={resource.enabled ? `停用 ${resource.name}` : `启用 ${resource.name}`}
					onChange={(enabled) => onToggle(resource, enabled)}
				/>
			</div>
		</div>
	);
}

function PackageRow({
	pkg,
	resources,
	update,
	busy,
	onToggle,
	onUpdate,
	onReinstall,
	onRemove,
}: {
	pkg: ExtensionPackageInfo;
	resources: ExtensionResourceInfo[];
	update: boolean;
	busy: boolean;
	onToggle: (resource: ExtensionResourceInfo, enabled: boolean) => void;
	onUpdate: (pkg: ExtensionPackageInfo) => void;
	onReinstall: (pkg: ExtensionPackageInfo) => void;
	onRemove: (pkg: ExtensionPackageInfo) => void;
}) {
	const [open, setOpen] = useState(false);
	const missing = !pkg.installedPath;
	const disabled = resources.filter((r) => !r.enabled).length;
	return (
		<div className="extension-package">
			<div className="provider-row">
				<button
					type="button"
					className="ghost icon extension-toggle"
					title={open ? "收起" : "展开资源"}
					disabled={!resources.length}
					onClick={() => setOpen(!open)}
				>
					{open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
				</button>
				<div className="provider-main">
					<div className="provider-name">
						<span className="extension-name">{pkg.name ?? pkg.source}</span>
						{pkg.version ? <span className="mini-tag">v{pkg.version}</span> : null}
						<span className="mini-tag">{SCOPE_LABEL[pkg.scope]}</span>
						<span className="mini-tag">{KIND_LABEL[pkg.kind]}</span>
						{pkg.filtered ? (
							<span className="mini-tag" title="settings.json 中为这个包设置了资源筛选">
								已筛选
							</span>
						) : null}
						{missing ? <span className="mini-tag warn">{pkg.kind === "local" ? "路径不存在" : "未安装"}</span> : null}
						{update ? <span className="mini-tag ok">有更新</span> : null}
					</div>
					{pkg.description ? <div className="muted small">{pkg.description}</div> : null}
					<div className="muted small mono" title={pkg.installedPath ?? pkg.source}>
						{pkg.source}
						{pkg.installedPath && pkg.installedPath !== pkg.source ? ` → ${pkg.installedPath}` : ""}
					</div>
					<div className="muted small">
						{countText(resources)}
						{disabled ? ` · ${disabled} 个已停用` : ""}
					</div>
				</div>
				<div className="row-actions">
					{missing && pkg.kind !== "local" ? (
						<button type="button" className="ghost" disabled={busy} onClick={() => onReinstall(pkg)}>
							<IconDownload size={13} />
							安装
						</button>
					) : null}
					{!missing && pkg.kind !== "local" ? (
						<button
							type="button"
							className="ghost"
							disabled={busy}
							title="按 settings.json 中的版本或分支更新；固定版本（@1.2.3、标签或提交）不会移动"
							onClick={() => onUpdate(pkg)}
						>
							<IconRefresh size={13} />
							更新
						</button>
					) : null}
					<ConfirmButton
						label="移除"
						confirmLabel="确认移除"
						title={
							pkg.kind === "local"
								? "从 settings.json 中移除（本地文件保留）"
								: "从 settings.json 中移除并卸载 pi 安装的副本"
						}
						disabled={busy}
						onConfirm={() => onRemove(pkg)}
					/>
				</div>
			</div>
			{open && resources.length ? (
				<div className="extension-children">
					{resources.map((resource) => (
						<ResourceRow
							key={`${resource.type}:${resource.path}`}
							resource={resource}
							busy={busy}
							onToggle={onToggle}
							nested
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

function InstallForm({
	workspaceName,
	busy,
	installing,
	onInstall,
	scope,
	onScopeChange: setScope,
}: {
	workspaceName?: string;
	busy: boolean;
	installing: boolean;
	onInstall: (source: string, scope: ExtensionScope) => Promise<boolean>;
	scope: ExtensionScope;
	onScopeChange: (scope: ExtensionScope) => void;
}) {
	const progress = useAppState((s) => s.extensionProgress);
	const [source, setSource] = useState("");
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const value = source.trim();
		if (!value || busy) return;
		if (await onInstall(value, scope)) setSource("");
	};
	return (
		<SettingsCard>
			<form className="setting-row stack" onSubmit={submit}>
				<div className="setting-text">
					<div className="setting-title">安装扩展包</div>
					<div className="setting-desc">
						支持 <code>npm:@scope/name@1.0.0</code>、<code>git:github.com/user/repo@v1</code>、Git
						仓库地址，或本地扩展文件 / 扩展包目录的绝对路径。npm 与 git 来源需要这台电脑装有 npm / git。
					</div>
				</div>
				<div className="extension-install-row">
					<input
						className="mono"
						placeholder="npm:pi-web-access"
						value={source}
						disabled={busy}
						onChange={(e) => setSource(e.target.value)}
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
					/>
					<Select
						className="setting-select compact"
						value={scope}
						disabled={busy}
						onChange={setScope}
						title="全局：写入 pi 配置目录的 settings.json，对所有工作区生效；项目：写入工作区的 .pi/settings.json"
						options={[
							{ value: "user", label: "全局（所有工作区）" },
							{
								value: "project",
								label: workspaceName ? `仅工作区「${workspaceName}」` : "仅工作区（先在上方选择）",
								disabled: !workspaceName,
							},
						]}
					/>
					<button type="submit" className="primary" disabled={busy || !source.trim()}>
						{installing ? <IconLoader size={14} className="spin" /> : <IconDownload size={14} />}
						{installing ? "安装中…" : "安装"}
					</button>
				</div>
				{installing && progress?.message ? <div className="muted small mono">{progress.message}</div> : null}
			</form>
		</SettingsCard>
	);
}

export function ExtensionsSettings() {
	const store = useStore();
	const workspaces = useSettingsWorkspaces();
	const selectedWorkspaceId = useAppState((s) => s.selectedWorkspaceId);
	const version = useAppState((s) => s.extensionsVersion);
	const progress = useAppState((s) => s.extensionProgress);
	const [workspaceId, setWorkspaceId] = useState<string>(() =>
		selectedWorkspaceId && workspaces.some((w) => w.id === selectedWorkspaceId) ? selectedWorkspaceId : "",
	);
	const [data, setData] = useState<ExtensionListResult>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [updates, setUpdates] = useState<ExtensionUpdateInfo[]>();
	const [query, setQuery] = useState("");
	const [showAllOthers, setShowAllOthers] = useState(false);
	const [tab, setTab] = useState<"installed" | "catalog">("installed");
	const [scope, setScope] = useState<ExtensionScope>("user");
	const [installingSource, setInstallingSource] = useState<string>();
	const hostInfo = useAppState((s) => s.nodes[s.settingsNode]?.hostInfo);
	const workspace = workspaces.find((w) => w.id === workspaceId);
	const target = workspace?.id;

	useEffect(() => {
		if (!workspace) setScope("user");
	}, [workspace]);

	useEffect(() => {
		if (workspaceId && !workspaces.some((w) => w.id === workspaceId)) setWorkspaceId("");
	}, [workspaceId, workspaces]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const result = await store.listExtensions(target);
			setData(result);
			setError(undefined);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setLoading(false);
		}
	}, [store, target]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the host reports a change
	useEffect(() => {
		void load();
	}, [load, version]);

	const run = async (key: string, fn: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(key);
		try {
			await fn();
		} finally {
			setBusy(undefined);
			await load();
		}
	};

	const onToggle = (resource: ExtensionResourceInfo, enabled: boolean) =>
		void run("toggle", () => store.setExtensionEnabled(resource, enabled, target));
	const onDelete = (resource: ExtensionResourceInfo) =>
		void run("delete", () => store.deleteExtension(resource, target));
	const onRemove = (pkg: ExtensionPackageInfo) =>
		void run("remove", async () => {
			if (await store.removeExtensionPackage(pkg, target)) {
				setUpdates((current) => current?.filter((u) => packageKey(u) !== packageKey(pkg)));
			}
		});
	const onUpdate = (pkg?: ExtensionPackageInfo) =>
		void run("update", async () => {
			if (await store.updateExtensions(pkg?.source, target)) {
				setUpdates((current) => (pkg ? current?.filter((u) => packageKey(u) !== packageKey(pkg)) : []));
			}
		});
	const onReinstall = (pkg: ExtensionPackageInfo) =>
		void run("install", () => store.installExtension(pkg.source, pkg.scope, target));
	const onInstall = async (source: string, scope: ExtensionScope): Promise<boolean> => {
		if (busy) return false;
		let ok = false;
		setInstallingSource(source);
		try {
			await run("install", async () => {
				ok = (await store.installExtension(source, scope, scope === "project" ? target : undefined)) !== false;
			});
		} finally {
			setInstallingSource(undefined);
		}
		return ok;
	};
	const onCheckUpdates = () =>
		void run("check", async () => {
			const found = await store.checkExtensionUpdates(target);
			if (found) {
				setUpdates(found);
				store.toast("info", found.length ? `${found.length} 个扩展包有可用更新` : "所有扩展包都是最新版本");
			}
		});

	const q = query.trim().toLowerCase();
	const matches = useCallback(
		(...texts: Array<string | undefined>) => !q || texts.some((t) => t?.toLowerCase().includes(q)),
		[q],
	);

	const view = useMemo(() => {
		const resources = data?.resources ?? [];
		const packages = (data?.packages ?? []).map((pkg) => ({
			pkg,
			resources: resources.filter((r) => r.origin === "package" && r.scope === pkg.scope && r.source === pkg.source),
		}));
		const topLevel = resources.filter((r) => r.origin === "top-level");
		return {
			packages: packages.filter(
				({ pkg, resources }) =>
					matches(pkg.name, pkg.source, pkg.description) || resources.some((r) => matches(r.name, r.path)),
			),
			packageCount: packages.length,
			updatable: packages.some(({ pkg }) => pkg.kind !== "local" && pkg.installedPath),
			extensions: topLevel.filter((r) => r.type === "extensions" && matches(r.name, r.path)),
			extensionCount: topLevel.filter((r) => r.type === "extensions").length,
			others: topLevel.filter((r) => r.type !== "extensions" && matches(r.name, r.path, TYPE_LABEL[r.type])),
			otherCount: topLevel.filter((r) => r.type !== "extensions").length,
		};
	}, [data, matches]);

	const updateKeys = new Set((updates ?? []).map(packageKey));
	const isBusy = busy !== undefined;
	const others = showAllOthers || q ? view.others : view.others.slice(0, COLLAPSED_OTHERS);

	return (
		<>
			<p className="settings-intro">
				管理 pi 的扩展包（npm、git 或本地目录，可包含扩展、技能、提示词与主题）和独立扩展，与终端里的{" "}
				<code>pi install</code> / <code>pi remove</code> / <code>pi config</code> 使用同一份配置
				{data ? (
					<>
						（<code>{data.agentDir}/settings.json</code>）
					</>
				) : null}
				。修改后，空闲的会话会立即重新加载；正在运行的会话需要在完成后执行 <code>/reload</code>。
			</p>
			<div className="banner warning inline extension-warning">
				<IconAlert size={15} />
				<span>扩展在 Pier Host 进程中以你的系统权限运行，可以读写文件、执行命令并访问凭据。只安装你信任的来源。</span>
			</div>

			<SettingsGroup>
				<SettingsCard>
					<SettingRow
						title="查看范围"
						description="选择工作区后，同时列出并管理该工作区 .pi/settings.json 中的项目级扩展。"
					>
						<Select
							className="setting-select compact"
							value={workspaceId}
							disabled={isBusy}
							onChange={setWorkspaceId}
							options={[
								{ value: "", label: "仅全局" },
								...workspaces.map((w) => ({ value: w.id, label: `全局 + 工作区「${w.name}」` })),
							]}
						/>
						<button type="button" className="ghost" disabled={loading} onClick={() => void load()}>
							{loading ? <IconLoader size={13} className="spin" /> : <IconRefresh size={13} />}
							刷新
						</button>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>

			<div className="segmented extension-tabs" role="tablist" aria-label="扩展页面">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "installed"}
					className={tab === "installed" ? "active" : ""}
					onClick={() => setTab("installed")}
				>
					<IconPuzzle size={13} />
					已安装{data ? `（${data.packages.length + view.extensionCount}）` : ""}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "catalog"}
					className={tab === "catalog" ? "active" : ""}
					onClick={() => setTab("catalog")}
				>
					<IconSearch size={13} />
					扩展市场
				</button>
			</div>

			{tab === "catalog" ? (
				<SettingsGroup>
					<ExtensionCatalog
						installed={data?.packages ?? []}
						scope={scope}
						onScopeChange={setScope}
						{...(workspace ? { workspaceName: workspace.name } : {})}
						busy={isBusy}
						{...(installingSource ? { installingSource } : {})}
						onInstall={onInstall}
						{...(hostInfo && !hostSpeaksMinor(hostInfo, 20)
							? {
									unsupported: `这台电脑上的 Pier v${hostInfo.version}（协议 ${hostInfo.protocolVersion}）不支持搜索 pi 官方扩展仓库（需要协议 1.20 或更高）。请先在「关于与更新」中更新那台电脑，或在「已安装」中按来源安装。`,
								}
							: {})}
					/>
				</SettingsGroup>
			) : (
				<>
					<SettingsGroup>
						<InstallForm
							{...(workspace ? { workspaceName: workspace.name } : {})}
							busy={isBusy}
							installing={busy === "install"}
							onInstall={onInstall}
							scope={scope}
							onScopeChange={setScope}
						/>
						{busy && busy !== "install" && progress?.message ? (
							<p className="muted small mono settings-note">{progress.message}</p>
						) : null}
					</SettingsGroup>

					{error ? (
						<div className="banner error inline models-error">
							<IconAlert size={15} />
							<span>读取扩展失败：{error}</span>
						</div>
					) : null}

					{data ? (
						<>
							<div className="provider-search extension-search">
								<IconSearch size={14} />
								<input placeholder="搜索扩展、技能、提示词" value={query} onChange={(e) => setQuery(e.target.value)} />
								{query ? (
									<button type="button" className="ghost icon" title="清除" onClick={() => setQuery("")}>
										<IconX size={13} />
									</button>
								) : null}
							</div>

							<SettingsGroup
								title={`扩展包（${view.packageCount}）`}
								actions={
									view.updatable ? (
										<>
											<button type="button" className="ghost" disabled={isBusy} onClick={onCheckUpdates}>
												{busy === "check" ? <IconLoader size={13} className="spin" /> : <IconSearch size={13} />}
												检查更新
											</button>
											<button
												type="button"
												className="ghost"
												disabled={isBusy}
												title="更新所有未固定版本的 npm / git 扩展包"
												onClick={() => onUpdate()}
											>
												{busy === "update" ? <IconLoader size={13} className="spin" /> : <IconRefresh size={13} />}
												全部更新
											</button>
										</>
									) : null
								}
							>
								{view.packages.length ? (
									<div className="provider-list">
										{view.packages.map(({ pkg, resources }) => (
											<PackageRow
												key={packageKey(pkg)}
												pkg={pkg}
												resources={resources}
												update={updateKeys.has(packageKey(pkg))}
												busy={isBusy}
												onToggle={onToggle}
												onUpdate={onUpdate}
												onReinstall={onReinstall}
												onRemove={onRemove}
											/>
										))}
									</div>
								) : (
									<SettingsCard>
										<div className="settings-empty">
											{view.packageCount ? "没有匹配的扩展包。" : "还没有安装扩展包。"}
										</div>
									</SettingsCard>
								)}
							</SettingsGroup>

							<SettingsGroup
								title={`独立扩展（${view.extensionCount}）`}
								actions={<CopyButton text={`${data.agentDir}/extensions`} label="复制扩展目录" />}
							>
								<p className="muted small settings-note">
									放在 <code>{data.agentDir}/extensions</code>
									{workspace ? (
										<>
											{" "}
											或 <code>{workspace.path}/.pi/extensions</code>
										</>
									) : null}{" "}
									中的 .ts / .js 文件或带 index.ts 的目录，以及 settings.json 中 <code>extensions</code> 列出的路径。
								</p>
								{view.extensions.length ? (
									<div className="provider-list">
										{view.extensions.map((resource) => (
											<ResourceRow
												key={resource.path}
												resource={resource}
												busy={isBusy}
												onToggle={onToggle}
												onDelete={onDelete}
											/>
										))}
									</div>
								) : (
									<SettingsCard>
										<div className="settings-empty">{view.extensionCount ? "没有匹配的扩展。" : "没有独立扩展。"}</div>
									</SettingsCard>
								)}
							</SettingsGroup>

							{view.otherCount ? (
								<SettingsGroup title={`技能、提示词与主题（${view.otherCount}）`}>
									{others.length ? (
										<div className="provider-list">
											{others.map((resource) => (
												<ResourceRow
													key={`${resource.type}:${resource.path}`}
													resource={resource}
													busy={isBusy}
													onToggle={onToggle}
												/>
											))}
											{!showAllOthers && !q && view.others.length > COLLAPSED_OTHERS ? (
												<button type="button" className="ghost show-all" onClick={() => setShowAllOthers(true)}>
													显示全部 {view.others.length} 项
												</button>
											) : null}
										</div>
									) : (
										<SettingsCard>
											<div className="settings-empty">没有匹配的资源。</div>
										</SettingsCard>
									)}
								</SettingsGroup>
							) : null}
						</>
					) : !error ? (
						<p className="muted">正在读取扩展…</p>
					) : null}
				</>
			)}
		</>
	);
}
