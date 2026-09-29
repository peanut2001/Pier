import type { AppUpdateStatus, PeerInfo } from "@pier/protocol";
import { type ReactNode, useEffect, useState } from "react";
import type { UpdateStatus } from "../lib/bridge.ts";
import { formatBytes, relativeTime } from "../lib/format.ts";
import { type PeerUpdateEntry, useAppState, useStore } from "../lib/store.tsx";
import {
	IconAlert,
	IconCheck,
	IconDownload,
	IconExternal,
	IconLoader,
	IconMonitor,
	IconRefresh,
	Logo,
} from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

export const RELEASES_URL = "https://github.com/yiranxiaohui/Pier/releases";

/** An update is waiting for the user (or being installed). */
export function updatePending(update: UpdateStatus | AppUpdateStatus): boolean {
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

/** What the update row of a paired computer says. */
function peerUpdateText(
	entry: PeerUpdateEntry | undefined,
	online: boolean,
	version: string | undefined,
	busySessions: number | undefined,
): { text: string; tone?: "error" | "warning" } {
	const status = entry?.status;
	if (!online) {
		return entry?.installing
			? { text: "正在安装更新，Pier 重启后会自动重新连接…" }
			: { text: "离线，重新连接后才能检查和安装更新" };
	}
	if (entry?.tooOld) {
		return {
			text: `Pier ${version ? `v${version} ` : ""}版本较旧，不支持远程更新；请先在那台电脑上更新一次，之后即可在这里更新`,
			tone: "warning",
		};
	}
	if (!status) return { text: "正在读取…" };
	const pendingVersion = status.version ? `v${status.version}` : "新版本";
	switch (status.state) {
		case "unsupported":
			return { text: "那台电脑运行的是开发版本或未经打包的构建，无法自动更新" };
		case "idle":
			return { text: `Pier v${status.currentVersion}` };
		case "checking":
			return { text: "正在检查更新…" };
		case "upToDate":
			return { text: `Pier v${status.currentVersion} 已是最新版本` };
		case "downloading": {
			const total = status.total ?? 0;
			const progress = total
				? `${formatBytes(status.downloaded)} / ${formatBytes(total)}（${Math.min(100, Math.round((status.downloaded / total) * 100))}%）`
				: formatBytes(status.downloaded);
			return { text: `正在下载 ${pendingVersion}：${progress}` };
		}
		case "installing":
			return { text: `正在安装 ${pendingVersion}，完成后那台电脑上的 Pier 会自动重启` };
		default:
			break;
	}
	const notes: string[] = [];
	if (status.state === "available") notes.push(`可以从 v${status.currentVersion} 更新到 ${pendingVersion}`);
	else notes.push(status.error ?? "检查更新失败");
	if (status.version && busySessions) {
		notes.push(`那台电脑上有 ${busySessions} 个会话正在运行或等待审批，更新会中断它们`);
	}
	if (status.version && status.installNeedsAuth) notes.push("安装时需要有人在那台电脑上输入管理员密码");
	return {
		text: notes.join("；"),
		...(status.state === "error" ? { tone: "error" as const } : busySessions ? { tone: "warning" as const } : {}),
	};
}

function PeerUpdateRow({ peer }: { peer: PeerInfo }) {
	const store = useStore();
	const entry = useAppState((s) => s.peerUpdates[peer.id]);
	const online = useAppState((s) => s.nodes[peer.id]?.connection === "open");
	const connection = useAppState((s) => s.nodes[peer.id]?.connection);
	const version = useAppState((s) => s.nodes[peer.id]?.hostInfo?.version) ?? peer.version;
	const [busySessions, setBusySessions] = useState<number | undefined>(undefined);
	const [confirm, setConfirm] = useState(false);
	const status = entry?.status;
	const pending = online && !entry?.tooOld && !!status && updatePending(status);
	const working = status?.state === "downloading" || status?.state === "installing" || !!entry?.busy;

	// Warn before stopping agents that are still working there.
	useEffect(() => {
		if (!pending || working) return;
		let alive = true;
		void store.busySessionCount(peer.id).then((count) => {
			if (alive) setBusySessions(count);
		});
		return () => {
			alive = false;
		};
	}, [store, peer.id, pending, working]);

	const { text, tone } = peerUpdateText(entry, online, version, pending && !working ? busySessions : undefined);
	let action: ReactNode = null;
	if (!online) {
		action =
			entry?.installing || connection === "connecting" ? (
				<IconLoader size={16} className="spin" />
			) : (
				<button type="button" onClick={() => store.retryNode(peer.id)}>
					重新连接
				</button>
			);
	} else if (working || status?.state === "checking") {
		action = <IconLoader size={16} className="spin" />;
	} else if (pending) {
		action = (
			<button
				type="button"
				className={confirm ? "danger" : "primary"}
				onClick={() => {
					if (busySessions && !confirm) {
						setConfirm(true);
						return;
					}
					setConfirm(false);
					void store.installPeerUpdate(peer.id);
				}}
				onBlur={() => setConfirm(false)}
			>
				<IconDownload size={14} />
				{confirm ? "仍然更新" : status?.state === "error" ? "重试安装" : `更新到 v${status?.version ?? ""}`}
			</button>
		);
	} else if (status && !entry?.tooOld && status.state !== "unsupported") {
		action = (
			<button type="button" onClick={() => void store.checkPeerUpdate(peer.id)}>
				<IconRefresh size={14} />
				检查更新
			</button>
		);
	}
	return (
		<SettingRow
			title={
				<span className="peer-update-title">
					<IconMonitor size={14} />
					{peer.name}
				</span>
			}
			description={<span className={tone ? `peer-update-${tone}` : undefined}>{text}</span>}
		>
			{action}
		</SettingRow>
	);
}

/** Pier on every paired computer: check for and install updates there. */
function PeerUpdates() {
	const store = useStore();
	const peers = useAppState((s) => s.peers);
	// Opening the page refreshes what each computer's updater knows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the page opens.
	useEffect(() => {
		for (const peer of peers) void store.loadPeerUpdate(peer.id);
	}, []);
	if (!peers.length) return null;
	return (
		<SettingsGroup title="其他电脑">
			<SettingsCard>
				{peers.map((peer) => (
					<PeerUpdateRow key={peer.id} peer={peer} />
				))}
			</SettingsCard>
			<p className="muted small settings-note">
				已配对的电脑可以在这里远程更新：那台电脑上的 Pier
				会下载并校验官方发布的更新包、安装，然后自动重启，本机随后自动重新连接。
			</p>
		</SettingsGroup>
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
			<PeerUpdates />
		</>
	);
}
