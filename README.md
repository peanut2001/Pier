# Pier

Pi-powered agent desktop app with a native mobile companion that connects to your desktop.

- 桌面端：Tauri 2，内置以 [pi](https://github.com/earendil-works/pi) SDK 为核心的 Pier Host
- 手机端：Expo / React Native 原生 App，通过配对后的加密连接驱动桌面 Agent

开发计划见 [docs/PLAN.md](docs/PLAN.md)，协议见 [docs/protocol.md](docs/protocol.md)，技术验证结论见 [docs/spikes.md](docs/spikes.md)。

## 当前状态

M0（脚手架、CI、Spike 1）与 M1（Host 核心）已完成：

| 包 | 说明 |
|---|---|
| `packages/protocol` | 协议 schema（zod）、类型、`PROTOCOL_VERSION` |
| `packages/host` | Pier Host：工作区配置、会话池、pi SDK 适配层、UI 桥接、`pier-approval` 审批扩展、EventLog、本地 WebSocket Gateway、sidecar 入口 |
| `packages/client` | 通用客户端（握手、请求关联、自动重连、按 seq 恢复）与调试 CLI `pier-cli` |

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

构建单文件 sidecar（输出到 `packages/host/bin/`，包含 pi 运行时资源）：

```bash
pnpm build:sidecar                          # 当前平台
pnpm build:sidecar --target bun-darwin-arm64 # 交叉编译
packages/host/bin/pier-host --help
```

Pier 自身状态保存在 `~/.pier`（可用 `PIER_DIR` 覆盖）：`config.json`（工作区与审批策略）、`run/host.json`（运行中 Host 的端口与本地 token，权限 0600）、`locks/`（会话文件锁）。
