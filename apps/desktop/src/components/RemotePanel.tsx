import type { DeviceInfo, PairingRequest } from "@pier/protocol";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { relativeTime } from "../lib/format.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { IconPencil } from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";
import { SettingRow, SettingsCard, SettingsGroup, Switch } from "./SettingsUi.tsx";

function useNow(intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

function countdown(expiresAt: string, now: number): string {
	const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** QR code as crisp SVG (dark modules on white, with the standard 4-module quiet zone). */
export function QrCode({ text, size = 232 }: { text: string; size?: number }) {
	const path = useMemo(() => {
		const qr = encode(text, { ecc: "M", border: 4 });
		let d = "";
		qr.data.forEach((row, y) => {
			row.forEach((dark, x) => {
				if (dark) d += `M${x} ${y}h1v1h-1z`;
			});
		});
		return { d, size: qr.size };
	}, [text]);
	return (
		<svg
			className="qr"
			width={size}
			height={size}
			viewBox={`0 0 ${path.size} ${path.size}`}
			shapeRendering="crispEdges"
			role="img"
			aria-label="配对二维码"
		>
			<rect width={path.size} height={path.size} fill="#fff" />
			<path d={path.d} fill="#000" />
		</svg>
	);
}

function platformLabel(device: { platform?: string; model?: string; appVersion?: string }): string {
	const platform =
		device.platform === "ios" ? "iOS" : device.platform === "android" ? "Android" : (device.platform ?? "");
	return [device.model, platform, device.appVersion ? `App ${device.appVersion}` : ""].filter(Boolean).join(" · ");
}

function PairingSection() {
	const store = useStore();
	const pairing = useAppState((s) => s.pairing);
	const remote = useAppState((s) => s.remote);
	const now = useNow();
	if (!remote?.running) return null;
	if (!pairing) {
		return (
			<SettingRow
				title="扫码配对"
				description="在手机上安装 Pier App，然后生成二维码扫描配对。配对码 5 分钟内有效，只能使用一次。"
			>
				<button type="button" className="primary" onClick={() => void store.startPairing()}>
					显示配对二维码
				</button>
			</SettingRow>
		);
	}
	const expired = Date.parse(pairing.expiresAt) <= now;
	return (
		<div className="setting-row">
			<div className="pairing">
				<div className={`qr-frame${expired ? " expired" : ""}`}>
					<QrCode text={pairing.uri} />
				</div>
				<div className="pairing-help">
					<ol>
						<li>打开手机上的 Pier，点“添加电脑”。</li>
						<li>扫描左侧二维码。</li>
						<li>在这台电脑上确认允许该设备连接。</li>
					</ol>
					<p className="muted small">
						{expired ? "二维码已过期。" : `二维码 ${countdown(pairing.expiresAt, now)} 后过期。`}
						手机会依次尝试：{pairing.addresses.join("、")}
					</p>
					<div className="row-actions">
						{expired ? (
							<button type="button" className="primary" onClick={() => void store.startPairing()}>
								重新生成
							</button>
						) : (
							<CopyButton text={pairing.uri} label="复制配对链接" />
						)}
						<button type="button" className="ghost" onClick={() => void store.cancelPairing()}>
							取消
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function DeviceRow({ device }: { device: DeviceInfo }) {
	const store = useStore();
	const [confirm, setConfirm] = useState(false);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(device.name);
	const details = platformLabel(device);
	return (
		<div className="device-row">
			<span
				className={`status-dot ${device.connected ? "ok" : "idle"}`}
				title={device.connected ? "已连接" : "未连接"}
			/>
			<div className="device-main">
				{editing ? (
					<form
						className="device-rename"
						onSubmit={(e) => {
							e.preventDefault();
							const trimmed = name.trim();
							if (trimmed && trimmed !== device.name) void store.renameDevice(device.id, trimmed);
							setEditing(false);
						}}
					>
						<input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
						<button type="submit">保存</button>
					</form>
				) : (
					<div className="device-name">
						{device.name}
						<button
							type="button"
							className="ghost icon small-icon"
							title="重命名"
							onClick={() => {
								setName(device.name);
								setEditing(true);
							}}
						>
							<IconPencil size={13} />
						</button>
					</div>
				)}
				<div className="muted small">
					{details ? `${details} · ` : ""}
					{device.connected
						? "在线"
						: device.lastSeenAt
							? `最近连接 ${relativeTime(device.lastSeenAt)}`
							: `配对于 ${relativeTime(device.pairedAt)}`}
				</div>
				<div className="muted small mono" title="设备密钥指纹">
					{device.fingerprint}
				</div>
			</div>
			<button
				type="button"
				className={confirm ? "danger" : "ghost"}
				onClick={() => {
					if (!confirm) {
						setConfirm(true);
						return;
					}
					void store.revokeDevice(device.id);
				}}
				onBlur={() => setConfirm(false)}
			>
				{confirm ? "确认移除" : "移除"}
			</button>
		</div>
	);
}

/** The “phone and remote access” settings page. */
export function RemoteSettings() {
	const store = useStore();
	const remote = useAppState((s) => s.remote);
	const devices = useAppState((s) => s.devices);
	const [port, setPort] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void store.loadRemote();
	}, [store]);

	if (!remote) return <p className="muted">正在读取状态…</p>;

	const toggle = async (enabled: boolean) => {
		setBusy(true);
		await store.configureRemote({ enabled });
		setBusy(false);
	};
	const portValue = port ?? String(remote.port);
	const portNumber = Number(portValue);
	const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

	return (
		<>
			<p className="settings-intro">
				用手机上的 Pier App 查看会话、继续对话和审批工具调用。只有配对过的设备能连接，所有内容端到端加密（Noise
				协议）；同一局域网、Tailscale / WireGuard 网络内均可使用。
			</p>
			<SettingsGroup title="局域网访问">
				<SettingsCard>
					<SettingRow
						title="允许配对的手机通过局域网连接"
						description={
							remote.running
								? `监听中 · 地址 ${remote.addresses.join("、") || "（未检测到局域网地址）"}${remote.mdns ? " · 局域网广播 _pier._tcp" : ""}`
								: `开启后 Pier 在端口 ${remote.port} 上接受连接。`
						}
					>
						<Switch
							label="允许局域网连接"
							checked={remote.enabled}
							disabled={busy}
							onChange={(enabled) => void toggle(enabled)}
						/>
					</SettingRow>
					{remote.enabled && remote.error ? (
						<div className="setting-row">
							<div className="banner error inline">{remote.error}</div>
						</div>
					) : null}
					<SettingRow title="端口" description="范围 1024–65535，修改后会重新监听。">
						<input
							className="port-input"
							inputMode="numeric"
							value={portValue}
							onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
						/>
						<button
							type="button"
							disabled={!portValid || portNumber === remote.port || busy}
							onClick={async () => {
								setBusy(true);
								await store.configureRemote({ port: portNumber });
								setPort(undefined);
								setBusy(false);
							}}
						>
							应用
						</button>
					</SettingRow>
					<SettingRow title="这台电脑的密钥指纹" description="配对时手机会显示同样的指纹，可用来核对。">
						<span className="mono setting-value">{remote.hostFingerprint}</span>
					</SettingRow>
				</SettingsCard>
			</SettingsGroup>

			<SettingsGroup title="配对新设备">
				<SettingsCard>
					{remote.running ? (
						<PairingSection />
					) : (
						<div className="settings-empty">开启局域网访问后即可扫码配对手机。</div>
					)}
				</SettingsCard>
			</SettingsGroup>

			<SettingsGroup title={`已配对的设备（${devices.length}）`}>
				{devices.length ? (
					<div className="device-list">
						{devices.map((device) => (
							<DeviceRow key={device.id} device={device} />
						))}
					</div>
				) : (
					<SettingsCard>
						<div className="settings-empty">还没有配对的设备。</div>
					</SettingsCard>
				)}
				<p className="muted small settings-note">移除设备会立即断开它的连接；它需要重新扫码配对才能再次连接。</p>
			</SettingsGroup>
		</>
	);
}

/** Asks the user to allow a device that presented a valid pairing code. */
export function PairingRequestDialog() {
	const store = useStore();
	const requests = useAppState((s) => s.pairingRequests);
	const now = useNow();
	const request: PairingRequest | undefined = requests[0];
	if (!request) return null;
	const details = platformLabel(request.device);
	return (
		<Modal title="允许新设备连接？" onClose={() => void store.respondPairing(request.id, false)}>
			<div className="pairing-request">
				<div className="pairing-device">{request.device.name}</div>
				{details ? <div className="muted">{details}</div> : null}
				<div className="host-facts">
					{request.address ? <span>来自 {request.address}</span> : null}
					<span>
						设备指纹 <span className="mono">{request.fingerprint}</span>
					</span>
					<span>{countdown(request.expiresAt, now)} 后自动拒绝</span>
				</div>
				<p className="warning-text small">
					允许后，这台设备可以查看你的会话，并在这台电脑上让 Agent 运行命令（仍受工作区审批策略约束）。
					如果这不是你刚刚扫码的设备，请拒绝。
				</p>
			</div>
			<div className="modal-actions">
				<button type="button" onClick={() => void store.respondPairing(request.id, false)}>
					拒绝
				</button>
				<button type="button" className="primary" onClick={() => void store.respondPairing(request.id, true)}>
					允许连接
				</button>
			</div>
		</Modal>
	);
}
