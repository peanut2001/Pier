# Changelog

Pier 的所有重要变更都记录在这里。版本号规则：日常发版只递增最后一位（0.2.1、0.2.2……），`x.y.0` 留给大版本；1.0 之前，大版本可能包含不兼容的变更。

## 未发布

### 变更

- **桌面端新增设置界面**：侧边栏左下角的连接状态、模型、手机、更新和退出按钮合并为一个「设置」入口（保留连接状态点，有更新或缺少模型时显示提示点）。设置界面左侧为可搜索的分组导航，右侧为卡片式设置页：
  - 常规：Host 连接状态、版本、配置目录、本地地址，重启 Host 与退出 Pier；
  - 模型与服务商、手机与远程：原先的对话框移入设置页；
  - 工作区：集中管理各工作区的工具审批策略，添加或移除工作区；
  - 日志、关于与更新：Host 日志与软件更新（托盘菜单「检查更新…」会直接打开此页）。

  按 Esc 或「返回应用」回到会话界面。

## v0.2.1 — 2026-09-29

直接在 Pier 里配置模型，并支持桌面端自动更新。

### 新增

- **在 Pier 中直接配置模型**：不再需要另外安装 pi 命令行。桌面端新增「模型与服务商」面板（入口在侧边栏、会话的模型选择器；没有可用模型时，首页也会提示），可以：
  - 登录 pi 内置的任一服务商，支持 API Key 和账号登录（包括浏览器授权、设备码和粘贴授权码）；
  - 添加、编辑、删除 OpenAI / Anthropic / Gemini 兼容的自定义接口（中转站、公司网关、Ollama / LM Studio / vLLM 等），并可一键从接口获取模型列表；
  - 设置新会话的默认模型，移除已保存的凭据。

  凭据保存在 pi 的 `auth.json`，自定义接口写入 `models.json`（只改动编辑的那一项；文件含注释时会先备份为 `models.json.bak`，pi 无法加载时自动回滚），终端里的 `pi` 看到的是同一份配置。这些操作只能在电脑本机的桌面端进行，已配对的手机无权调用，接口返回的内容中也不包含任何密钥。
- **协议 1.2**（向后兼容）：新增仅限本地连接的 `provider.list` / `login` / `loginRespond` / `loginCancel` / `logout` / `saveCustom` / `removeCustom` / `probeModels` 与 `model.setDefault`，新增 Host 事件 `provider.changed`，以及只发给发起登录的连接的 `auth.*` 登录事件。
- **桌面端自动更新**（Tauri updater）：Pier 启动后不久以及之后每 6 小时检查一次最新的 GitHub Release（可关闭）。有新版本时显示提示和角标，可以在「软件更新」对话框中查看更新说明、下载进度并安装（入口：侧边栏角标、托盘菜单，或 Pier Host 面板中的「检查更新」）。
  - 更新包使用 Pier 的更新密钥签名，安装前会校验签名，被篡改或未签名的更新包会被拒绝。
  - 安装前先停止 Pier Host（如果还有正在运行或等待审批的会话，对话框会提醒），安装完成后自动重启 Pier；安装失败时 Host 会重新启动。
  - 支持 Linux 的 AppImage 和 deb、macOS 的应用包以及 Windows 的 NSIS 安装包。开发版会提示无法更新。

### 发布文件

- 桌面端：`pier-desktop-v0.2.1-linux-x64.deb` 与 `.AppImage`、`pier-desktop-v0.2.1-darwin-arm64.dmg`、`pier-desktop-v0.2.1-darwin-x64.dmg`、`pier-desktop-v0.2.1-windows-x64.setup.exe`。每个安装包都内置 Pier Host 和 pi 的运行时资源。
- 自动更新：各平台的更新包（macOS 为 `.app.tar.gz`）、对应的 `.sig` 签名，以及 `latest.json`。
- 独立 Host：`pier-host-v0.2.1-<系统>-<架构>` 压缩包，覆盖 linux-x64、linux-arm64、darwin-arm64、darwin-x64、windows-x64。
- `SHA256SUMS.txt` 列出所有文件的校验和。
- 手机 App 暂未作为发布文件提供，请参考 README 用 Expo 从源码运行。

### 已知限制

- v0.2.0 及更早的版本没有自动更新功能，需要手动安装一次 v0.2.1，之后的版本即可自动更新。
- 自动更新目前只在 Linux AppImage 上完整验证过，macOS 和 Windows 尚未在真机上验证。
- 账号登录（OAuth）尚未用真实账号在各平台上验证过。
- 安装包仍未做代码签名：macOS 需要移除隔离属性（`xattr -dr com.apple.quarantine /Applications/Pier.app`）或在「系统设置 → 隐私与安全性」中允许打开；Windows 的 SmartScreen 可能会要求确认。

