import type {
	ExtensionCatalogPackage,
	ExtensionCatalogResult,
	ExtensionCatalogSort,
	ExtensionCatalogType,
	ExtensionPackageInfo,
	ExtensionScope,
} from "@pier/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "../lib/format.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { IconAlert, IconCheck, IconDownload, IconExternal, IconLoader, IconSearch, IconX } from "./Icons.tsx";
import { Select } from "./Select.tsx";
import { SettingsCard } from "./SettingsUi.tsx";

/** The official pi package gallery the host searches (`extension.search`). */
export const GALLERY_URL = "https://pi.dev/packages";

const CATALOG_TYPE_LABEL: Record<ExtensionCatalogType, string> = {
	extension: "扩展",
	skill: "技能",
	theme: "主题",
	prompt: "提示词",
};

const SORT_LABEL: Record<ExtensionCatalogSort, string> = {
	downloads: "下载最多",
	recent: "最近发布",
	name: "按名称",
};

const SEARCH_DELAY_MS = 350;

/** The npm package name of an `npm:<name>[@version]` source. */
export function npmSourceName(source: string): string | undefined {
	const s = source.trim();
	if (!s.startsWith("npm:")) return undefined;
	const spec = s.slice(4);
	const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
	return (at > 0 ? spec.slice(0, at) : spec) || undefined;
}

/** "1.2M" / "32.5K" / "812". */
function compactNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
	return String(n);
}

function errorText(error: unknown): string {
	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) {
		return "这台电脑上的 Pier Host 版本不支持搜索扩展仓库，请先更新 Pier";
	}
	return message;
}

function CatalogRow({
	pkg,
	installedScopes,
	busy,
	installing,
	progress,
	onInstall,
	onOpen,
}: {
	pkg: ExtensionCatalogPackage;
	installedScopes: ExtensionScope[];
	busy: boolean;
	installing: boolean;
	progress?: string;
	onInstall: (pkg: ExtensionCatalogPackage) => void;
	onOpen: (url: string) => void;
}) {
	const installed = installedScopes.length > 0;
	const meta: ReactNode[] = [];
	if (pkg.author) meta.push(<span key="author">{pkg.author}</span>);
	if (pkg.monthlyDownloads !== undefined) {
		meta.push(<span key="downloads">{compactNumber(pkg.monthlyDownloads)} 次下载/月</span>);
	}
	if (pkg.publishedAt) {
		meta.push(
			<span key="date" title={new Date(pkg.publishedAt).toLocaleString()}>
				{relativeTime(pkg.publishedAt)}更新
			</span>,
		);
	}
	return (
		<div className="provider-row catalog-row">
			<div className="provider-main">
				<div className="provider-name">
					<button
						type="button"
						className="link-button catalog-name"
						title={`在浏览器中查看 ${pkg.name}`}
						onClick={() => onOpen(pkg.galleryUrl ?? pkg.npmUrl)}
					>
						{pkg.name}
					</button>
					{pkg.version ? <span className="mini-tag">v{pkg.version}</span> : null}
					{pkg.types.map((type) => (
						<span key={type} className="mini-tag accent">
							{CATALOG_TYPE_LABEL[type]}
						</span>
					))}
					{installed ? (
						<span
							className="mini-tag ok"
							title={installedScopes.map((s) => (s === "user" ? "全局" : "项目")).join("、")}
						>
							<IconCheck size={11} />
							已安装
						</span>
					) : null}
				</div>
				{pkg.description ? <div className="catalog-desc">{pkg.description}</div> : null}
				<div className="catalog-meta muted small">
					{meta}
					<button type="button" className="link-button" onClick={() => onOpen(pkg.npmUrl)}>
						npm
					</button>
					{pkg.repositoryUrl ? (
						<button type="button" className="link-button" onClick={() => onOpen(pkg.repositoryUrl as string)}>
							源码
						</button>
					) : null}
				</div>
				{installing && progress ? <div className="muted small mono">{progress}</div> : null}
			</div>
			<div className="row-actions">
				<button
					type="button"
					className={installed ? "ghost" : "primary"}
					disabled={busy}
					title={installed ? `重新安装 ${pkg.source}` : `安装 ${pkg.source}`}
					onClick={() => onInstall(pkg)}
				>
					{installing ? <IconLoader size={13} className="spin" /> : <IconDownload size={13} />}
					{installing ? "安装中…" : installed ? "重新安装" : "安装"}
				</button>
			</div>
		</div>
	);
}

