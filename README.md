# Pier

Pi-powered agent desktop app with a native mobile companion that connects to your desktop.

- 桌面端：Tauri 2，内置以 [pi](https://github.com/earendil-works/pi) SDK 为核心的 Pier Host
- 手机端：Expo / React Native 原生 App，通过配对后的加密连接驱动桌面 Agent

开发计划见 [docs/PLAN.md](docs/PLAN.md)，协议见 [docs/protocol.md](docs/protocol.md)，技术验证结论见 [docs/spikes.md](docs/spikes.md)。

## 当前状态

M0（除 Spike 3）、M1（Host 核心）与 M2（桌面端 MVP）已完成：

| 包 | 说明 |
|---|---|
| `packages/protocol` | 协议 schema（zod）、类型、`PROTOCOL_VERSION` |
| `packages/host` | Pier Host：工作区配置、会话池、pi SDK 适配层、UI 桥接、`pier-approval` 审批扩展、EventLog、本地 WebSocket Gateway、sidecar 入口 |
| `packages/client` | 通用客户端（握手、请求关联、自动重连、按 seq 恢复）与调试 CLI `pier-cli` |
| `packages/chat-state` | 快照 + 事件 → 聊天视图状态的纯逻辑 reducer（桌面端与手机端共用） |
| `apps/desktop` | Tauri 2 桌面应用：管理 Host sidecar（启动、崩溃重启、日志）、托盘常驻、单实例；React 界面含工作区与会话管理、流式聊天、工具卡片（终端输出、diff、文件预览）、审批、模型与思考等级切换、压缩、分叉 |

## 开发

需要 Node 22+（推荐 24）和 pnpm（`corepack enable`）；构建 sidecar 还需要 Bun。

```bash
pnpm install
pnpm lint        # Biome
pnpm typecheck   # tsc -b（项目引用）
pnpm test        # Vitest：单元测试 + 基于 faux 模型的端到端测试
```

Host 复用 pi 的配置（`~/.pi/agent`：模型、凭据、settings、会话目录），请先用 `pi` 完成登录或配置模型。

```bash
# 终端 1：启动 Host（监听 127.0.0.1 的随机端口，并写入 ~/.pier/run/host.json）
pnpm host

# 终端 2：调试客户端（自动读取 ~/.pier/run/host.json）
pnpm pier-cli
> /ws add /path/to/project
> /new
> 列出当前目录的文件
> /allow            # 响应审批请求；/deny <理由>、/allow session
> /drop             # 模拟断线，验证重连补发
> /help
```

### 桌面端

除 Node 与 pnpm 外还需要 Rust（stable）、Bun，以及 Tauri 的[系统依赖](https://v2.tauri.app/start/prerequisites/)（Linux 上为 `libwebkit2gtk-4.1-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等）。

```bash
pnpm desktop                                  # 构建 sidecar，然后 tauri dev（热更新前端）
pnpm --filter @pier/desktop build             # 打包安装包（deb / AppImage / dmg / NSIS，取决于平台）
```

桌面端启动时会拉起内置的 Pier Host（`--watch-stdin`），关闭窗口只会隐藏到托盘，Agent 继续运行；从托盘或界面左下角“退出”才会停止 Host。可用 `PIER_DIR` 隔离 Pier 状态目录，用 `PIER_HOST_BIN` 指定其他 Host 可执行文件。

只调界面时可以不启动 Tauri：用假模型（faux）起一个 Host，再在浏览器里打开 Vite 开发服务器：

```bash
pnpm faux-host                                # 输出 url 与 token，状态放在临时目录
pnpm --filter @pier/desktop dev:web           # http://localhost:1420/?url=<url>&token=<token>
```

发送包含“演示”的消息会运行一段脚本化任务（bash、write、edit 与一次需要审批的命令）。

### Sidecar

构建单文件 sidecar（输出到 `packages/host/bin/`，包含 pi 运行时资源）：

```bash
pnpm build:sidecar                          # 当前平台
pnpm build:sidecar --target bun-darwin-arm64 # 交叉编译
packages/host/bin/pier-host --help
```

Pier 自身状态保存在 `~/.pier`（可用 `PIER_DIR` 覆盖）：`config.json`（工作区与审批策略）、`run/host.json`（运行中 Host 的端口与本地 token，权限 0600）、`locks/`（会话文件锁）。

## 发版

版本号统一由根 `package.json` 与各包的 `version` 决定（`packages/host/test/version.test.ts` 会校验它们与 `PIER_HOST_VERSION`、`pier-cli` 版本及 `CHANGELOG.md` 一致）。

1. 更新所有版本号，并在 `CHANGELOG.md` 中新增 `## v<版本>` 小节；合并到 `main`。
2. 在 `main` 的该提交上打 tag 并推送：`git tag -a v<版本> -m "Pier v<版本>" && git push origin v<版本>`。
3. `.github/workflows/release.yml` 会校验 tag、版本号以及该提交是否在 `main` 上，然后运行完整检查；接着在各平台原生 runner 上构建并冒烟测试 sidecar（`packages/host/scripts/smoke-sidecar.mjs`），同时在各平台 runner 上用 `tauri build` 打包桌面端安装包（deb / AppImage / dmg / NSIS，未签名），最后创建 GitHub Release，附带 sidecar 压缩包、桌面端安装包和 `SHA256SUMS.txt`，发布说明取自 CHANGELOG。版本号带 `-` 后缀（如 `0.1.0-rc.1`）时标记为 prerelease。

打 tag 之前可以先在 `main` 上手动触发一次试运行：`gh workflow run release.yml --ref main`。它会构建并冒烟测试全部产物（上传为 workflow artifacts），但跳过 tag 校验和发布。
