import type { ApprovalPolicy, WorkspaceInfo } from "@pier/protocol";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { POLICY_DESCRIPTION, POLICY_LABEL } from "../lib/format.ts";
import { type SettingsSection, useAppState, useStore } from "../lib/store.tsx";
import { AccountSettings } from "./AccountPanel.tsx";
import { ExtensionsSettings } from "./ExtensionsPanel.tsx";
import { HostBanner, LogsSettings, useHostStatus } from "./HostPanels.tsx";
import {
	IconArrowLeft,
	IconFolder,
	IconFolderPlus,
	IconInfo,
	IconLogs,
	IconPlus,
	IconPower,
	IconPuzzle,
	IconSearch,
	IconSettings,
	IconSmartphone,
	IconSparkles,
	IconUser,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { ModelsSettings } from "./ModelsPanel.tsx";
import { RemoteSettings } from "./RemotePanel.tsx";
import { SettingRow, SettingsCard, SettingsGroup } from "./SettingsUi.tsx";
import { useAddWorkspace } from "./Sidebar.tsx";
import { UpdateSettings, updatePending } from "./UpdatePanel.tsx";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

interface SectionDef {
	id: SettingsSection;
	label: string;
	icon: IconComponent;
	/** Extra words matched by the search box. */
	keywords: string;
	/** Needs a live connection to the host. */
	online?: boolean;
}

const GROUPS: Array<{ title: string; items: SectionDef[] }> = [
	{
		title: "账号",
		items: [
			{
				id: "account",
				label: "个人中心",
				icon: IconUser,
				keywords: "个人中心 账号 账户 云链 云链api 登录 注册 余额 充值 分组 令牌 key yunlian",
				online: true,
			},
		],
	},
	{
		title: "通用",
		items: [
			{ id: "general", label: "常规", icon: IconSettings, keywords: "host 状态 连接 版本 配置目录 重启 退出 pi" },
			{
				id: "models",
				label: "模型与服务商",
				icon: IconSparkles,
				keywords: "模型 服务商 provider api key 登录 默认模型 自定义接口 中转 ollama",
				online: true,
			},
			{
				id: "workspaces",
				label: "工作区",
				icon: IconFolder,
				keywords: "工作区 目录 审批 策略 权限 逐项审批 智能 自动放行 移除",
				online: true,
			},
			{
				id: "extensions",
				label: "扩展",
				icon: IconPuzzle,
				keywords: "扩展 插件 extension package 扩展包 npm git 安装 卸载 更新 启用 停用 技能 skill 提示词 prompt 主题",
				online: true,
			},
		],
	},
	{
		title: "连接",
		items: [
			{
				id: "remote",
				label: "设备与远程",
				icon: IconSmartphone,
				keywords: "手机 电脑 其他电脑 节点 互联 切换 远程 配对 二维码 链接 设备 局域网 端口 指纹",
				online: true,
			},
		],
	},
	{
		title: "系统",
		items: [
			{ id: "logs", label: "日志", icon: IconLogs, keywords: "日志 log host 排查" },
			{ id: "about", label: "关于与更新", icon: IconInfo, keywords: "关于 版本 更新 升级 发布说明" },
		],
	},
];

const SECTIONS = GROUPS.flatMap((group) => group.items);
const GENERAL = SECTIONS.find((item) => item.id === "general") as SectionDef;

// ---- pages -----------------------------------------------------------------------------

function GeneralSettings() {
	const store = useStore();
	const host = useAppState((s) => s.host);
	const hostInfo = useAppState((s) => s.localHostInfo);
	const status = useHostStatus();
	const tauri = store.bridgeKind === "tauri";
	const [confirmQuit, setConfirmQuit] = useState(false);
	const versions = [
		`Pier v${useAppState((s) => s.update.currentVersion)}`,
		host.version ? `Host v${host.version}` : "",
		hostInfo ? `pi ${hostInfo.piVersion}` : "",
	].filter(Boolean);
	return (
		<>
			<SettingsGroup title="Pier Host">
				<SettingsCard>
					<SettingRow
						title="连接状态"
						description={
							<span className="settings-inline-status">
								<span className={`status-dot ${status.dot}`} />
								{status.text}
								{host.restarts ? ` · 已自动重启 ${host.restarts} 次` : ""}
							</span>
						}
					>
						{tauri ? (
							<button type="button" onClick={() => store.restartHost()}>
								重启 Host
							</button>
						) : null}
					</SettingRow>
					<SettingRow title="版本" description="桌面端、Pier Host 与内置 pi 的版本。">
						<span className="setting-value">{versions.join(" · ")}</span>
					</SettingRow>
					{hostInfo?.agentDir ? (
						<SettingRow title="配置目录" description="模型、凭据与会话复用 pi 的配置，与终端里的 pi 共用。">
							<code className="setting-value mono" title={hostInfo.agentDir}>
								{hostInfo.agentDir}
							</code>
							<CopyButton text={hostInfo.agentDir} label="复制路径" iconOnly />
						</SettingRow>
					) : null}
					{host.url ? (
						<SettingRow title="本地地址" description="桌面界面连接 Host 使用的地址，仅本机可访问。">
							<code className="setting-value mono">
								{host.url}
								{host.pid ? ` · pid ${host.pid}` : ""}
							</code>
						</SettingRow>
					) : null}
					<SettingRow title="运行日志" description="连接或启动出现问题时，可以在这里查看 Host 输出。">
						<button type="button" onClick={() => store.openSettings("logs")}>
							<IconLogs size={14} />
							查看日志
						</button>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>
			{tauri ? (
				<SettingsGroup title="应用">
					<SettingsCard>
						<SettingRow
							title="退出 Pier"
							description="关闭窗口只会隐藏到托盘，Agent 继续运行；退出会停止 Pier Host 并中断正在运行的任务。"
						>
							<button
								type="button"
								className="danger"
								onBlur={() => setConfirmQuit(false)}
								onClick={() => {
									if (!confirmQuit) {
										setConfirmQuit(true);
										return;
									}
									store.quit();
								}}
							>
								<IconPower size={14} />
								{confirmQuit ? "确认退出" : "退出"}
							</button>
						</SettingRow>
					</SettingsCard>
				</SettingsGroup>
			) : null}
		</>
	);
}

function WorkspaceCard({ workspace }: { workspace: WorkspaceInfo }) {
	const store = useStore();
	const [confirmRemove, setConfirmRemove] = useState(false);
	return (
		<SettingsCard>
			<SettingRow
				title={
					<span className="settings-workspace-name">
						<IconFolder size={15} />
						{workspace.name}
					</span>
				}
				description={<span className="mono">{workspace.path}</span>}
			>
				<button
					type="button"
					className={confirmRemove ? "danger" : "ghost"}
					onBlur={() => setConfirmRemove(false)}
					onClick={() => {
						if (!confirmRemove) {
							setConfirmRemove(true);
							return;
						}
						void store.removeWorkspace(workspace.id);
					}}
					title="从 Pier 移除工作区（不会删除任何文件）"
				>
					{confirmRemove ? "确认移除" : "移除"}
				</button>
			</SettingRow>
			<SettingRow
				title="工具审批策略"
				description={
					<span className={workspace.policy === "auto" ? "warning-text" : undefined}>
						{POLICY_DESCRIPTION[workspace.policy]}
					</span>
				}
			>
				<select
					className="setting-select compact"
					value={workspace.policy}
					onChange={(e) => void store.setPolicy(workspace.id, e.target.value as ApprovalPolicy)}
				>
					{(["ask", "smart", "auto"] as ApprovalPolicy[]).map((policy) => (
						<option key={policy} value={policy}>
							{POLICY_LABEL[policy]}
							{policy === "smart" ? "（默认）" : ""}
						</option>
					))}
				</select>
			</SettingRow>
		</SettingsCard>
	);
}

function WorkspacesSettings() {
	const workspaces = useAppState((s) => s.localWorkspaces);
	const addWorkspace = useAddWorkspace();
	return (
		<>
			<p className="settings-intro">
				这里管理本机的工作区。每个工作区可以单独设置 Agent 调用工具时的审批策略。危险命令（rm -r、sudo、git push --force
				等）在“逐项审批”和“智能”策略下总是需要批准。移除工作区不会删除任何文件。
			</p>
			<SettingsGroup
				title={`工作区（${workspaces.length}）`}
				actions={
					<button type="button" onClick={() => void addWorkspace()}>
						<IconPlus size={14} />
						添加工作区
					</button>
				}
			>
				{workspaces.length ? (
					<div className="settings-stack">
						{workspaces.map((workspace) => (
							<WorkspaceCard key={workspace.id} workspace={workspace} />
						))}
					</div>
				) : (
					<button type="button" className="add-first" onClick={() => void addWorkspace()}>
						<IconFolderPlus size={16} />
						添加第一个工作区
					</button>
				)}
			</SettingsGroup>
		</>
	);
}

const PAGES: Record<SettingsSection, ComponentType> = {
	account: AccountSettings,
	general: GeneralSettings,
	models: ModelsSettings,
	workspaces: WorkspacesSettings,
	extensions: ExtensionsSettings,
	remote: RemoteSettings,
	logs: LogsSettings,
	about: UpdateSettings,
};

// ---- screen ----------------------------------------------------------------------------

function NavBadge({ id }: { id: SettingsSection }): ReactNode {
	const noModels = useAppState((s) => s.providers?.availableCount === 0);
	const remote = useAppState((s) => s.remote);
	const connected = useAppState((s) => s.devices.filter((d) => d.connected).length);
	const update = useAppState((s) => s.update);
	if (id === "models" && noModels) return <span className="nav-dot warn" title="还没有可用模型" />;
	if (id === "remote" && remote?.running) {
		return (
			<span className="nav-count" title={`${connected} 台设备在线`}>
				{connected}
			</span>
		);
	}
	if (id === "about" && updatePending(update)) return <span className="nav-dot accent" title="有可用更新" />;
	return null;
}

export function SettingsPage({ section }: { section: SettingsSection }) {
	const store = useStore();
	const [query, setQuery] = useState("");
	const { online } = useHostStatus();

	// Esc leaves the settings screen unless a dialog on top of it handles the key.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || document.querySelector(".modal-backdrop")) return;
			const target = e.target as HTMLElement | null;
			if (target?.tagName === "INPUT" && (target as HTMLInputElement).value) return;
			store.closeSettings();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [store]);

	const q = query.trim().toLowerCase();
	const groups = GROUPS.map((group) => ({
		...group,
		items: group.items.filter((item) => !q || `${item.label} ${item.keywords}`.toLowerCase().includes(q)),
	})).filter((group) => group.items.length);
	const current = SECTIONS.find((item) => item.id === section) ?? GENERAL;
	const Page = PAGES[current.id];

	return (
		<div className="app settings-screen">
			<aside className="sidebar settings-nav">
				<div className="settings-nav-top">
					<button type="button" className="ghost settings-back" onClick={() => store.closeSettings()}>
						<IconArrowLeft size={15} />
						返回应用
					</button>
				</div>
				<h1 className="settings-nav-title">设置</h1>
				<div className="settings-search">
					<IconSearch size={14} />
					<input placeholder="搜索设置" value={query} onChange={(e) => setQuery(e.target.value)} />
					{query ? (
						<button type="button" className="ghost icon" title="清除" onClick={() => setQuery("")}>
							<IconX size={13} />
						</button>
					) : null}
				</div>
				<nav className="settings-nav-list">
					{groups.map((group) => (
						<div key={group.title} className="settings-nav-group">
							<div className="settings-nav-group-title">{group.title}</div>
							{group.items.map((item) => (
								<button
									type="button"
									key={item.id}
									className={`settings-nav-item${item.id === current.id ? " selected" : ""}`}
									onClick={() => store.openSettings(item.id)}
								>
									<item.icon size={15} />
									<span className="settings-nav-label">{item.label}</span>
									<NavBadge id={item.id} />
								</button>
							))}
						</div>
					))}
					{!groups.length ? <div className="settings-nav-empty">没有匹配的设置</div> : null}
				</nav>
			</aside>
			<main className="main settings-main">
				<HostBanner onShowLogs={() => store.openSettings("logs")} />
				<div className="settings-scroll">
					<div className="settings-content">
						<h1 className="settings-title">{current.label}</h1>
						{current.online && !online ? (
							<SettingsCard>
								<div className="settings-empty">Pier Host 未连接，连接后才能修改这些设置。</div>
							</SettingsCard>
						) : (
							<Page key={current.id} />
						)}
					</div>
				</div>
			</main>
		</div>
	);
}