/**
 * Browse and search the official pi package gallery (pi.dev/packages) through the managed
 * computer's host, and install a package with one click.
 */
export function ExtensionCatalog({
	installed,
	scope,
	onScopeChange,
	workspaceName,
	busy,
	installingSource,
	onInstall,
	unsupported,
}: {
	/** Packages already in settings, to mark installed results. */
	installed: ExtensionPackageInfo[];
	scope: ExtensionScope;
	onScopeChange: (scope: ExtensionScope) => void;
	workspaceName?: string;
	busy: boolean;
	/** The source being installed, while an install runs. */
	installingSource?: string;
	onInstall: (source: string, scope: ExtensionScope) => Promise<boolean>;
	/** Why the managed computer cannot search (its Pier is too old). */
	unsupported?: string;
}) {
	const store = useStore();
	const progress = useAppState((s) => s.extensionProgress);
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const [type, setType] = useState<ExtensionCatalogType | "">("");
	const [sort, setSort] = useState<ExtensionCatalogSort>("downloads");
	const [result, setResult] = useState<ExtensionCatalogResult>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const request = useRef(0);

	// Search shortly after typing stops.
	useEffect(() => {
		const value = input.trim();
		if (value === query) return;
		const timer = setTimeout(() => setQuery(value), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [input, query]);

	const search = useCallback(
		async (page: number) => {
			const id = ++request.current;
			if (page === 1) setLoading(true);
			else setLoadingMore(true);
			try {
				const next = await store.searchExtensionCatalog({
					...(query ? { query } : {}),
					...(type ? { type } : {}),
					sort,
					page,
				});
				if (id !== request.current) return;
				setResult((current) =>
					page > 1 && current
						? {
								...next,
								packages: [
									...current.packages,
									...next.packages.filter((p) => !current.packages.some((c) => c.name === p.name)),
								],
							}
						: next,
				);
				setError(undefined);
			} catch (e) {
				if (id !== request.current) return;
				setError(errorText(e));
				if (page === 1) setResult(undefined);
			} finally {
				if (id === request.current) {
					setLoading(false);
					setLoadingMore(false);
				}
			}
		},
		[store, query, type, sort],
	);

	useEffect(() => {
		if (!unsupported) void search(1);
	}, [search, unsupported]);

	const installedScopes = useMemo(() => {
		const map = new Map<string, ExtensionScope[]>();
		for (const pkg of installed) {
			const names = new Set([npmSourceName(pkg.source), pkg.kind === "npm" ? pkg.name : undefined]);
			for (const name of names) {
				if (!name) continue;
				const scopes = map.get(name) ?? [];
				if (!scopes.includes(pkg.scope)) scopes.push(pkg.scope);
				map.set(name, scopes);
			}
		}
		return map;
	}, [installed]);

	const install = (pkg: ExtensionCatalogPackage) => void onInstall(pkg.source, scope);
	const open = (url: string) => store.openExternal(url);
	const galleryLink = () => {
		const url = new URL(GALLERY_URL);
		if (query) url.searchParams.set("name", query);
		if (type) url.searchParams.set("type", type);
		if (sort !== "downloads") url.searchParams.set("sort", sort);
		open(url.href);
	};

	if (unsupported) {
		return (
			<SettingsCard>
				<div className="settings-empty">{unsupported}</div>
			</SettingsCard>
		);
	}

	const packages = result?.packages ?? [];
	return (
		<>
			<div className="catalog-toolbar">
				<div className="provider-search catalog-search">
					<IconSearch size={14} />
					<input
						placeholder="搜索 pi 官方扩展仓库：名称、描述或作者"
						value={input}
						spellCheck={false}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") setQuery(input.trim());
						}}
					/>
					{input ? (
						<button
							type="button"
							className="ghost icon"
							title="清除"
							onClick={() => {
								setInput("");
								setQuery("");
							}}
						>
							<IconX size={13} />
						</button>
					) : null}
				</div>
				<Select<ExtensionCatalogType | "">
					className="setting-select compact"
					value={type}
					title="按类型筛选"
					onChange={setType}
					options={[
						{ value: "", label: "全部类型" },
						...(Object.keys(CATALOG_TYPE_LABEL) as ExtensionCatalogType[]).map((t) => ({
							value: t,
							label: CATALOG_TYPE_LABEL[t],
						})),
					]}
				/>
				<Select
					className="setting-select compact"
					value={sort}
					title="排序"
					onChange={setSort}
					options={(Object.keys(SORT_LABEL) as ExtensionCatalogSort[]).map((s) => ({ value: s, label: SORT_LABEL[s] }))}
				/>
			</div>

			<div className="catalog-status muted small">
				<span>
					{loading ? (
						<>
							<IconLoader size={12} className="spin" /> 正在搜索…
						</>
					) : result ? (
						<>
							{result.origin === "pi.dev" ? "pi 官方扩展仓库" : "npm registry"}
							{query ? `中匹配「${query}」的` : "共"} {result.total.toLocaleString()} 个扩展包
						</>
					) : null}
				</span>
				<span className="catalog-status-actions">
					安装到
					<Select
						className="setting-select compact"
						value={scope}
						disabled={busy}
						onChange={onScopeChange}
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
					<button type="button" className="link-button" onClick={galleryLink}>
						<IconExternal size={12} /> pi.dev
					</button>
				</span>
			</div>

			{result?.notice ? (
				<div className="banner warning inline catalog-notice">
					<IconAlert size={15} />
					<span>{result.notice}</span>
				</div>
			) : null}
			{error ? (
				<div className="banner error inline catalog-notice">
					<IconAlert size={15} />
					<span>搜索扩展仓库失败：{error}</span>
					<button type="button" className="ghost" onClick={() => void search(1)}>
						重试
					</button>
				</div>
			) : null}

			{packages.length ? (
				<div className={`provider-list catalog-list${loading ? " stale" : ""}`}>
					{packages.map((pkg) => (
						<CatalogRow
							key={pkg.name}
							pkg={pkg}
							installedScopes={installedScopes.get(pkg.name) ?? []}
							busy={busy}
							installing={installingSource === pkg.source}
							{...(progress?.message ? { progress: progress.message } : {})}
							onInstall={install}
							onOpen={open}
						/>
					))}
					{result?.hasMore ? (
						<button
							type="button"
							className="ghost show-all"
							disabled={loadingMore || loading}
							onClick={() => void search((result?.page ?? 1) + 1)}
						>
							{loadingMore ? <IconLoader size={13} className="spin" /> : null}
							{loadingMore ? "正在加载…" : `加载更多（已显示 ${packages.length} / ${result.total.toLocaleString()}）`}
						</button>
					) : null}
				</div>
			) : result && !loading ? (
				<SettingsCard>
					<div className="settings-empty">{query ? `没有找到与「${query}」匹配的扩展包。` : "没有扩展包。"}</div>
				</SettingsCard>
			) : !error ? (
				<SettingsCard>
					<div className="settings-empty">
						<IconLoader size={13} className="spin" /> 正在读取 pi 官方扩展仓库…
					</div>
				</SettingsCard>
			) : null}
		</>
	);
}