## v0.2.0 — 2026-09-29

The mobile app and LAN remote access (milestone M3): pair a phone with the desktop by scanning a QR code, then watch and drive agents, answer approvals, and steer or abort runs from the phone over an end-to-end encrypted connection.

### Added

- **Remote access** in the Pier Host (off by default): an encrypted listener on port 7433 (configurable) for the local network and Tailscale / WireGuard, plus mDNS advertising (`_pier._tcp`). See `docs/security.md`.
  - `@pier/crypto`: Noise XX (pairing) and IK (reconnects) over X25519 / ChaCha20-Poly1305 / SHA-256 in pure JS, verified against the cacophony test vectors; encrypted channel frames; pairing links; a channel benchmark.
  - Pairing uses a single-use code (valid for 5 minutes) in a QR code that also pins the host key, and requires confirmation on the desktop. Paired devices are stored in `~/.pier/devices.json`; revoking one disconnects it immediately.
  - An audit log (`~/.pier/audit.log`) records what remote devices did (connections, pairing, prompts by length only, approvals).
  - New host flags: `--no-remote`, `--remote-port`, `--remote-address`, `--no-mdns`.
- **Protocol 1.1** (backwards compatible): `remote.status` / `remote.configure`, `pairing.start` / `cancel` / `respond`, `device.list` / `rename` / `revoke`, local-only host events for pairing and devices, a `session.activity` host event, and `pendingUi` counts in session summaries.
- **`@pier/client`**: `SecureWebSocket` / `createSecureSocketFactory` (encrypted transport with address fallback), `pairWithHost`, terminal close codes (a revoked device stops reconnecting), `reconnectNow()`, and an optional heartbeat.
- **Desktop app**: a "手机" panel to turn remote access on, show the pairing QR code, confirm pairing requests, and rename or revoke devices.
- **Mobile app** (`apps/mobile`, Expo SDK 57): scan or paste a pairing link (or open a `pier://pair` link), multiple computers, session lists with running / needs-approval badges, streaming chat with tool cards and diffs, approvals and extension dialogs, steer / follow-up / abort, image attachments, model and thinking-level switching, compaction, automatic reconnect with replay, revocation handling, and a crypto benchmark (Spike 3).
- `pier-cli`: `/remote`, `/pair`, `/devices`, `/revoke`.
- `pnpm faux-host --remote` for mobile UI work without real credentials.

### Changed

- The shared `ChatController` moved from the desktop app into `@pier/chat-state`.
- React is pinned to 19.2.3 across the workspace (the version Expo SDK 57 uses).
- **Desktop**: the model and thinking-level pickers are merged into one control in the session header, and the composer has a permission-mode (approval policy) picker that applies to the whole workspace.
- **Desktop UI refresh**: a more modern look across the app, in both dark and light themes.
  - New design tokens with the icon's blue-to-teal brand gradient, softer surfaces, rounded corners, and a floating main panel next to the sidebar.
  - SVG icons replace text glyphs throughout: sidebar, tool cards, menus, banners, toasts, and dialogs.
  - The sidebar has a brand header, a "New session" button, a folder tree with guide lines, and a host-status footer.
  - User messages appear as chat bubbles. Tool cards show per-tool icons and status badges with icons, and code blocks show their language label.
  - The composer has a toolbar with an image-attach button, the permission-mode picker, and a round send/stop button. The status bar shows a context-usage meter.
  - Approval cards, dropdowns, and modals are restyled with icons, blurred backdrops, and short enter animations. Animations respect `prefers-reduced-motion`.
  - The welcome screen and workspace home were redesigned with step cards, a workspace header, and a recent-sessions list.

### Release assets

