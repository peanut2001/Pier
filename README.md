# Pier

A desktop dock and mobile remote for coding agents.

Pier 是编码 Agent 在桌面上的停靠点：Agent 常驻在你的电脑上运行，桌面端和手机端都能连上去查看、驱动和审批。内置 [pi](https://github.com/earendil-works/pi)，也能驱动电脑上安装的 [Claude Code](https://code.claude.com) 与 [Codex](https://github.com/openai/codex)：三种 Agent 的会话在同一个工作区中并存，都可以在桌面端和手机端查看、驱动和审批。

- 桌面端：Tauri 2，内置 Pier Host（Agent 运行时：内置的 pi SDK，以及电脑上安装的 Claude Code、Codex）
- 手机端：Expo / React Native 原生 App，通过配对后的加密连接驱动桌面 Agent
- 电脑之间：每台电脑都是一个节点，桌面端可以添加其他电脑，那台电脑的工作区和会话与本机的一起列在侧边栏中，直接查看和驱动那台电脑上的 Agent，并管理它的工作区（配对即完全信任）
- 不在同一网络：通过自建的 [Pier Relay](apps/relay/README.md) 连接（私有 / 开放两种模式，带网页管理后台：账号、访问令牌、在线切换模式），优先打洞 P2P 直连，打不通时经中继转发；中继只看得到密文

开发计划见 [docs/PLAN.md](docs/PLAN.md)，协议见 [docs/protocol.md](docs/protocol.md)，远程访问的安全设计见 [docs/security.md](docs/security.md)，技术验证结论见 [docs/spikes.md](docs/spikes.md)。

## 当前状态

M0–M2（Host 核心、桌面端 MVP）已完成；M3（手机端 MVP，局域网）的代码已完成，待 iOS / Android 真机验证：

| 包 | 说明 |
|---|---|
| `packages/protocol` | 协议 schema（zod）、类型、`PROTOCOL_VERSION` |
| `packages/host` | Pier Host：工作区配置、会话池、Agent 运行时适配层（pi SDK、Claude Code、Codex）、UI 桥接、`pier-approval` 审批扩展、pi 扩展包管理、EventLog、本地 WebSocket Gateway、sidecar 入口 |
| `packages/crypto` | Noise XX / IK（X25519、ChaCha20‑Poly1305、SHA‑256，纯 JS）、加密通道帧、配对链接、性能测试 |
| `packages/client` | 通用客户端（握手、请求关联、自动重连、按 seq 恢复）、加密 WebSocket 与配对，以及调试 CLI `pier-cli` |
| `packages/chat-state` | 快照 + 事件 → 聊天视图状态的纯逻辑 reducer、会话控制器与斜杠命令解析执行（桌面端与手机端共用） |
| `apps/desktop` | Tauri 2 桌面应用：管理 Host sidecar（启动、崩溃重启、日志）、托盘常驻、单实例；React 界面含工作区与会话管理、流式聊天、工具卡片（终端输出、diff、文件预览）、审批、模型与思考等级切换、压缩、分叉、斜杠命令菜单、右侧工作区文件面板（含上传本地文件 / 文件夹、拖入上传与下载文件到本地）、底部内置终端（xterm.js + 桌面端的 PTY；在工作区所在的电脑上打开，其他电脑的终端经它的 Pier Host 转发）、底部状态栏的主机状态（本机与已添加的其他电脑的 CPU、内存、磁盘、网络占用）、pi 扩展与扩展包管理（安装、移除、更新、启用 / 停用）、pi 配置（`settings.json`）以及 Claude Code（`settings.json`）与 Codex（`config.toml`）配置的可视化编辑，远程访问、配对二维码与设备管理，以及电脑之间互联（添加其他电脑，它们的工作区与会话和本机的统一列在侧边栏中） |
| `apps/relay` | Pier Relay：手机 / 电脑都没有公网 IP 时转发端到端加密的连接，内置 STUN 帮助 P2P 打洞；私有模式（令牌）与开放模式，Docker 镜像 `ghcr.io/yiranxiaohui/pier-relay` |
| `apps/mobile` | Expo（SDK 57）手机 App：扫码配对、多台电脑、会话列表、流式聊天、工具卡片、审批、steer / follow-up / 中止、附图、模型切换、斜杠命令、上下文与 token 用量、重命名 / 分叉 / 压缩、工作区文件（预览、编辑、上传下载）、远程终端、主机状态、pi 扩展管理、断线重连补发、Android 应用内更新 |

## 开发

需要 Node 22+（推荐 24）和 [Bun](https://bun.sh)：Bun 管理依赖（`bun.lock`，版本见 `package.json` 的 `packageManager`）并编译 sidecar，脚本和测试仍在 Node 上运行。

```bash
bun install
bun run lint       # Biome
bun run typecheck  # tsc -b（项目引用）
bun run test       # Vitest：单元测试 + 基于 faux 模型的端到端测试
```

### Claude Code 与 Codex

新建会话时，输入框下方的「Agent」选择框可以选择 pi、Claude Code 或 Codex（手机端点「新建」时选择）。Claude Code 与 Codex 使用电脑上安装的 CLI 和它们自己的登录、配置与会话目录，Pier 不需要另外配置模型或凭据：

- **Claude Code**：安装 `claude` 并登录（`claude` 中执行 `/login`，或设置 `ANTHROPIC_API_KEY`）。Pier 通过 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 驱动这个 CLI，会话保存在 `~/.claude/projects`，可以随时用 `claude --resume` 在终端继续。
- **Codex**：安装 `codex` 并登录（`codex login`）。Pier 通过 `codex app-server` 驱动它，会话由 Codex 保存（`~/.codex/sessions`），可以用 `codex resume` 在终端继续。

CLI 不在 `PATH` 中时，可以用 `PIER_CLAUDE_PATH` / `PIER_CODEX_PATH` 指定路径。工作区的审批策略同样适用于它们：Claude Code 请求许可、Codex 请求审批时，Pier 按策略放行或在桌面端和手机端询问你；Codex 的沙箱按策略设置（「询问」「智能」为工作区可写沙箱，「自动」不使用沙箱）。它们的会话显示在侧边栏中（带「Claude Code」「Codex」标记），也包括在终端里创建的会话。pi 的扩展、技能与 `settings.json` 只作用于 pi 会话。协议上的细节见 [docs/protocol.md](docs/protocol.md) 的「Agent 运行时」一节。

**可视化配置**：「设置 → Agent 配置」中的「Claude Code」与「Codex」标签页直接编辑它们自己的配置文件（与终端中的 CLI 共用），可以选择全局设置或某个工作区的设置，表单中标出每一项的当前值、继承或默认值，也可以切换到 JSON / TOML 直接编辑整个文件：

- **Claude Code**：`~/.claude/settings.json`、工作区的 `.claude/settings.json`（项目）与 `.claude/settings.local.json`（本地）。包括接口与认证（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`，便于使用中转接口）、默认模型与别名对应的模型、思考程度、权限规则（允许 / 询问 / 禁止）、沙箱、MCP 与 Hooks 开关、隐私与自动更新，以及其他环境变量。
- **Codex**：`~/.codex/config.toml` 与工作区的 `.codex/config.toml`（可以在页面中把工作区设为受信任的项目，Codex 才会读取它）。包括默认模型、思考程度与摘要、服务商（`model_providers`：添加兼容 OpenAI 的中转接口并设为当前）、网页搜索、命令环境、审批与沙箱等。修改时保留文件中的注释与格式。

修改对之后新建（或重新打开）的会话生效。Pier 按工作区审批策略设置的项（Claude Code 的默认权限模式，Codex 的审批策略与沙箱）只影响终端中的 CLI。设置其他电脑时这两页修改那台电脑上的文件，那台电脑需要协议 1.23 或更高。

**一键接入云链API**：在「设置 → 个人中心」中把一个分组配置到本地后，点该分组的「Claude Code / Codex」，可以用同一个令牌把它们接入这个分组（写入全局配置，密钥由 Host 直接写入，需要协议 1.25）：

- **Claude Code**：`ANTHROPIC_BASE_URL` 设为站点地址、`ANTHROPIC_AUTH_TOKEN` 设为令牌，opus / sonnet / haiku 别名各自对应分组中该系列最新的模型，可选指定默认模型；同时移除会改用其他凭据或模型的 `ANTHROPIC_API_KEY`、`apiKeyHelper`、`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`。
- **Codex**：添加服务商 `[model_providers.<分组 ID>]`（站点的 `/v1`、Responses API、`experimental_bearer_token`），设为当前服务商并设置默认模型。Codex 只用 Responses API，模型所在的渠道需要支持它（OpenAI 类模型排在前面）。

正在使用的分组会标出「Claude Code」「Codex」，之后可以在「Agent 配置」中查看和修改。

调试时 `bun run faux-host --agents` 会同时提供电脑上的 Claude Code 与 Codex（真实会话，会消耗额度）；`npx tsx packages/host/scripts/live-agent-check.ts claude-code [模型]` 用真实 CLI 走一遍创建、流式输出、审批、重命名、重新打开与分叉。

### pi 的配置

Host 复用 pi 的配置（`~/.pi/agent`：模型、凭据、settings、会话目录）。桌面端可以直接在「设置 → 模型与服务商」中登录服务商（API Key 或账号）、一键「浏览器登录」云链API（在浏览器中授权后自动获取令牌和全部模型），或在「设置 → 个人中心」通过浏览器登录云链API 账号（Pier 不接触密码）、查看余额，并按分组把令牌一键配置为本地服务商、添加 OpenAI / Anthropic / Gemini 兼容的自定义接口并设置默认模型，不需要另外安装 pi；已经用 `pi` 配置过的电脑会直接沿用原有配置。

```bash
# 终端 1：启动 Host（监听 127.0.0.1 的随机端口，并写入 ~/.pier/run/host.json）
bun run host

# 终端 2：调试客户端（自动读取 ~/.pier/run/host.json）
bun run pier-cli
> /ws add /path/to/project
> /new
> 列出当前目录的文件
> /allow            # 响应审批请求；/deny <理由>、/allow session
> /drop             # 模拟断线，验证重连补发
> /help
```

### 桌面端

除 Node 与 Bun 外还需要 Rust（stable），以及 Tauri 的[系统依赖](https://v2.tauri.app/start/prerequisites/)（Linux 上为 `libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等）。

```bash
bun run desktop                               # 构建 sidecar，然后 tauri dev（热更新前端）
bun run --cwd apps/desktop build              # 打包安装包（deb / AppImage / dmg / NSIS，取决于平台）
```

桌面端启动时会拉起内置的 Pier Host（`--watch-stdin`），关闭窗口只会隐藏到托盘，Agent 继续运行；从托盘或“设置 → 常规 → 退出 Pier”才会停止 Host。可用 `PIER_DIR` 隔离 Pier 状态目录，用 `PIER_HOST_BIN` 指定其他 Host 可执行文件。

**自动更新**：打包后的桌面端（Linux AppImage / deb、macOS、Windows NSIS）启动约 20 秒后以及之后每 6 小时检查一次 GitHub 上最新正式版的 `latest.json`（可在“设置 → 关于与更新”中关闭）。发现新版本时会弹出提示，左下角“设置”入口出现提示点；在“设置 → 关于与更新”（点击该入口，或托盘菜单“检查更新…”）中查看发布说明并“更新并重启”：下载更新包、用内置公钥校验签名、停止 Pier Host、安装，然后自动重启。开发构建（`tauri dev`）不支持自动更新。`PIER_UPDATER_ENDPOINT=<https 地址>` 可让打包版本改读其他清单（签名仍按内置公钥校验）；浏览器界面调试时在地址后加 `&updates=demo` 可使用模拟的更新流程。自动检查的开关保存在应用配置目录的 `updater.json` 中。

**远程更新其他电脑**：已添加的其他电脑同样可以在本机更新。“设置 → 关于与更新”底部的“其他电脑”列出每台电脑的 Pier 版本，可以检查更新并“更新到 vX”：那台电脑上的 Pier 通过它的 Host 收到请求，按上面的流程下载、校验签名、安装并自动重启，本机随后自动重新连接并提示更新结果；那台电脑上正在运行的会话会被中断（有的话会先提醒）。Linux `.deb` / `.rpm` 安装需要有人在那台电脑上输入管理员密码。那台电脑需要先升级到支持远程更新的版本（协议 1.13）；开发版本或未打包的构建无法远程更新。调试界面时可用 `bun run faux-host --remote --demo-updates` 起一个带模拟更新器的 Host，与另一个 faux Host 配对后在“其他电脑”中演示整个流程。

**设置其他电脑上的 Pier**：添加了其他电脑后，设置页左上角会出现「设置哪台电脑上的 Pier」选择框。切换到另一台电脑时，桌面端通过加密通道读取（同步）那台电脑的设置，「常规」「个人中心」「模型与服务商」「扩展」「Agent 配置」这几页随后显示并直接修改那台电脑上的 Pier（凭据、自定义接口、默认模型、扩展包、`settings.json` 都保存在那台电脑上）；点击选择框旁或页面顶部的「同步」可随时重新读取。「设备与远程」「日志」仍只针对本机，「工作区」「关于与更新」同时列出所有电脑。浏览器授权（云链API 浏览器登录、个人中心的浏览器登录）会回到 Host 所在电脑的回环地址，因此只能用于本机；设置其他电脑时，请在个人中心用账号密码或访问令牌登录，或填写 API Key。那台电脑需要协议 1.10 或更高（pi 配置需要 1.15，Claude Code 与 Codex 配置需要 1.23），版本过旧时页面会提示先更新它。

**Windows 安装程序语言**：NSIS 安装 / 卸载程序内置英文、简体中文和繁体中文（`bundle.windows.nsis.languages`），按 Windows 的界面语言自动选择，不弹出语言选择框；系统语言不在列表中时使用英文。

**macOS 首次打开**：安装包目前只做了本机签名（ad-hoc，`bundle.macOS.signingIdentity: "-"`），没有 Apple Developer ID 签名和公证。从浏览器下载后第一次打开时，macOS 会提示“无法验证开发者”（或“Apple 无法检查其是否包含恶意软件”）：把 Pier 拖进「应用程序」，双击打开一次后到「系统设置 → 隐私与安全性」底部点「仍要打开」并确认即可，之后正常启动；应用内自动更新不会再触发该提示。v0.2.2 及更早的安装包完全未签名，macOS 会误报“已损坏，无法打开”，这时在终端执行 `xattr -dr com.apple.quarantine /Applications/Pier.app` 后再打开（仍不行时再执行 `codesign --force --deep --sign - /Applications/Pier.app`）。

只调界面时可以不启动 Tauri：用假模型（faux）起一个 Host，再在浏览器里打开 Vite 开发服务器：

```bash
bun run faux-host                             # 输出 url 与 token，状态放在临时目录
bun run --cwd apps/desktop dev:web            # http://localhost:1420/?url=<url>&token=<token>
```

发送包含“演示”的消息会运行一段脚本化任务（bash、write、edit 与一次需要审批的命令）。在地址后加 `&terminal=demo` 可以用一个模拟的回显 shell 调试终端面板（浏览器模式下没有真实终端）。

### 手机端

手机 App 通过加密通道连接电脑上的 Host，需要先在桌面端“手机”面板中开启远程访问并扫码配对（原理见 [docs/security.md](docs/security.md)）。手机上也可以添加工作区：在电脑的页面右上角点「+」，浏览电脑上的目录（或直接输入绝对路径）并选择一个即可；点工作区的名称可以修改它的工具审批策略，或把它从 Pier 中移除（不删除任何文件）；会话中点顶部的审批模式标签（或右上角「⋯」）也能直接切换。电脑上的 Pier 需支持协议 1.10。电脑的 IP 变了时不用重新配对：在首页长按那台电脑选「修改连接地址」，或在它的页面右上角点「地址」（连不上时连接提示中也有「修改地址」），填入新地址即可；配对时固定的密钥不变，新地址上如果是另一台电脑，连接会被拒绝。

桌面端的大部分工具在手机上也能用（电脑上的 Pier 版本较旧时，对应入口会隐藏）：

- **主机状态**：电脑页面顶部每 3 秒刷新一次 CPU、内存、磁盘占用与网络速率（协议 1.12）。
- **工作区文件**：点工作区卡片上的文件夹图标（或工作区设置、会话的「⋯」中的「工作区文件」）浏览目录，预览文本和图片、编辑并保存文本文件，新建文件，从手机的文件或相册上传，下载到手机上选定的文件夹，长按可以复制路径或删除（浏览需要协议 1.7，编辑与删除 1.11，上传下载 1.21）。
- **终端**：电脑页面的「终端」或工作区中的「在这里打开终端」在那台电脑上启动 shell（协议 1.18，需要桌面端运行的 Host）。手机用 `@xterm/headless` 解析输出（颜色、光标、全屏程序），底部是输入行和 Ctrl / Esc / Tab / 方向键等按键栏。终端属于当前连接，断线或 App 切到后台被系统断开时会结束。
- **pi 扩展**：安装、更新、移除扩展包，启用或停用扩展、技能、提示词模板与主题；从工作区设置进入时还包括该工作区的项目设置（协议 1.10）。
- **会话**：顶部的上下文标签显示最近一次请求占上下文窗口的比例，右上角「⋯」中有上下文、累计 token、费用与缓存命中率，以及重命名、压缩上下文（可填写摘要要点）、从历史消息分叉、归档、关闭和删除。

设备管理、配对与远程访问只能在电脑本机上操作（协议中的 🔒 方法）；服务商登录、模型配置、个人中心以及 pi / Claude Code / Codex 的配置文件编辑暂时只在桌面端提供。

```bash
bun run --cwd apps/mobile start               # Metro 开发服务器
bun run --cwd apps/mobile android             # 本地构建并安装 Android 开发版（需要 Android SDK）
bun run --cwd apps/mobile ios                 # 本地构建 iOS 开发版（需要 macOS 与 Xcode）
cd apps/mobile && eas build --profile development   # 或用 EAS 云构建开发版
```

App 用到相机、安全存储等原生模块，推荐使用开发构建（development build），而不是 Expo Go。每个 GitHub Release 都附带签好名的 Android 安装包 `pier-mobile-v<版本>-android.apk`，可以直接安装到手机上试用。iOS 暂时没有打包，需要自行构建。没有设备时可以用 Web 版调界面（安全存储回退为 localStorage，仅供开发）：

```bash
bun run faux-host --remote                    # 假模型 Host，并在 7433 端口开启远程访问
bun run --cwd apps/mobile web                 # 在浏览器中“添加电脑 → 粘贴配对链接”
```

**手机端自动更新（Android）**：正式版 APK 启动后几秒以及之后回到前台时（最多每 6 小时一次）检查 GitHub 上最新正式版的 `latest-android.json`（可在“设置 → 软件更新”中关闭）。发现新版本时首页顶部出现提示，可以直接“下载并安装”或忽略这个版本；“设置 → 软件更新”中显示发布说明与下载进度。APK 下载到 App 的缓存目录后先核对大小与 MD5（由原生代码计算），再交给系统安装程序；Android 在安装时校验 APK 签名，并且只允许用同一把 Pier 发布密钥签名的安装包覆盖已安装的 App。安装需要用户在系统界面中确认，首次更新时还要允许 Pier“安装未知应用”（App 为此声明了 `REQUEST_INSTALL_PACKAGES` 权限）。更新保留已配对的电脑。开发构建、iOS 与 Web 版不支持应用内更新；这个功能之前的版本需要手动安装一次新版 APK。

配对链接可以从桌面“设置 → 手机与远程 → 显示配对二维码 → 复制配对链接”获得；只运行 faux-host 时，也可以用 `bun run pier-cli --url <url> --token <token>` 输入 `/pair` 生成链接，再用 `/pair yes` 确认（`/remote`、`/devices`、`/revoke` 管理远程访问与设备）。Android 模拟器访问宿主机时，用 `bun run faux-host --remote --remote-address 10.0.2.2:7433` 让二维码里带上模拟器可达的地址。

### Sidecar

构建单文件 sidecar（输出到 `packages/host/bin/`，包含 pi 运行时资源）：

```bash
bun run build:sidecar                            # 当前平台
bun run build:sidecar --target bun-darwin-arm64  # 交叉编译
packages/host/bin/pier-host --help
```

Pier 自身状态保存在 `~/.pier`（可用 `PIER_DIR` 覆盖）：`config.json`（工作区、审批策略与远程访问设置）、`run/host.json`（运行中 Host 的端口与本地 token，权限 0600）、`locks/`（会话文件锁）、`identity.json`（Host 的 X25519 私钥）、`devices.json`（已配对设备）、`audit.log`（远程设备的操作记录）。后三个文件权限均为 0600。

配对过的其他电脑保存在 `peers.json`（0600）中；桌面界面经本地 Gateway 的 `/peer/<id>` 连接它们，由 Host 用自己的密钥完成加密握手（见 [docs/security.md](docs/security.md) §4.4）。那台电脑的 IP 变了时，在「设置 → 设备与远程 → 可连接的其他电脑」中点「编辑」修改它的地址即可，无需重新配对（省略端口时沿用原来的端口）。

远程访问相关的命令行参数：`--no-remote`（本次运行不开启远程访问）、`--remote-port <n>`、`--remote-address <host:port>`（写进配对二维码的地址，可重复，例如 Tailscale 域名）、`--no-mdns`、`--relay <url>`（本次运行注册到这个中继，令牌取 `PIER_RELAY_TOKEN`）、`--no-p2p`。

**不在同一网络时（中继与 P2P）**：在一台有公网 IP 的服务器上部署 [Pier Relay](apps/relay/README.md)（Docker 镜像，放在 TLS 反向代理后，并开放 UDP 3478 供 STUN），然后在桌面「设置 → 设备与远程 → 中继服务器」填写 `wss://` 地址和访问令牌（私有模式；在中继的网页管理后台注册账号后创建）。中继在线后，新的配对二维码会带上中继地址；手机和其他电脑先尝试直连地址，连不上再经中继，连上后自动尝试 WebRTC 打洞，成功则切换到 P2P 直连（界面无感，设备列表显示「P2P 直连」），失败继续经中继。已配对的手机可以在「修改连接地址」中补上中继地址。调试：`bun run relay -- --mode open --stun-port 3478` 起一个本地中继，`bun run faux-host --relay ws://127.0.0.1:7480` 注册到它。

## 发版

版本号统一由根 `package.json` 与各包的 `version` 决定（`packages/host/test/version.test.ts` 会校验它们与 `PIER_HOST_VERSION`、`pier-cli` 版本及 `CHANGELOG.md` 一致）。

**版本号规则**：日常发版只递增最后一位（`v0.2.1`、`v0.2.2`……），`x.y.0` 留给大版本。

**发布说明**：GitHub Release 和应用内「软件更新」显示的说明都取自 `CHANGELOG.md` 中对应版本的小节，请尽量用中文撰写。

1. 更新所有版本号，并在 `CHANGELOG.md` 中新增 `## v<版本> — <日期>` 小节；合并到 `main`。
2. 在 `main` 的该提交上打 tag 并推送：`git tag -a v<版本> -m "Pier v<版本>" && git push origin v<版本>`。
3. `.github/workflows/release.yml` 会校验 tag、版本号以及该提交是否在 `main` 上，然后运行完整检查；接着在各平台 runner 上用 `tauri build` 打包桌面端安装包（deb / AppImage / dmg / NSIS；macOS 包为 ad-hoc 签名并校验签名，未公证；其他平台未签名），并用 `packages/host/scripts/smoke-sidecar.mjs` 冒烟测试安装包内置的 sidecar；同时用 `expo prebuild` + Gradle 构建 Android APK（arm64-v8a / armeabi-v7a / x86_64）；最后创建 GitHub Release，附带桌面端安装包、更新包及其签名、`latest.json`、Android APK、`latest-android.json` 和 `SHA256SUMS.txt`，发布说明取自 CHANGELOG。Pier Host 随桌面端一起安装，不再单独发布 sidecar 压缩包。版本号带 `-` 后缀（如 `0.1.0-rc.1`）时标记为 prerelease。

打 tag 之前可以先在 `main` 上手动触发一次试运行：`gh workflow run release.yml --ref main`。它会构建并冒烟测试全部产物（上传为 workflow artifacts），但跳过 tag 校验和发布。

**更新签名**：`tauri.conf.json` 开启了 `createUpdaterArtifacts`，桌面端打包时会用仓库 secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 为更新包（AppImage、deb、macOS `.app.tar.gz`、NSIS 安装包）生成 `.sig`；缺少 secret 时打包直接失败。`updater-manifest` job 用 `apps/desktop/scripts/updater-manifest.mjs` 把这些签名汇总成 `latest.json`（发布说明同样取自 CHANGELOG），随 Release 一起发布；已安装的应用通过 `releases/latest/download/latest.json` 获取更新，因此 prerelease 不会推送给用户。对应的公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey` 中。私钥一旦丢失，已安装的版本将无法再校验新版本，只能让用户手动重装；轮换密钥时，要先用旧私钥签名发布一个内置新公钥的版本，之后的版本再改用新私钥签名。同一个 job 还用 `apps/mobile/scripts/android-update-manifest.mjs` 生成 `latest-android.json`（版本、发布说明、APK 下载地址、大小与 SHA-256 / MD5），供 Android App 通过 `releases/latest/download/latest-android.json` 检查更新。

**Android 签名**：Android 的 `versionCode` 由版本号推导而来（`主版本 × 1000000 + 次版本 × 1000 + 修订号`，prerelease 与正式版相同），APK 用 Pier 的发布密钥签名（PKCS12，别名 `pier`，证书 SHA-256 为 `00:78:F4:4A:DA:16:1B:2F:A4:4B:5B:DF:B9:71:82:AA:CE:34:C9:EC:9D:4E:57:36:2D:9A:62:C1:68:C2:98:1D`）。签名配置由 `apps/mobile/plugins/withAndroidRelease.js` 在 `expo prebuild` 时写入 Gradle 工程。keystore 以 base64 形式保存在仓库 secret `ANDROID_RELEASE_KEYSTORE` 中，密码保存在 `ANDROID_RELEASE_KEYSTORE_PASSWORD` 中（密钥密码与之相同）；缺少 secret 时打包直接失败，签名证书与上面的指纹不一致时也会失败。keystore 一旦丢失，已安装的 App 无法覆盖升级，只能让用户卸载后重装，因此除 secret 外务必另外离线备份。本地打正式包时，可以在 `~/.gradle/gradle.properties` 中设置 `pierUploadStoreFile`、`pierUploadStorePassword`、`pierUploadKeyAlias`、`pierUploadKeyPassword`；未设置时，release 构建回退为使用 debug 签名。
