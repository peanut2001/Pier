import { type ReactNode, useEffect, useState } from "react";
import type { UpdateStatus } from "../lib/bridge.ts";
import { formatBytes, relativeTime } from "../lib/format.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { IconAlert, IconCheck, IconDownload, IconExternal, IconLoader, IconRefresh, Logo } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

export const RELEASES_URL = "https://github.com/yiranxiaohui/Pier/releases";

/** An update is waiting for the user (or being installed). */
export function updatePending(update: UpdateStatus): boolean {
	return (
		update.state === "available" ||
		update.state === "downloading" ||
		update.state === "installing" ||
		(update.state === "error" && !!update.version)
	);
}

function Progress({ update }: { update: UpdateStatus }) {
	const total = update.total ?? 0;
	const percent = total ? Math.min(100, Math.round((update.downloaded / total) * 100)) : undefined;
	return (
		<div className="update-progress">
			<div className="update-progress-track">
				<div
					className={`update-progress-bar${percent === undefined ? " indeterminate" : ""}`}
					style={percent === undefined ? undefined : { width: `${percent}%` }}
				/>
			</div>
			<div className="muted small">
				{update.state === "installing"
					? "正在安装，完成后 Pier 会自动重启…"
					: total
						? `正在下载 ${formatBytes(update.downloaded)} / ${formatBytes(total)}（${percent}%）`
						: `正在下载 ${formatBytes(update.downloaded)}…`}
			</div>
		</div>
	);
}

/** The “about and updates” settings page. */
export function UpdateSettings() {
	const store = useStore();
	const update = useAppState((s) => s.update);
	const [busySessions, setBusySessions] = useState(0);
	const [confirm, setConfirm] = useState(false);
	const pending = updatePending(update);
	const working = update.state === "downloading" || update.state === "installing";

	// Opening the page checks for updates unless one is already known or in progress.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the page opens.
	useEffect(() => {
		if (update.state === "idle" || update.state === "upToDate" || (update.state === "error" && !update.version)) {
			void store.checkForUpdates();
		}
	}, []);

	// Warn before stopping agents that are still working.
	useEffect(() => {
		if (!pending || working) return;
		let alive = true;
		void store.busySessionCount().then((count) => {
			if (alive) setBusySessions(count);
		});
		return () => {
			alive = false;
		};
	}, [store, pending, working]);

	const install = () => {
		if (busySessions && !confirm) {
			setConfirm(true);
			return;
		}
		setConfirm(false);
		void store.installUpdate();
	};

	let body: ReactNode = null;
	if (update.state === "unsupported") {
		body = (
			<p className="muted">
				当前是开发版本或未经打包的构建，无法自动更新。正式版本请从 GitHub Releases 下载安装包，之后即可在应用内更新。
			</p>
		);
	} else if (update.state === "checking") {
		body = (
			<div className="update-state">
				<IconLoader size={18} className="spin" />
				<span>正在检查更新…</span>
			</div>
		);
	} else if (pending && update.version) {
		body = (
			<>
				<div className="update-headline">
					<span className="update-badge">
						<IconDownload size={18} />
					</span>
					<div>
						<div className="update-title">Pier v{update.version} 可以更新</div>
						<div className="muted small">
							当前版本 v{update.currentVersion}
							{update.date ? ` · 发布于 ${relativeTime(update.date)}` : ""}
						</div>
					</div>
				</div>
				{update.notes ? (
					<div className="update-notes">
						<Markdown text={update.notes} />
					</div>
				) : null}
				{working ? <Progress update={update} /> : null}
				{update.state === "error" && update.error ? <div className="banner error inline">{update.error}</div> : null}
				{!working ? (
					<p className={`muted small${confirm ? " update-warning" : ""}`}>
						{busySessions
							? `有 ${busySessions} 个会话正在运行或等待审批。安装更新会停止 Pier Host 并中断它们，Pier 重启后可以继续这些会话。`
							: "安装时会停止 Pier Host，完成后 Pier 自动重启，会话记录不受影响。"}
					</p>
				) : null}
			</>
		);
	} else if (update.state === "upToDate") {
		body = (
			<div className="update-state ok">
				<IconCheck size={18} />
				<span>Pier v{update.currentVersion} 已是最新版本</span>
			</div>
		);
	} else if (update.state === "error") {
		body = <div className="banner error inline">{update.error ?? "检查更新失败"}</div>;
	}

	const action =
		pending && !working ? (
			<button type="button" className={confirm ? "danger" : "primary"} onClick={install}>
				<IconDownload size={14} />
				{confirm ? "仍然更新" : update.state === "error" ? "重试安装" : "更新并重启"}
			</button>
		) : working || update.state === "unsupported" ? null : (
			<button type="button" disabled={update.state === "checking"} onClick={() => void store.checkForUpdates()}>
				{update.state === "error" ? <IconAlert size={14} /> : <IconRefresh size={14} />}
				{update.state === "error" ? "重试" : "检查更新"}
			</button>
		);

	return (
		<>
			<SettingsCard className="about-card">
				<div className="about-head">
					<Logo size={44} />
					<div className="about-text">
						<div className="about-name">Pier</div>
						<div className="muted small">
							版本 v{update.currentVersion}
							{update.lastChecked && update.state !== "checking"
								? ` · 上次检查 ${relativeTime(update.lastChecked)}`
								: ""}
						</div>
					</div>
					{action}
				</div>
				{body ? <div className="about-body">{body}</div> : null}
			</SettingsCard>
			<SettingsGroup title="更新">
				<SettingsCard>
					{update.state !== "unsupported" ? (
						<SettingRow title="自动检查更新" description="启动时及每 6 小时检查一次，发现新版本时提醒你。">
							<Switch
								label="自动检查更新"
								checked={update.autoCheck}
								onChange={(checked) => void store.setUpdateAutoCheck(checked)}
							/>
						</SettingRow>
					) : null}
					<SettingRow title="发布说明" description="在 GitHub Releases 查看所有版本和安装包。">
						<button type="button" onClick={() => store.openExternal(RELEASES_URL)}>
							<IconExternal size={14} />
							打开
						</button>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>
		</>
	);
}