- Desktop app: `pier-desktop-v0.2.0-linux-x64.deb` and `.AppImage`, `pier-desktop-v0.2.0-darwin-arm64.dmg`, `pier-desktop-v0.2.0-darwin-x64.dmg`, and `pier-desktop-v0.2.0-windows-x64.setup.exe`. Each bundle includes the Pier Host sidecar and pi's runtime assets.
- Standalone host: `pier-host-v0.2.0-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64.
- `SHA256SUMS.txt` lists the checksums of all assets.
- The mobile app is not attached as a release asset yet; run it from source with Expo (see the README).

### Known limitations

- The desktop bundles are still not code-signed; see the v0.1.0 notes for the macOS and Windows workarounds.
- The mobile app has been verified with its web build and the Hermes bundles for Android and iOS, but not yet on real phones; there are no store builds yet.
- The phone only reaches the desktop directly (same network or tailnet). Relay access and push notifications arrive in M5.

## v0.1.0 — 2026-09-28

The desktop app (milestone M2): run pi coding agents from a native window, with approvals, tool output, and diffs, without opening a terminal. The Pier Host keeps running in the tray when the window is closed.

### Added

- **Desktop app** (`apps/desktop`, milestone M2): a Tauri 2 shell that bundles the Pier Host as a sidecar.
  - The Rust side starts the host, reads its `pier.ready` line, restarts it after crashes (with backoff, giving up after repeated fast failures), keeps a log buffer, and shuts it down gracefully on quit. The host also exits when the shell dies.
  - Closing the window hides Pier in the system tray; agents keep running. A second launch focuses the running instance.
  - The React UI covers workspaces (add, remove, approval policy), sessions (create, open, rename, fork, close), streaming chat with Markdown and code highlighting, collapsible thinking, tool cards (terminal output, edit diffs, file previews), approval and dialog cards, steer / follow-up / abort, image attachments, model and thinking-level switching, context compaction, token and cost totals, and a host log viewer.
- **`@pier/chat-state`**: a pure reducer from snapshots and events to a chat view model, shared by the desktop and (later) mobile apps, with a transcript builder that folds tool results into their calls.
- `pnpm faux-host`: a development host backed by pi's faux model for UI work without real credentials.
- CI builds the desktop shell on Linux, macOS, and Windows; releases attach unsigned desktop bundles.

### Release assets

- Desktop app: `pier-desktop-v0.1.0-linux-x64.deb` and `.AppImage`, `pier-desktop-v0.1.0-darwin-arm64.dmg`, `pier-desktop-v0.1.0-darwin-x64.dmg`, and `pier-desktop-v0.1.0-windows-x64.setup.exe`. Each bundle includes the Pier Host sidecar and pi's runtime assets.
- Standalone host: `pier-host-v0.1.0-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64, as in v0.0.1.
- `SHA256SUMS.txt` lists the checksums of all assets.

Models and credentials come from pi's configuration (`~/.pi/agent`). If no model is available yet, run `pi` once in a terminal and log in.

### Known limitations

- The bundles are not code-signed. On macOS, remove the quarantine attribute (`xattr -dr com.apple.quarantine /Applications/Pier.app`) or allow the app in System Settings → Privacy & Security. On Windows, SmartScreen may ask you to confirm the installer.
- The desktop app has been verified end to end on Linux. The macOS and Windows bundles are built and checked in CI but have not yet been tested on real machines.
- There is no auto-update, autostart, desktop notifications, or session search yet.
- Only local connections are supported. Remote access, pairing, and the mobile app arrive in M3.

## v0.0.1 — 2026-09-28

First developer preview: the Pier Host core (milestones M0 and M1). There is no desktop or mobile app yet; you drive the Host with the `pier-cli` debug client.

### Added

- **Pier Host** (`packages/host`), built on the pi SDK 0.87.1 and reusing pi's configuration (`~/.pi/agent`):
  - workspaces with per-workspace approval policies (`ask` / `smart` / `auto`), stored in `~/.pier/config.json`;
  - an active session pool (create, open, fork, rename, close, idle eviction) that is compatible with `pi --resume`;
  - an extension UI bridge (select / confirm / input / editor, notifications, status, widgets) where the first client to answer wins;
  - the built-in `pier-approval` extension (read-only whitelist, dangerous-command detection, allow once / for this session / deny with a reason);
  - a per-session event log with replay-or-snapshot resume after disconnects, and optional merging of streaming deltas;
  - session file locks and detection of external writes to session files;
  - a local WebSocket gateway on `127.0.0.1` with token authentication and an Origin allowlist.
- **Protocol v1.0** (`packages/protocol`, documented in `docs/protocol.md`).
- **Client library and `pier-cli`** (`packages/client`) with automatic reconnect and seq-based resume.
- **Single-file sidecar builds** made with `bun build --compile`, shipped together with pi's runtime assets.

### Release assets

`pier-host-v0.0.1-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64. Each archive contains the `pier-host` executable plus the pi assets it needs next to it; `SHA256SUMS.txt` lists the checksums. The binaries are not code-signed. On macOS, remove the quarantine attribute (`xattr -d com.apple.quarantine pier-host`) or allow the binary in System Settings.

### Known limitations

- Only local connections are supported. Remote access, pairing, and the mobile app arrive in M3.
- The desktop app (M2) is not included yet.
