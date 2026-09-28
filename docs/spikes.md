# M0 技术验证（Spikes）

> 记录日期：2026-09-28。环境：Ubuntu x86_64，Node 24.21，Bun 1.4.2，pi SDK `@earendil-works/pi-coding-agent` 0.87.1。

## 结论速览

| Spike | 状态 | 结论 |
|---|---|---|
| 1. Host 打包为 sidecar | ✅ Linux 端到端验证；五个平台的原生冒烟测试已随 v0.0.1 通过 | 采用 **`bun build --compile` 单文件 + pi 资源目录** |
| 2. Tauri `externalBin` 启动 sidecar | ⏳ 未开始（随 M2 桌面骨架进行） | Host 侧接口已就绪（见下） |
| 3. Expo 中 WebSocket + `@noble/*` 性能 | ⏳ 未开始（需 Expo 开发构建与 iOS / Android 真机） | 放到 M3 开工前完成 |

## Spike 1：Host 打包为 sidecar

### 做法

`pnpm build:sidecar [--target <bun-target>]`（`packages/host/scripts/build-sidecar.mjs`）：

1. `bun build --compile --no-compile-autoload-bunfig src/main.ts` 生成单文件可执行程序；
2. 按 pi 自身 `build:binary` 的布局，把 SDK 运行时需要的资源复制到可执行文件旁：`package.json`（pi 的版本号与 `piConfig`）、`theme/*.json`、`export-html/`、`assets/`、`docs/`、`examples/`、`photon_rs_bg.wasm`。

pi 在 Bun 二进制中通过 `dirname(process.execPath)` 查找这些资源；资源无法与可执行文件放在一起时（例如放进 app bundle 的 Resources），设置 `PI_PACKAGE_DIR` 指向资源目录即可。

### 验证结果

| 项目 | 结果 |
|---|---|
| 构建 | 原生 < 1 s；交叉编译 `bun-darwin-arm64`（Mach-O arm64，73 MB）、`bun-windows-x64`（PE32+，97 MB）各约 2.5 s；Linux x64 二进制 92 MB，连同资源 96 MB |
| `~/.pi/agent` 配置 | 默认模型、`auth.json` 凭据、`models.json`、7 个可用模型均与 Node 一致 |
| 扩展 | 与 Node 完全一致：3 个本地 `.ts` 扩展（运行时经 jiti 转译）+ 2 个 npm 包扩展（`pi-web-access`、`pi-subagents`），0 个加载错误 |
| Skills / 上下文文件 | 6 个 skills、全局 `AGENTS.md` 均加载 |
| 端到端 | 用编译后的二进制完成：真实模型 prompt、流式输出、`bash` 工具调用触发审批并放行、断线重连后按 seq 恢复、`--watch-stdin` 优雅退出（清理锁文件与 `run/host.json`） |
| 启动耗时（构建 runtime 到可用） | Bun 二进制热启动约 0.5 s（首次冷启动 4.6 s）；Node + tsx 约 1.0 s |

诊断脚本：`packages/host/spikes/sidecar-check.ts` 通过 Pier 的 pi 适配层创建内存会话，并输出已加载的扩展、skills、上下文文件、工具与模型。它可以直接用 tsx 运行，也可以用 `bun build --compile` 编译后运行，对比两种运行时的结果。

### 发现的问题与处理

1. **缺少 pi 资源时版本号为 `0.0.0`，且主题初始化失败。** 有扩展在 `session_start` 时访问 `ctx.ui.theme`，会导致会话创建失败。处理：构建脚本复制资源；UI 桥接在主题不可用时回退为无样式主题（样式函数原样返回文本），不会再抛错。
2. **图片缩放 worker 未嵌入二进制。** pi 会自动回退为进程内缩放（需要 `photon_rs_bg.wasm`，已复制）。M4 做图片输入时再评估是否把 worker 作为额外入口编入。
3. **偶发一次退出卡住，未能复现。** 该次日志已打印 "shutting down"，但进程未退出，且 `unref()` 的 10 s 强制退出定时器也未触发。随后在空闲、运行中断开、prompt 完成后等场景各复现数次，均正常退出（约 30 ms）。已加固：强制退出定时器不再 `unref`；每个会话的 dispose 限时 5 s（防止扩展的 `session_shutdown` 挂住）；退出各步骤写入 stderr，便于再次出现时定位。

### 决定

- 桌面端 sidecar 采用 Bun 单文件二进制，pi 资源作为同目录文件（或 Tauri resources + `PI_PACKAGE_DIR`）一起分发。
- 备选方案（内置 Node 运行时 + JS bundle，或 Node SEA）暂不需要；若 M2 在 macOS / Windows 真机上验证失败，再启用备选。
- v0.0.1 发版时，在 GitHub Actions 原生 runner（linux-x64、linux-arm64、darwin-arm64、darwin-x64、windows-x64）上用 `scripts/smoke-sidecar.mjs` 验证了编译产物：启动、`pier.ready`、协议握手、通过二进制内的 pi SDK 创建会话、stdin 关闭后优雅退出。
- 待在 M2 / M6 验证：macOS / Windows 上配合真实 `~/.pi/agent` 与真实模型运行；Bun 二进制在 macOS 上的签名与公证；带原生依赖的扩展。

## Spike 2：Tauri 启动 sidecar（待做）

Host 侧已提供的接口：

- 启动后向 stdout 输出**唯一一行** JSON：`{"type":"pier.ready","url":"ws://127.0.0.1:<port>","port":…,"token":"…","pid":…,"version":"…","protocolVersion":"1.0"}`。日志只写 stderr。
- `--port 0`（默认）自动选择空闲端口；`PIER_LOCAL_TOKEN` 可由 Rust 侧注入，否则每次启动随机生成。
- `--watch-stdin`：stdin 关闭即退出，Tauri 进程意外退出时 sidecar 不会残留。
- 默认允许的 WebSocket Origin：`tauri://localhost`、`http(s)://tauri.localhost`、`http://localhost:1420`；可用 `--origin` 追加。
- Tauri `externalBin` 要求文件名带目标三元组后缀（如 `pier-host-aarch64-apple-darwin`），可通过 `build:sidecar --name pier-host-<triple> --target <bun-target>` 生成。

待验证：`tauri-plugin-shell` 的 sidecar 启动与 stdout 读取、崩溃自动重启、资源目录与 `PI_PACKAGE_DIR` 的传递、关闭窗口后 Host 继续运行。

## Spike 3：Expo 加密性能（待做）

计划：在 Expo 开发构建中测量 `@noble/curves`（X25519）与 `@noble/ciphers`（ChaCha20-Poly1305）的握手耗时，以及 1 KB / 64 KB / 1 MB 帧的加解密吞吐；同时验证 React Native WebSocket 与 `@pier/client` 的兼容性（该客户端只依赖 WHATWG WebSocket API，并支持注入 `createWebSocket`）。iOS 与 Android 各一台真机。
