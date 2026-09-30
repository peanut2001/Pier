# Pier 协议 v1.23

> 实现：`packages/protocol`（zod schema + TS 类型，Host 与所有客户端共享）。
> 本文档描述线上格式与语义；字段的权威定义以 `packages/protocol/src` 为准。

## 1. 传输与帧

- 传输：WebSocket，**文本帧**，每帧一个 JSON 对象。二进制帧会被拒绝（关闭码 1003）。
- 本地连接：Host 仅监听 `127.0.0.1`，帧为明文。
- 远程连接（开启远程访问后，默认端口 7433）：先完成 Noise 握手（配对用 XX，之后用 IK），之后每一帧都是加密帧 `{ "t": "enc", "n": <nonce>, "c": <ciphertext> }`，其明文即本文档的帧。握手、配对与吊销见 [`docs/security.md`](security.md)。
- 帧类型：

```jsonc
// 客户端 → Host：请求
{ "type": "req", "id": "r1", "method": "session.prompt", "params": { "sessionId": "…", "text": "…" } }

// Host → 客户端：响应（与请求 id 对应；同一连接上的响应可能乱序到达）
{ "type": "res", "id": "r1", "ok": true, "result": { "accepted": true } }
{ "type": "res", "id": "r1", "ok": false, "error": { "code": "NOT_FOUND", "message": "…", "data": … } }

// Host → 客户端：事件
{ "type": "evt", "sessionId": "…", "seq": 42, "event": { "type": "message_update", … } }
{ "type": "evt", "event": { "type": "host.notice", … } }   // Host 级事件：无 sessionId / seq
```

- `id`：1–128 字符，由客户端生成，仅在本连接内唯一即可。
- 无法解析的帧返回 `id: ""` 的 `BAD_REQUEST` 响应。

### 错误码

| code | 含义 |
|---|---|
| `BAD_REQUEST` | 帧或参数校验失败（`data` 为 zod issues） |
| `UNAUTHENTICATED` | 尚未完成 `host.hello`，或 token 错误（Host 随后关闭连接，关闭码 4401） |
| `FORBIDDEN` | 已认证但无权调用（例如远程设备调用仅限本地的方法） |
| `NOT_FOUND` | 工作区 / 会话 / 模型不存在，或会话未在活跃池中 |
| `CONFLICT` | 目标状态不允许（会话运行中、会话文件被外部修改、被其他 Host 锁定等） |
| `PROTOCOL_MISMATCH` | 主版本不一致；`data.hostVersion` 为 Host 的版本 |
| `UNSUPPORTED` | 协议已定义但此 Host 尚未实现 |
| `TIMEOUT` | 客户端本地超时（Host 不会返回此码） |
| `INTERNAL` | 未预期的 Host 错误 |

### 关闭码

| 关闭码 | 含义 | 客户端应 |
|---|---|---|
| 1003 | 收到二进制帧 | 修复客户端 |
| 1013 | 发送缓冲超过 16 MiB（客户端跟不上） | 重连并按 seq 恢复 |
| 4400 | 远程：握手失败、配对失败，或收到无法解密的帧 | 按错误提示处理 |
| 4401 | `host.hello` 失败或超时 | 不要自动重试（token / 版本错误） |
| 4403 | 远程：设备未登记或已被吊销（握手时的 `error` 帧 code 为 `UNKNOWN_DEVICE`） | 停止重连，提示重新配对（`@pier/client` 默认把它视为终止） |
| 4410 | 远程：桌面关闭了远程访问 | 稍后重连 |
| 4404 | 本地 `/peer/<id>`：该电脑未配对（或已在本机移除）；`host.hello` 同时返回 `NOT_FOUND` | 不要重连 |
| 4502 | 本地 `/peer/<id>`：连不上那台电脑，或与它的连接中断（原因写在 reason 中） | 稍后重连 |

## 2. 握手与版本

连接后第一个请求必须是 `host.hello`；在其成功前，其他请求返回 `UNAUTHENTICATED`。10 秒内未完成握手的连接会被关闭。握手完成前 Host 按顺序处理帧，因此客户端可以在 `host.hello` 之后立即流水线发送请求。

```jsonc
{ "type": "req", "id": "h", "method": "host.hello", "params": {
  "protocolVersion": "1.23",
  "client": { "name": "pier-desktop", "version": "0.1.0", "platform": "darwin" },
  "token": "<本地 token>",       // 本地连接必填；远程连接由加密通道认证，不需要
  "coalesceMs": 50               // 可选：合并流式增量的窗口（0–1000ms，默认 0）
}}
// → { protocolVersion, host: HostInfo, connectionId, device?: { id, name } }   // device 仅远程连接
```

- 版本号为 `<major>.<minor>`，`PROTOCOL_VERSION` 由 `@pier/protocol` 导出。主版本不同 → `PROTOCOL_MISMATCH`；次版本只做向后兼容的新增（新方法、新可选参数、新事件），客户端必须忽略未知事件类型和未知字段。
- **本地 token**：Host 启动时生成（或取 `PIER_LOCAL_TOKEN`），通过 stdout 的 `pier.ready` 行交给 Tauri，并写入 `~/.pier/run/host.json`（0600）供本地调试工具使用。浏览器 WebSocket 无法设置请求头，所以 token 放在 `host.hello` 中而不是 URL 里（避免进入日志）。
- **远程连接**：握手已经认证了设备，`host.hello` 只再确认设备仍已登记；设备已被吊销时返回 `UNAUTHENTICATED`。远程连接收不到仅限本地的 Host 事件（§4.3）。
- **Origin 校验（本地连接）**：带 `Origin` 头的连接只允许 Tauri WebView 的来源（`tauri://localhost`、`http(s)://tauri.localhost`、开发时的 `http://localhost:1420`），其他网页在握手阶段即被拒绝（HTTP 403）。无 `Origin` 的连接（CLI）允许，但仍须 token。远程监听不检查 Origin（React Native 在 Android 上会自动附带），认证完全由加密通道完成。

## 3. 方法

参数中的 `sessionId` 均为 pi 会话 ID。标注 🔒 的方法仅本地桌面连接可调用（`LOCAL_ONLY_METHODS`），它们决定谁能连接这台电脑：设备、配对、远程访问与 `peer.*`。其余方法对已配对的远程设备（手机和其他电脑）同样开放（1.10）：配对即完全信任，可以管理工作区与审批策略、编辑文件、配置服务商与模型、账号和扩展；1.9 及以前这些方法也仅限本地。

### host

| 方法 | 参数 | 结果 |
|---|---|---|
| `host.hello` | 见上 | `{ protocolVersion, host, connectionId }` |
| `host.info` | – | `HostInfo`（hostId、hostName、version、protocolVersion、platform、piVersion、agentDir） |
| `host.listDirectories` | `{ path?(绝对路径) }` | `HostDirectoryListing`：`{ path, parent?, home, separator, entries: { name, path, symlink? }[], truncated?, total? }`；列出 Host 上一个目录的子目录（含指向目录的符号链接），用于在其他电脑上选择工作区（1.10）。省略 `path` 时为用户主目录；`path` 不做 realpath，`parent` 在文件系统根目录时省略。按名称自然排序，最多 2000 项，超出时 `truncated: true` 并给出 `total`。相对路径或不是目录时 `BAD_REQUEST`，不存在时 `NOT_FOUND`，无权限时 `FORBIDDEN` |
| `host.stats` | – | `HostStats`：`{ sampledAt, platform, uptime(秒), cpu: { usage(0–1), cores, model?, loadAverage?[1/5/15 分钟] }, memory: { total, used }, disk?: { path, total, used, available }, network?: { rxRate, txRate, rxTotal, txTotal }, hostRss }`；Host 所在电脑的资源占用（1.12），大小单位为字节，速率为字节/秒。`cpu.usage` 与网络速率按与上一次采样的差值计算（上一次采样超过 10 秒时先取 0.4 秒的基线），1 秒内的重复调用共用一次采样。内存 `used` 不含可回收的缓存（Linux 为 `MemTotal - MemAvailable`，macOS 按 `vm_stat` 计算）；`disk` 为用户主目录所在的文件系统；`network` 统计物理网卡（Linux 上没有物理网卡时统计除回环外的全部网卡，macOS 为 `en*`，Windows 为 `netstat -e` 的总计），无法读取时省略；Windows 上没有 `loadAverage`；`hostRss` 为 Pier Host 进程的常驻内存。对已配对设备开放 |

### 应用更新（1.13）

Host 在桌面端中运行时（Tauri 以 `--watch-stdin` 启动 sidecar），通过 sidecar 的 stdio 驱动桌面端的更新器，让已配对的电脑和手机可以远程更新这台电脑上的 Pier。只会安装 GitHub 最新正式版中、用桌面端内置公钥校验过签名的更新包，更新地址不能由客户端指定。这些方法对已配对设备开放，远程调用 `update.install` 写入审计日志。

| 方法 | 参数 | 结果 |
|---|---|---|
| `update.status` | – | `AppUpdateStatus`：`{ state, currentVersion, autoCheck, version?, notes?, date?, downloaded, total?, error?, lastChecked?, installNeedsAuth? }`。`state` 为 `unsupported`（开发版本、未打包的构建、独立运行的 `pier-host`，或桌面端没有上报更新器）\|`idle`\|`checking`\|`upToDate`\|`available`\|`downloading`\|`installing`\|`error`；`version` / `notes` / `date` 为可安装的新版本（安装失败后仍保留，可重试）；`installNeedsAuth` 表示安装时需要有人在那台电脑上输入管理员密码（Linux `.deb` / `.rpm`） |
| `update.check` | – | `AppUpdateStatus`：立即检查一次（最长约 30 秒，客户端请放宽超时）。检查失败时返回 `state: "error"` 而不是错误响应 |
| `update.install` | – | `AppUpdateStatus`：还没有已知的新版本时先检查；有新版本时在后台开始下载，返回 `downloading`，之后 Host 与所有连接会随安装断开，桌面端安装完成后自动重启，客户端重连后在 `host.hello` 中看到新版本。已是最新版本时返回 `upToDate`，检查失败时返回 `error`，已在更新时返回当前状态。由远程设备发起时，Host 同时向本地连接发出 `host.notice`，告知谁在更新 |

没有可驱动的更新器时，`update.check` / `update.install` 返回 `UNSUPPORTED`，`update.status` 返回 `state: "unsupported"`；桌面端无法回答时返回 `INTERNAL`。更新器的每次状态变化（下载进度约每 200ms 一次）都以 `update.status` 事件发给所有连接。

sidecar 的 stdio 协议（每行一个 JSON 对象，stdout 上 `pier.ready` 之后）：Host 在 stdout 写 `{"type":"pier.shell.request","id","method":"update.check"|"update.install"}`，桌面端在 stdin 回 `{"type":"pier.shell.response","id","ok":true,"result":AppUpdateStatus}` 或 `{"type":"pier.shell.response","id","ok":false,"error"}`，并在 Host 就绪时和每次状态变化时推送 `{"type":"pier.shell.updateStatus","status":AppUpdateStatus}`（缺省字段为 `null`）。

### 终端（1.18）

Host 在桌面端中运行时，可以在它所在的电脑上用桌面端的伪终端启动用户的 shell（Unix 上为 `$SHELL` 登录 shell，Windows 上为 PowerShell），让已配对的电脑远程打开终端。桌面端在 Host 就绪时声明支持终端，此后 `HostInfo.terminals` 为 `true`；独立运行的 `pier-host`、旧版桌面端没有终端，`terminal.open` 返回 `UNSUPPORTED`。这些方法对已配对设备开放（配对即完全信任，远程终端与在那台电脑上登录等价），远程调用 `terminal.open` 写入审计日志（含目录，不记录输入内容）。

终端属于打开它的连接：输出和结束只发给这个连接，其他连接既看不到也不能操作（`NOT_FOUND`）；连接断开、Host 停止或桌面端退出时终端随之挂断，重连后不会恢复。每个连接最多 16 个、每个 Host 最多 64 个终端，超出时 `CONFLICT`。

| 方法 | 参数 | 结果 |
|---|---|---|
| `terminal.open` | `{ cwd?(绝对路径), cols, rows }` | `TerminalInfo`：`{ terminalId, shell, cwd }`。`cwd` 省略或不存在时从用户主目录启动；相对路径为 `BAD_REQUEST`，启动失败为 `INTERNAL`。`cols` / `rows` 为 2–1000。响应之前 shell 已经输出的内容在响应之后才以事件送达，所以客户端总是先拿到 `terminalId` |
| `terminal.write` | `{ terminalId, data, binary? }` | `{ written }`：写入输入（`data` 最长 1 MB，更长的粘贴请分段）。`binary` 表示每个字符是一个字节（xterm 的 `onBinary`）。终端已结束时 `written: false` 或 `NOT_FOUND` |
| `terminal.resize` | `{ terminalId, cols, rows }` | `{ resized }` |
| `terminal.close` | `{ terminalId }` | `{ closed }`：挂断 shell，随后收到 `terminal.exit` |

事件（§4.3）：`terminal.output` 带 `{ terminalId, data }`，`data` 为原始输出字节的 base64（UTF-8 字符可能跨两个事件）；`terminal.exit` 带 `{ terminalId, code, error? }`，之后不再有该终端的事件，`code` 为退出码（被信号结束或未知时为 `null`），`error` 表示终端丢失（例如桌面端退出）而不是程序结束。

输出有流量控制：某个连接待发送的数据超过约 2 MB 时（网络较慢），Host 让桌面端暂停读取该连接终端的输出（shell 写满伪终端缓冲区后阻塞），降到约 512 KB 以下再恢复，因此输出大量内容不会撑爆连接。

sidecar 的 stdio 协议：桌面端用 `--shell-terminals` 启动 Host，声明它能运行终端（这样在 Host 刚开始监听时就重连上来的电脑，`host.hello` 中也已经带有 `terminals`），并在 Host 就绪时再推送一次 `{"type":"pier.shell.capabilities","terminals":true}`。Host 用 `{"type":"pier.shell.request","id","method":"terminal.spawn","params":{"key","cwd"?,"cols","rows"}}` 启动 shell，桌面端回 `{"type":"pier.shell.response","id","ok":true,"result":{"id","shell","cwd"}}`；之后 Host 写 `{"type":"pier.shell.terminal","op":"write"|"resize"|"pause"|"resume"|"kill","id",…}`，桌面端推送 `{"type":"pier.shell.terminalOutput","key","data":"<base64>"}` 与最后一条 `{"type":"pier.shell.terminalExit","key","code"}`。`key` 由 Host 选定，所以在响应之前到达的输出也能对上终端；数字 `id` 用来发送输入。这些 shell 属于启动它们的那次 Host 运行，Host 停止、重启或崩溃时桌面端会把它们全部挂断。桌面窗口自己的内置终端与此无关，不经过 Host。

### workspace

| 方法 | 参数 | 结果 |
|---|---|---|
| `workspace.list` | – | `{ workspaces: WorkspaceInfo[] }` |
| `workspace.add` | `{ path(绝对路径), name?, policy? }` | `{ workspace }`；路径会取 realpath，重复添加返回已有项 |
| `workspace.remove` | `{ workspaceId }` | `{ removed }`；先强制关闭该工作区的活跃会话 |
| `workspace.setPolicy` | `{ workspaceId, policy: "ask"\|"smart"\|"auto" }` | `{ workspace }`；立即对活跃会话生效 |
| `workspace.files` | `{ workspaceId, path? }` | `WorkspaceFilesResult`：`{ path, entries: { name, path, kind: "file"\|"directory"\|"other", symlink?, size?, modifiedAt? }[], truncated?, total? }`；列出工作区中的一个目录（不递归）。`path` 为相对工作区根目录的路径（`/` 分隔，省略或 `""` 为根目录），绝对路径或含 `..` 时 `BAD_REQUEST`，目录（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，不存在时 `NOT_FOUND`。目录在前、再按名称自然排序，不列出 `.git`、`.hg`、`.svn`；每个目录最多返回 2000 项，超出时 `truncated: true` 并给出 `total`。指向工作区外目录的符号链接和失效链接为 `other`（1.5） |
| `workspace.readFile` | `{ workspaceId, path }` | `WorkspaceFileContent`：`{ path, size, modifiedAt, kind: "text"\|"image"\|"binary", text?, truncated?, data?, mimeType?, tooLarge? }`；读取工作区中的一个文件用于预览。`path` 的规则与 `workspace.files` 相同；文件（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，不存在时 `NOT_FOUND`，是目录或特殊文件时 `BAD_REQUEST`。`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp`/`.ico`/`.avif`/`.svg` 为 `image`，`data` 为 Base64（不含 `data:` 前缀），超过 8 MiB 时不返回 `data` 并设 `tooLarge: true`。其他文件按 UTF-8 解码为 `text`，最多返回前 512 KiB（超出时 `truncated: true`，被截断的多字节字符会被丢弃）；包含 NUL 字节或不是合法 UTF-8 的文件为 `binary`，不返回内容（1.7） |
| `workspace.writeFile` | `{ workspaceId, path, text, expectedModifiedAt? }` | `{ path, size, modifiedAt }`；用 UTF-8 文本覆盖工作区中一个已存在的文件（不会新建文件），`path` 与位置的规则同 `workspace.readFile`。文件原地写入，保留权限、属主和硬链接；原文件以 UTF-8 BOM 开头时（`workspace.readFile` 返回的 `text` 不含 BOM）会保留 BOM。`text` 最多 4 MiB（按 UTF-8 字节计）。给出 `expectedModifiedAt`（客户端读取时的 `modifiedAt`）且文件此后被修改过时不写入，返回 `CONFLICT`，`data.modifiedAt` 为磁盘上的当前修改时间；无写权限或只读文件系统时 `FORBIDDEN`（1.8） |
| `workspace.deletePath` | `{ workspaceId, path }` | `{ path, kind: "file"\|"directory"\|"other" }`；永久删除工作区中的一个文件、目录（连同其中所有内容）或符号链接，不进入废纸篓 / 回收站。`path` 的规则同 `workspace.files`，省略或指向工作区根目录（`""`、`.`）时 `BAD_REQUEST`；所在目录（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，不存在时 `NOT_FOUND`，无权限或只读文件系统时 `FORBIDDEN`。条目本身不跟随符号链接：删除符号链接只删除链接，不影响它指向的内容，`kind` 为 `other`。远程调用写入审计日志（1.11） |
| `workspace.readBytes` | `{ workspaceId, path, offset, length }` | `WorkspaceFileBytes = { path, size, modifiedAt, offset, data, eof }`；读取工作区中一个文件从 `offset` 开始的最多 `length`（1 B–4 MiB）个字节，`data` 为 Base64，用于分块下载任意文件（含二进制）。`path` 与位置的规则同 `workspace.readFile`。`size` / `modifiedAt` 是读取时文件的当前状态，客户端可据此发现文件在两块之间被修改；`eof` 表示 `data` 已到文件末尾，`offset` 超出文件大小时 `data` 为空、`eof: true`。只读，不写审计日志（1.21） |
| `workspace.uploadStart` | `{ workspaceId, path, size, overwrite? }` | `WorkspaceUploadStart = { uploadId, path, chunkBytes }`；开始把一个 `size` 字节的文件上传到工作区中的 `path`（1.21）。`path` 的规则同 `workspace.files`；缺少的上级目录会被创建，已有的上级目录（跟随符号链接后）位于工作区之外时 `FORBIDDEN`，是文件时 `BAD_REQUEST`。目标已是目录时 `CONFLICT`（`data.kind: "directory"`）；目标已是文件（或符号链接）且未给 `overwrite: true` 时 `CONFLICT`（`data.kind: "file"`）。数据先写入目标目录中的隐藏临时文件 `.<名称>.<id>.pier-upload`，完成后才替换为真实名称。`chunkBytes` 是一次 `uploadChunk` 最多接受的字节数（4 MiB），文件最大 16 GiB。每个连接最多同时 8 个上传；上传属于发起它的连接，该连接断开或 5 分钟未收到数据时自动取消并删除临时文件。远程调用写入审计日志 |
| `workspace.uploadChunk` | `{ uploadId, offset, data }` | `{ received }`；向上传追加 Base64 数据（1.21）。`offset` 必须等于已收到的字节数，否则 `CONFLICT`（`data.received` 为已收到的字节数，可据此续传）；超过 `chunkBytes` 或累计超过 `size` 时 `BAD_REQUEST`；上传不存在、已过期或属于其他连接时 `NOT_FOUND`；同一上传同时只处理一个请求 |
| `workspace.uploadFinish` | `{ uploadId }` | `{ path, size, modifiedAt }`；把收齐的上传移动到目标路径（1.21）。未收齐时 `BAD_REQUEST`（`data.received`），上传保留可继续；目标在上传期间变成目录，或未给 `overwrite` 而目标已出现时 `CONFLICT`，上传被丢弃。远程调用写入审计日志 |
| `workspace.uploadCancel` | `{ uploadId }` | `{ cancelled }`；取消上传并删除已收到的数据（1.21）。上传不存在或属于其他连接时 `cancelled: false` |

### Agent 运行时（1.22）

一个 Host 可以运行多种 Agent：内置的 **pi**（`pi`），以及这台电脑上安装的 **Claude Code**（`claude-code`，通过 Claude Agent SDK 驱动用户自己的 `claude` CLI 与登录）和 **Codex**（`codex`，通过 `codex app-server` 驱动用户自己的 `codex` CLI 与登录）。以后可以接入更多运行时。不同运行时的会话在同一个工作区中并存，事件、快照、审批与断线恢复都使用同一套协议：非 pi 运行时把自己的输出转换成 pi 形态的消息与事件（见 §4.1），常用工具映射到 pi 的工具名与参数（Claude Code 的 `Bash` / `Read` / `Write` / `Edit` / `Grep` / `Glob` 分别为 `bash` / `read` / `write` / `edit` / `grep` / `find`；Codex 的命令执行为 `bash`、文件修改为 `edit` 或 `write` 并带 diff），客户端无需区分。

| 方法 | 参数 | 结果 |
|---|---|---|
| `runtime.list` | `{}` | `{ runtimes: AgentRuntimeInfo[] }`；`AgentRuntimeInfo = { id, name, available, reason?, version?, executable?, capabilities }`。`available` 表示能新建会话（CLI 已安装；登录状态在使用时才检查），不可用时 `reason` 说明原因。CLI 的位置可以用环境变量 `PIER_CLAUDE_PATH` / `PIER_CODEX_PATH` 指定，否则在 `PATH` 与常见安装目录中查找 |

`capabilities: AgentRuntimeCapabilities = { steer, followUp, compact, fork, rename, setModel, thinking, reload, images, piExtensions }`：客户端据此隐藏会失败的操作。不支持的方法返回 `UNSUPPORTED`（例如 Claude Code / Codex 会话的 `session.reload`）。`piExtensions` 为 `false` 的运行时不加载 pi 的扩展、技能、提示词模板与 `settings.json`，扩展或设置变更后 Host 也不会重新加载这些会话。

各运行时的差异：

- **模型**：`model.list` 按会话（或 `runtime` 参数）的运行时列出模型，`ModelInfo.provider` 为 `claude-code` / `codex`。Claude Code 的模型与斜杠命令来自 CLI（Host 启动一次不发送消息的 CLI 读取，缓存 10 分钟）；Codex 的来自 `model/list`。`model.set` 只接受本运行时的模型，`persist` 被忽略。思考等级对应 Claude Code 的 effort（`off` 关闭思考）与 Codex 的 reasoning effort。
- **审批**：工作区策略同样适用。Claude Code 自己放行的调用（如只读工具、设置中允许的命令）不再询问；它请求许可时，受策略约束的工具（`bash`、`write`、`edit`）按策略决定，其他工具（`WebFetch`、MCP 工具等）在非 `auto` 策略下询问用户；`AskUserQuestion` 以 `select` 请求逐个提问。Codex 按策略设置审批与沙箱：`ask` → `untrusted` + `workspace-write`，`smart` → `on-request` + `workspace-write`，`auto` → `never` + `danger-full-access`；它请求执行命令、修改文件或更多权限时，按策略决定或询问用户（"本会话内允许"对应 Codex 的 `acceptForSession`）。
- **会话存储**：Claude Code 会话在 `~/.claude/projects`（或 `CLAUDE_CONFIG_DIR`），Codex 会话由 Codex 管理（`~/.codex/sessions`）。`session.list` 列出 cwd 与工作区路径相同的会话，包括在终端中创建的，都可以在 Pier 中继续。`session.delete` 对 Claude Code 会话同样移到 Pier 回收站；对 Codex 会话调用 Codex 的归档（`thread/archive`，可在 Codex 中恢复）。`messageCount` 为估算值。
- **排队**：Claude Code 的 steer / followUp 直接交给 CLI 的消息队列；Codex 的 steer 并入当前回合（`turn/steer`），followUp 由 Host 排队，在当前回合结束后依次发送。
- **压缩**：Claude Code 发送 `/compact`，Codex 调用 `thread/compact/start`；两者的 `summary` 为空字符串。
- **分叉**：Claude Code 用 SDK 的 `forkSession`，Codex 用 `thread/fork`（`position: "at"` 时包含该用户消息所在的整个回合）。
- **进程**：Claude Code 会话在首次发送消息时启动 CLI，空闲 10 分钟后停止（之后自动恢复会话）；所有 Codex 会话共用一个 `codex app-server` 进程，没有打开的 Codex 会话 5 分钟后停止。

### session

| 方法 | 参数 | 结果 |
|---|---|---|
| `session.list` | `{ workspaceId }` | `{ sessions: SessionSummary[] }`，按修改时间倒序，包含所有可用运行时的会话（1.22 起每项带 `runtime`）；活跃会话 `active: true` 并带实时 `state` 与 `pendingUi`（待回答的对话框 / 审批数，1.1）；已归档的会话带 `archived: true`（1.14），未归档时省略该字段 |
| `session.create` | `{ workspaceId, name?, runtime? }` | `{ session }`（已进入活跃池）；`runtime`（1.22）选择 Agent 运行时，默认 `pi`；未知运行时 → `NOT_FOUND`，不可用（CLI 未安装）→ `CONFLICT` |
| `session.open` | `{ workspaceId, sessionId }` 或 `{ workspaceId, path }` | `{ session }`；`path` 必须出现在该工作区的会话列表中 |
| `session.close` | `{ sessionId, force? }` | `{ closed }`；运行中且未 `force` → `CONFLICT` |
| `session.delete` | `{ workspaceId, sessionId, force? }` | `{ deleted }`；关闭会话（`session.closed { reason: "deleted" }`）并把会话文件移到 `~/.pier/trash/sessions/<时间戳>-<文件名>`（可手动移回恢复）。活跃会话属于其他工作区 → `NOT_FOUND`；工作区中没有该会话 → `{ deleted: false }`；运行中且未 `force`，或会话正被其他 Pier Host 打开 → `CONFLICT`。从未写入磁盘的新会话只会被关闭；分叉出的子会话不受影响（1.6） |
| `session.archive` | `{ workspaceId, sessionId, archived }` | `{ session }`；归档（`archived: true`）或取消归档会话（1.14）。归档只是 Host 记录在 `~/.pier/archived-sessions.json` 中的标记，不修改会话文件，也不关闭会话，归档后的会话照常可以打开和继续对话；分叉出的新会话不继承归档状态，`session.delete` 会同时清除标记。会话既不在活跃池中也不在该工作区的会话列表中 → `NOT_FOUND`（属于其他工作区的活跃会话同样）。成功后广播 `session.listChanged` |
| `session.cleanup` | `{ workspaceId, action: "archive"\|"delete", modifiedBefore?, scope?: "all"\|"archived"\|"unarchived", dryRun? }` | `{ sessionIds, skipped: { sessionId, reason: "running"\|"locked"\|"error", message? }[] }`；批量归档或删除工作区中的会话（1.14）。选中 `modifiedAt` 早于 `modifiedBefore`（带时区的 ISO 8601 时间，省略时不限时间）且符合 `scope`（默认 `all`）的会话；`archive` 时已归档的会话不计入。`delete` 与 `session.delete` 相同（移到 `~/.pier/trash/sessions`），但运行中或有待回答请求的会话一律跳过（`running`），被其他 Pier Host 打开的会话跳过（`locked`）；`archive` 不跳过运行中的会话。`sessionIds` 为已处理的会话，`dryRun: true` 时只返回将要处理和将被跳过的会话而不做修改（`locked` 只有实际执行时才能发现）。有会话被处理时广播 `session.listChanged` |
| `session.forkPoints` | `{ sessionId }` | `{ points: { entryId, text }[] }`（可 fork 的用户消息） |
| `session.fork` | `{ sessionId, entryId, position?: "before"\|"at" }` | `{ session, selectedText? }`；生成**新**会话，原会话不变 |
| `session.rename` | `{ sessionId, name }` | `{ session }` |
| `session.subscribe` | `{ sessionId, sinceSeq?, epoch? }` | `{ mode: "replay"\|"snapshot", currentSeq, epoch }`，见 §5 |
| `session.unsubscribe` | `{ sessionId }` | `{ unsubscribed }` |
| `session.snapshot` | `{ sessionId }` | `SessionSnapshot`（一次性读取，不影响订阅） |
| `session.commands` | `{ sessionId }` | `{ commands: { name, description?, argumentHint?, source: "extension"\|"prompt"\|"skill" }[] }`；会话的 Agent 运行时在 `session.prompt` 中处理的斜杠命令：扩展命令、提示词模板和 `skill:<名称>`（pi 设置 `enableSkillCommands: false` 时不列出 skill，但手动输入仍然有效）。`name` 不含开头的 `/`（1.5） |
| `session.reload` | `{ sessionId }` | `{ reloaded: true }`；重新加载 settings、扩展、skills、提示词模板、主题与上下文文件，相当于 pi 的 `/reload`。Agent 运行中或有待回答的对话框时 → `CONFLICT`（1.5） |

### 运行

| 方法 | 参数 | 结果 |
|---|---|---|
| `session.prompt` | `{ sessionId, text, images?, streamingBehavior? }` | `{ accepted: true }`，在 pi 接受 prompt 后立即返回，输出通过事件流给出。会话运行中且未指定 `streamingBehavior` → `CONFLICT` |
| `session.steer` | `{ sessionId, text, images? }` | `{ queue }` |
| `session.followUp` | `{ sessionId, text, images? }` | `{ queue }` |
| `session.abort` | `{ sessionId }` | `{ aborted: true }`，在会话回到空闲后返回 |
| `session.compact` | `{ sessionId, instructions? }` | `{ summary, tokensBefore }`，压缩完成后返回（可能较慢，客户端应放宽超时） |

`images`：`{ type: "image", data: <base64>, mimeType: "image/…" }[]`，最多 16 张；单帧上限 64 MiB。

#### 斜杠命令

`session.prompt` 的文本以 `/` 开头时，由 pi 按以下顺序处理：扩展命令（立即执行，运行中也可以，不会进入对话）→ `/skill:<名称> [参数]`（展开为 skill 内容）→ `/<模板> [参数]`（展开为提示词模板）→ 其余原样作为普通消息发给模型。可用的命令用 `session.commands` 列出。扩展命令被识别后 `session.prompt` 立即返回 `{ accepted: true }`，不等待命令结束（命令可能在等待 `ui.request` 的回答）；命令的错误以 `extension.error` 事件给出。

`session.steer` / `session.followUp` 会展开 skill 与模板，但不执行扩展命令；运行中发送命令请用带 `streamingBehavior` 的 `session.prompt`。

pi 终端界面自带的命令（`/model`、`/compact`、`/new`、`/fork`、`/name`、`/reload` 等）不经过 `session.prompt`：Pier 客户端在本地识别它们，改为调用对应的协议方法（`model.set`、`session.compact`、`session.create`、`session.fork`、`session.rename`、`session.reload`），无法识别的命令提示“未知命令”而不发送。共用的解析与执行逻辑在 `@pier/chat-state` 的 `slash.ts`。

### 模型

| 方法 | 参数 | 结果 |
|---|---|---|
| `model.list` | `{ sessionId?, workspaceId?, runtime? }` | `{ models: ModelInfo[], current?, thinkingLevel? }`（仅列出已配置凭据的模型）。带 `sessionId` 时列出该会话运行时的模型，否则列出 `runtime`（1.22，默认 `pi`）的模型。带 `sessionId` 时 `current` / `thinkingLevel` 是该会话的模型与思考等级；只带 `workspaceId` 时（1.19）是在该工作区新建会话时会使用的模型与思考等级（与 pi 的解析一致：有凭据的默认模型，否则第一个可用模型；思考等级依次取该模型的设置、默认思考等级、`medium`，再按模型能力钳制），供新建会话前在输入框中选择模型；都不带时只返回 `models` |
| `model.set` | `{ sessionId, provider, modelId, persist? }` | `{ model }`；`persist: true` 写入 pi 全局默认值 |
| `thinking.set` | `{ sessionId, level, persist? }` | `{ level }`（按模型能力钳制后的实际等级） |
| `model.setDefault` | `{ provider, modelId }` | `{ defaultModel }`；写入 pi 全局 settings，只影响新会话（1.2） |

### 服务商与凭据（1.2）

直接在 Pier 中配置模型，无需安装 pi CLI。凭据写入 pi 的 `auth.json`，自定义接口写入 `models.json`（都在 `agentDir` 中，与终端里的 pi 共用）。结果中不包含任何密钥；1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放。

| 方法 | 参数 | 结果 |
|---|---|---|
| `provider.list` | – | `ProviderListResult`：`{ providers: ProviderInfo[], defaultModel?, defaultAvailable, availableCount, agentDir, error? }`。`ProviderInfo` 含登录方式（`apiKey` / `oauth`）、凭据状态与来源、模型数量，自定义接口另有 `custom`（不含密钥，只有 `hasConfiguredKey`） |
| `provider.login` | `{ providerId, method: "api_key"\|"oauth" }` | `{ flowId }`；随后本连接收到 `auth.*` 事件（见 §4.3）。同一连接再次调用会取消之前的登录 |
| `provider.loginRespond` | `{ flowId, promptId, value?, cancelled? }` | `{ accepted }`；回答 `auth.prompt`，`cancelled: true` 取消整个登录 |
| `provider.loginCancel` | `{ flowId }` | `{ cancelled }` |
| `provider.logout` | `{ providerId }` | `{ removed }`；删除 pi 当前使用的凭据：优先删除 `auth.json` 中保存的凭据；没有时，如果密钥来自 `models.json` 里该服务商的 `apiKey`（明文密钥或 `!命令`），则删除这个字段（只剩 `name` 的条目整项删除，pi 无法加载时回滚并返回 `BAD_REQUEST`）。不影响环境变量及 `$VAR` 形式的引用 |
| `provider.saveCustom` | `{ provider: CustomProvider, apiKey?, apiKeyRef?, create? }` | `{ provider, defaultModel? }`；`CustomProvider = { id, name?, api, baseUrl, models: { id, name?, reasoning?, images?, contextWindow?, maxTokens?, api? }[] }`，`api` 为 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` 之一。模型的 `api`（1.7）表示该模型使用与服务商不同的接口：写入 `models.json` 时同时写入该模型的 `api` 和按服务商 Base URL 换算的 `baseUrl`（去掉末尾的 `/v1` / `/v1beta` 得到根地址，OpenAI 类接口加 `/v1`，Anthropic 用根地址，Google 加 `/v1beta`）；改回服务商的接口时一并删除换算出的 `baseUrl`。只改动表单涉及的字段，文件中的其他内容保留（含注释的文件先备份为 `models.json.bak`）；pi 无法加载时回滚并返回 `BAD_REQUEST`。新建时必须提供 `apiKey`（或 1.3 起的 `apiKeyRef`，见下文 NewAPI），编辑时省略则保留原密钥 |
| `provider.removeCustom` | `{ providerId }` | `{ removed }`；同时删除保存的密钥 |
| `provider.probeModels` | `{ api, baseUrl, apiKey?, apiKeyRef?, providerId? }` | `{ models: CustomModel[] }`；请求接口的模型列表（OpenAI：`GET <baseUrl>/models`）。省略 `apiKey` 时使用 `apiKeyRef`（1.3）或 `providerId` 已保存的密钥。1.6 起，pi 内置模型目录认识的模型会带上 `reasoning` / `images` / `contextWindow` / `maxTokens`；1.7 起，NewAPI 站点在模型列表中给出 `supported_endpoint_types` 时，与 `api` 不同的推荐接口会作为模型的 `api` 返回 |

**模型能力自动识别（1.6）**：`GET /models` 只返回模型 ID，因此 Host 会按 pi 内置的模型目录补全能力。ID 会先规范化再匹配：统一小写，去掉 `anthropic/` 这类前缀和 `:free` 这类标签，忽略日期后缀（`-20250929`）以及 `4.5` / `4-5` 的写法差异；`-thinking` / `-nothinking` 后缀分别视为推理 / 非推理变体。目录里没有的模型，只按常见推理系列的名称推断 `reasoning` 和 `images`，其他仍视为未知。`provider.saveCustom` 保存时，模型中未设置（省略）的字段按此补全；显式传入的值（包括 `reasoning: false`、`images: false`）保持不变，并原样写入 `models.json`。Host 启动时也会为 `models.json` 中自定义服务商（不含内置服务商的覆盖配置）缺少 `reasoning`、`input`、`contextWindow`、`maxTokens` 的模型补全这些字段，已有字段不会改动；pi 因此无法加载时回滚。服务商配置变化后，已打开的会话会重新解析当前模型并发送 `session.model`；如果模型刚被识别为推理模型、而会话的思考等级是 `off`，会改用配置的默认思考等级。

登录、保存或删除后，如果当前默认模型不可用，Host 会自动把默认模型设为刚配置的服务商的第一个可用模型，并在结果中返回 `defaultModel`。

### NewAPI 登录（1.3）

登录 [NewAPI](https://github.com/QuantumNous/new-api) 中转站，读取令牌和可用模型，再用 `provider.saveCustom` 保存为自定义接口。登录会话只保存在 Host 内存中，只属于发起的连接；连接断开、调用 `newapi.close` 或 30 分钟未使用后丢弃。令牌密钥由 Host 直接读取，客户端只拿到 `keyRef`，可在同一连接的 `provider.saveCustom` / `provider.probeModels` 中代替 `apiKey`。1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放（浏览器授权回到 Host 所在电脑的回环地址，只适合在那台电脑上使用）。

**模型接口识别（1.7）**：NewAPI 的 `GET /v1/models` 为每个模型列出 `supported_endpoint_types`（服务该模型的所有渠道的并集：Anthropic 渠道为 `anthropic`、`openai`，Gemini 渠道为 `gemini`、`openai`，Codex 渠道只有 `openai-response`，NewAPI / Sub2API 这类透传渠道为全部类型）。Host 据此给出模型的 `api`：支持 `anthropic` 的 Claude 模型（ID 中含 `claude`），以及只支持 `anthropic` 的模型，用 `anthropic-messages`；其余支持 `openai` 的用 `openai-completions`，只支持 `openai-response` 的用 `openai-responses`，只支持 `gemini` 的用 `google-generative-ai`；都不支持（如嵌入模型）时省略。不返回该字段的旧版本只按名称把 Claude 模型识别为 `anthropic-messages`。客户端保存时，把与服务商 `api` 不同的推荐接口写入模型的 `api`。

同时支持当前版本的仪表盘登录（登录返回 Bearer 访问令牌，可选的 RSA 密码加密、`/api/user/login/verify` 两步验证）和旧版本的 Cookie 会话（`New-Api-User` 请求头、`/api/user/login/2fa`）。开启 Turnstile 或只能第三方登录的站点，改用「系统访问令牌」。

| 方法 | 参数 | 结果 |
|---|---|---|
| `newapi.login` | `{ baseUrl, username, password }` 或 `{ baseUrl, accessToken, userId? }` | `NewApiLoginResult`：`{ status: "ok", sessionId, account }` 或需要两步验证时 `{ status: "verify", sessionId, methods }`。`baseUrl` 可以带 `/v1`、`/console/...` 等路径，Host 会规范为站点根地址。`account = { site: { name, url, version?, logo? }, user: { id?, username, displayName?, group? }, tokens: NewApiToken[], groups: { name, description?, ratio? }[] }`，`NewApiToken = { id, name, maskedKey, status, group?, expiresAt?, unlimitedQuota, remainQuota?, modelLimits? }`（`status`：1 启用、2 禁用、3 过期、4 额度用尽） |
| `newapi.verify` | `{ sessionId, code }` | `NewApiLoginResult`；提交两步验证码（或备用码） |
| `newapi.createToken` | `{ sessionId, name, group? }` | `{ tokenId, tokens }`；新建无限额度、永不过期、不限模型的令牌 |
| `newapi.useToken` | `{ sessionId, tokenId }` | `{ keyRef, models: { id, api? }[], modelsError? }`；读取令牌密钥（`POST /api/token/:id/key`，旧版本从令牌列表读取），并用它请求 `GET /v1/models`。`api`（1.7）是推荐的调用接口，见下文「模型接口识别」 |
| `newapi.close` | `{ sessionId }` | `{ closed }`；丢弃登录，并退出 Host 用密码建立的仪表盘会话（不会吊销用户自己的访问令牌） |

#### 浏览器授权（1.4）

站点开启 NewAPI「应用授权」（`/api/status` 返回 `app_authorization_enabled: true`）时，可以不经过 Pier 输入任何凭据：用户在浏览器中用站点支持的任意方式登录（包括 GitHub、LinuxDO、Passkey 等），在站点的授权页面确认后，站点为 Pier 新建一个令牌。流程是面向原生应用的 OAuth 2.0 授权码流程（RFC 8252 回环重定向 + RFC 7636 PKCE S256）：

1. `newapi.authorizeStart` 让 Host 在 `127.0.0.1` 的随机端口监听 `/callback`，生成 `state` 与 `code_verifier`，返回站点的授权页面地址 `authorizeUrl`（`<site>/app-auth?client_name=Pier&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&key_name=…`）；
2. 客户端在系统浏览器中打开 `authorizeUrl`，并调用 `newapi.authorizeWait` 等待；
3. 用户同意后浏览器跳回回环地址，Host 校验 `state`，用授权码和 `code_verifier` 调用站点的 `POST /api/app-auth/token` 换取令牌密钥，再读取模型列表；`state` 不符的请求返回 400 且不影响流程，用户拒绝（`error=access_denied`）时流程结束。

因为浏览器会跳回 Host 所在电脑的回环地址，所以只适用于本地 UI；流程只属于发起的连接，10 分钟未完成、连接断开或调用 `newapi.authorizeCancel` 时结束并关闭端口。

| 方法 | 参数 | 结果 |
|---|---|---|
| `newapi.authorizeStart` | `{ baseUrl }` | `{ flowId, authorizeUrl, site, expiresAt }`；站点未开启应用授权时 `BAD_REQUEST` |
| `newapi.authorizeWait` | `{ flowId }` | `{ site, user, token: { id, name, group?, maskedKey }, keyRef, models, modelsError? }`；用户在浏览器中同意后返回，`keyRef` 与 `newapi.useToken` 的相同。拒绝、超时、取消或换取失败时返回错误 |
| `newapi.authorizeCancel` | `{ flowId }` | `{ cancelled }` |

### 个人中心（1.6）

桌面端「设置 → 个人中心」直连云链API（`https://api.yunnet.top`，协议里的 `YUNLIAN_SITE_URL`；测试时可以用 `PierHostOptions.accountSite` 或 `faux-host --account-site` 换成其他 NewAPI 站点）。与连接绑定的 `newapi.*` 不同，这里的登录属于 Host：所有连接共用，并保存在 Pier 目录的 `account.json`（仅当前用户可读），重启后仍然有效。密码登录只保存站点发放的刷新 Cookie（`new_api_refresh`，站点每次刷新都会轮换，登录 30 天后需要重新登录），不保存密码和 15 分钟有效的访问令牌；Host 在访问令牌过期前或被拒绝时用 `POST /api/user/auth/refresh` 自动换新。用系统访问令牌登录时保存该令牌。站点拒绝刷新（已退出、被吊销或账号安全信息改变）时，Host 删除保存的登录，之后的调用返回「请先登录」。1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放。

| 方法 | 参数 | 结果 |
|---|---|---|
| `account.status` | — | `{ site?, siteError?, user? }`；`site = AccountSite = { name, url, version?, logo?, registerEnabled, emailVerification, passwordLogin, browserLogin, turnstile, oauth: string[], quota: { perUnit, type, usdRate?, customSymbol?, customRate? } }`（来自站点的 `/api/status`，`type` 为 `USD`、`CNY`、`CUSTOM` 或 `TOKENS`）；`user` 为保存的登录，没有登录时省略 |
| `account.login` | `{ username, password }` 或 `{ accessToken, userId? }` | `AccountLoginResult`：`{ status: "ok", overview }` 或需要两步验证时 `{ status: "verify", methods }`。站点开启 Turnstile 时密码登录返回 `BAD_REQUEST` |
| `account.verify` | `{ code }` | `AccountLoginResult`；提交两步验证码（或备用码） |
| `account.authorizeStart` | — | `{ flowId, authorizeUrl, expiresAt }`（1.16）；见下文「浏览器登录」。站点不支持时 `BAD_REQUEST` |
| `account.authorizeWait` | `{ flowId }` | `AccountLoginResult`（1.16）；用户在浏览器中登录并同意后返回 `{ status: "ok", overview }` 并保存登录。拒绝、超时、取消或换取失败时返回错误 |
| `account.authorizeCancel` | `{ flowId }` | `{ cancelled }`（1.16） |
| `account.sendCode` | `{ email }` | `{ sent: true }`；发送注册邮箱验证码（`GET /api/verification`） |
| `account.register` | `{ username, password, email?, code?, affCode? }` | `AccountLoginResult`；注册（`POST /api/user/register`，用户名最多 20 个字符、密码 8–128 位，站点开启邮箱验证时必须提供 `email` 和 `code`，`affCode` 为邀请码）后立即登录。站点关闭注册或开启 Turnstile 时 `BAD_REQUEST` |
| `account.overview` | — | `{ site, user, tokens: NewApiToken[], groups }`；`user = { id?, username, displayName?, email?, group?, quota, usedQuota, requestCount }`，额度为站点单位，按 `site.quota` 换算显示 |
| `account.createToken` | `{ name, group? }` | `{ tokenId, tokens }`；在分组中新建无限额度、永不过期、不限模型的令牌 |
| `account.useToken` | `{ tokenId }` | `{ keyRef, models, modelsError? }`；与 `newapi.useToken` 相同，`keyRef` 属于调用的连接 |
| `account.logout` | — | `{ loggedOut }`；退出站点上的会话（不会吊销用户自己的访问令牌）并删除 `account.json` |

#### 浏览器登录（1.16）

`site.browserLogin` 为 `true`（站点的 `/api/status` 返回 `app_authorization_enabled: true`，且 `app_authorization_scopes` 包含 `account`）时，个人中心只在浏览器中登录，Pier 不接触密码：用户可以用站点支持的任意方式登录（账号密码、GitHub、LinuxDO、Passkey、人机验证等），在授权页面同意后，站点为 Pier 建立一个独立的登录会话（登录方式为「应用」，出现在网页「登录会话」中，可以随时注销）。流程与上文的 `newapi.authorize*` 相同（RFC 8252 回环重定向 + PKCE S256），区别是授权页面地址带 `scope=account`、不带 `key_name`，站点不会新建令牌，`POST /api/app-auth/token` 返回 `{ scope: "account", access_token, access_expires_at, refresh_token, session, user }`。Host 把 `refresh_token` 当作刷新 Cookie 使用，与密码登录一样只保存它，并自动续期。流程属于发起的连接；因为浏览器会跳回 Host 所在电脑的回环地址，所以只适用于本地 UI。Host 请求 NewAPI 站点时使用 `User-Agent: Pier/<版本> (<系统>)`。不支持的站点仍然使用 `account.login` / `account.register`。

桌面端把每个分组的令牌保存为自定义服务商 `yunlian-<分组>`（名称为「云链API · 分组」，Base URL 为 `<站点>/v1`）；「模型与服务商」中浏览器授权添加的是 `yunlian`。

### 扩展与扩展包（1.8）

管理 pi 的扩展包（`packages`：npm、git 或本地目录，可包含扩展、技能、提示词模板与主题）和资源目录中的独立资源，效果与 `pi install` / `pi remove` / `pi update --extensions` / `pi config` 相同：Host 直接使用 pi 的包管理器，读写 pi 的 settings 文件。全局（`scope: "user"`）对应 `<agentDir>/settings.json`，对所有工作区生效；项目（`scope: "project"`）对应 `<工作区>/.pi/settings.json`，需要带 `workspaceId`（Pier 中添加的工作区视为已信任）。扩展会在 Host 进程中以用户权限执行代码；1.9 及以前所有方法仅限本地连接，1.10 起对已配对设备开放（配对即完全信任）。

不带 `workspaceId` 时只看全局设置；带上时同时包含该工作区的项目设置（与在该目录运行 pi 时看到的相同，项目中的同名包覆盖全局的）。

修改设置后，Host 对受影响的活跃会话（全局改动为所有会话，项目改动为该工作区的会话）执行 `session.reload` 的效果：空闲会话立即重新加载，运行中或有待回答对话框的会话保持不变，需要之后自行 `/reload`。结果中的 `reload = ExtensionReloadSummary = { reloaded, pending, failed }` 给出三类会话的数量，随后向所有连接广播 `extension.changed`。修改操作在 Host 内按顺序执行。

| 方法 | 参数 | 结果 |
|---|---|---|
| `extension.list` | `{ workspaceId? }` | `ExtensionListResult = { agentDir, workspaceId?, packages, resources }`。`packages: ExtensionPackageInfo[] = { source, scope, kind: "npm"\|"git"\|"local", filtered, installedPath?, name?, version?, description? }`：`source` 与 settings 中写的一致（本地路径相对 settings 文件所在目录），`installedPath` 缺失表示没有安装或路径不存在，`name` / `version` / `description` 来自包的 `package.json`。`resources: ExtensionResourceInfo[] = { type: "extensions"\|"skills"\|"prompts"\|"themes", path, name, enabled, scope, origin: "package"\|"top-level", source, deletable }`：已停用的资源也会列出；包内资源的 `source` 为包的 `source`，独立资源为 `auto`（`extensions/`、`skills/` 等资源目录，含 `~/.agents/skills`）或 `local`（settings 中列出的路径）。列出时不会安装缺失的包 |
| `extension.install` | `{ source, scope?("user"), workspaceId? }` | `{ package?, reload }`；安装并写入 settings（`pi install [-l]`）。`source` 为 `npm:<包名>[@版本]`、`git:<主机>/<路径>[@ref]`、Git 仓库 URL，或本地扩展文件 / 扩展包目录的**绝对**路径（支持 `~`；相对路径或不存在时 `BAD_REQUEST`）。npm / git 来源需要 Host 能执行 `npm` / `git`（npm 可用 settings 的 `npmCommand` 指定），找不到命令时 `BAD_REQUEST`。进度以 `extension.progress` 给出，可能耗时较长，客户端应放宽超时。已存在的来源会重新安装 |
| `extension.remove` | `{ source, scope, workspaceId? }` | `{ removed, reload }`；从 settings 移除并卸载 pi 安装的 npm / git 副本（`pi remove`），本地路径只从 settings 移除。`source` 使用 `extension.list` 返回的值；没有匹配的包时 `removed: false` |
| `extension.update` | `{ source?, workspaceId? }` | `{ reload }`；更新一个包，省略 `source` 时更新全部（`pi update --extensions`）。固定版本的 npm 包与固定 ref 的 git 包只会校准到配置的版本。没有匹配的包时 `NOT_FOUND` |
| `extension.checkUpdates` | `{ workspaceId? }` | `{ updates: { source, name, kind: "npm"\|"git", scope }[] }`；列出有新版本的未固定包（需要网络） |
| `extension.setEnabled` | `{ type, path, enabled, workspaceId? }` | `{ resource, reload }`；在资源所属范围的 settings 中启用 / 停用一个已列出的资源（与 `pi config` 相同）：独立资源在 `extensions` / `skills` / `prompts` / `themes` 数组中写入 `+路径` / `-路径`，包内资源写入该包条目的筛选。`path` 与 `type` 必须与 `extension.list` 的某一项一致，否则 `NOT_FOUND` |
| `extension.delete` | `{ path, workspaceId? }` | `{ deleted: true, reload }`；删除一个独立扩展（`deletable: true`）：扩展目录中的文件或带 `index.ts` 的目录移到 Pier 回收站（`~/.pier/trash/extensions`），settings 中列出的路径只从 settings 移除（文件保留）。包内扩展或通过目录条目加载的扩展返回 `BAD_REQUEST`（改为移除包或停用） |
| `extension.search` | `{ query?, type?: "extension"\|"skill"\|"theme"\|"prompt", sort?: "downloads"\|"recent"\|"name"("downloads"), page?(1) }` | `ExtensionCatalogResult = { origin: "pi.dev"\|"npm", packages, total, page, pageSize, hasMore, notice? }`（1.20）；在 Host 所在电脑上搜索 pi 官方扩展仓库 [pi.dev/packages](https://pi.dev/packages)（发布到 npm、带 `pi-package` 关键词的包），每页 50 个。`packages: ExtensionCatalogPackage[] = { name, source, description?, version?, author?, types, monthlyDownloads?, publishedAt?, npmUrl, repositoryUrl?, galleryUrl? }`，`source`（`npm:<包名>`）可直接传给 `extension.install`；`types` 为空表示仓库没有标注类型。仓库无法访问时改用 npm registry 搜索（`keywords:pi-package`），此时 `origin: "npm"`、`notice` 说明原因，`type` 与 `sort` 不生效。结果在 Host 中缓存 5 分钟；只读，不写审计日志。两者都无法访问时返回 `INTERNAL` |

settings 文件无法解析时，修改类方法返回 `CONFLICT`，避免覆盖用户的文件。

### pi 设置（1.15）

直接读写 pi 的 settings 文件，供「设置 → Agent 配置 → pi」可视化编辑（终端里的 pi 读取同一份文件）。与 `extension.*` 相同，`scope: "user"` 为 `<agentDir>/settings.json`，`scope: "project"` 为 `<工作区>/.pi/settings.json`，需要带 `workspaceId`。Host 不校验各设置项的含义，只保证文件是 JSON 对象；写入时与 pi 使用同一把文件锁（`proper-lockfile`），不会与正在保存设置的 pi 进程交错。对已配对设备开放，远程调用写入审计日志（只记录修改的键名和字节数，不记录值）。

文件有实际变化时，Host 对受影响的空闲会话执行 `session.reload`（全局改动为所有会话，项目改动为该工作区的会话；运行中的会话计入 `pending`），然后广播 `settings.changed`、`extension.changed`（settings 中也有扩展包与资源），全局改动再广播 `provider.changed`（默认模型也在其中）。个别设置（如 `defaultTools`、`transport`）只在创建会话时读取，重新加载不会改变已打开会话的这些值。

| 方法 | 参数 | 结果 |
|---|---|---|
| `settings.get` | `{ workspaceId? }` | `PiSettingsResult = { agentDir, user, project? }`，`user` / `project` 为 `PiSettingsFile = { scope, path, exists, text, settings?, error?, modifiedAt? }`（`project` 另带 `workspaceId`）。按文件原样返回，不合并全局与项目设置，也不补默认值。文件不存在时 `exists: false, text: "", settings: {}`；内容不是 JSON 对象时省略 `settings` 并给出 `error`，`text` 仍为原文 |
| `settings.update` | `{ scope, workspaceId?, changes: { path: string[], value? }[], reload?(true) }` | `PiSettingsChangeResult = { file, changed, reload }`；在文件当前内容上逐项修改：`path` 为键路径（如 `["compaction", "enabled"]`，1–8 段，禁止 `__proto__` / `prototype` / `constructor`），带 `value` 时设置（沿途创建对象），省略时删除该键并移除因此变空的父对象。其他键（包括 Pier 不认识的）保持不变，按 pi 的格式（两个空格缩进）写回，保留原有的结尾换行。路径经过的值不是对象时 `BAD_REQUEST`；文件无法解析时 `CONFLICT`（改用 `settings.write` 修复）。内容没有变化时不写文件，`changed: false`。`reload: false` 跳过重新加载会话（只影响终端 pi 的设置），仍会广播事件 |
| `settings.write` | `{ scope, workspaceId?, text, expectedModifiedAt? }` | `PiSettingsChangeResult`；用 `text`（最多 1 MiB，必须是 JSON 对象）整体替换文件，原样写入。带 `expectedModifiedAt`（读取时的 `modifiedAt`）时，文件在此之后被修改（或已被删除）则 `CONFLICT`，不写入。`text` 不是 JSON 对象时 `BAD_REQUEST` |
| `host.packageManagers` | – | `PackageManagerDetection = { managers: PackageManagerInfo[] }`，`PackageManagerInfo = { name: "npm"\|"pnpm"\|"bun", path, onPath, default?, version?, error? }`：Host 所在电脑上的 npm / pnpm / bun，供设置 pi 的 `npmCommand`（1.17）。先按 Host `PATH` 的顺序，再查找常见安装目录（`~/.bun/bin`、pnpm 与 Volta 的目录、Homebrew、`/usr/local/bin` 等，Windows 为 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm` 等）；`onPath: false` 表示只在常见安装目录中找到，需要使用完整路径。`path` 经过所在目录的真实路径（不跟随文件本身的符号链接），同一个文件只列出一次；`default: true` 表示直接执行该名称时运行的就是这一个（`PATH` 中的第一个）。`version` 为在用户主目录中以 Host 的环境执行 `--version` 的输出（去掉开头的 `v`），失败或 5 秒内没有结束时省略并给出 `error`（例如 npm 找不到 `node`）。不修改任何设置 |

Host 由桌面端启动时（`--watch-stdin`，macOS / Linux），启动过程中会以交互式登录 Shell（`$SHELL -i -l -c`，环境变量 `PIER_RESOLVING_ENVIRONMENT=1`，最多 5 秒）读取一次 `PATH`，放在继承的 `PATH` 之前，使 pi（扩展安装、bash 工具等）能找到终端中可用的 npm / pnpm / bun / git（nvm、fnm、mise、Volta、Homebrew 等）。AppImage 注入的 `$APPDIR` 条目不会传给这个 Shell。`--no-login-shell-path` 关闭这一行为；Windows 不需要。

### Claude Code 与 Codex 配置（1.23）

直接读写 Claude Code 与 Codex 自己的配置文件，供「设置 → Agent 配置 → Claude Code / Codex」可视化编辑（终端中的 `claude` / `codex` 读取同一份文件）。`runtime` 为 `claude-code` 或 `codex`，`scope`：

| `runtime` | `user` | `project` | `local` |
|---|---|---|---|
| `claude-code`（JSON） | `<CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json` | `<工作区>/.claude/settings.json` | `<工作区>/.claude/settings.local.json` |
| `codex`（TOML） | `<CODEX_HOME 或 ~/.codex>/config.toml` | `<工作区>/.codex/config.toml` | –（`BAD_REQUEST`） |

`project` / `local` 需要 `workspaceId`。Host 不校验各设置项的含义，只保证 Claude Code 的文件是 JSON 对象、Codex 的文件是有效的 TOML。这两个 CLI 不使用文件锁，写入为直接替换。对已配对设备开放，远程调用写入审计日志（只记录修改的键名和字节数，不记录值——其中可能有 API Key）。

文件有实际变化时，Host 让该运行时丢弃从配置读取的缓存（模型列表；Codex 没有打开的会话时还会停止共用的 `codex app-server`，下次使用时按新配置启动），并广播 `agentConfig.changed`。已经打开的会话保持原来的配置，新建或重新打开后生效。Pier 按工作区审批策略设置的项（Claude Code 的 `permissions.defaultMode`、Codex 的 `approval_policy` / `sandbox_mode` / `sandbox_workspace_write`）只影响终端中的 CLI。

| 方法 | 参数 | 结果 |
|---|---|---|
| `agentConfig.get` | `{ runtime, workspaceId? }` | `AgentConfigResult = { runtime, format: "json"\|"toml", configDir, scopes, files, workspaceId?, available }`。`scopes` 是该运行时的全部范围（优先级从低到高），`files` 为 `user` 文件，带 `workspaceId` 时还有该工作区的文件，顺序同 `scopes`；每项 `AgentConfigFile = { scope, path, exists, text, settings?, error?, modifiedAt? }`，语义同 `PiSettingsFile`。TOML 的 `settings` 转换为 JSON：日期时间为 ISO 字符串，超出安全范围的整数为字符串。`available` 表示这台电脑上装了该 CLI（没装也可以编辑文件） |
| `agentConfig.update` | `{ runtime, scope, workspaceId?, changes: { path: string[], value? }[] }` | `AgentConfigChangeResult = { file, changed }`；与 `settings.update` 相同地逐项设置或删除键，其他内容保持不变。JSON 以两个空格缩进写回；TOML 在原文上修改，保留注释、顺序与格式，在已有表中新增的子表（如另一个 `[model_providers.x]`）写成紧跟在同级表后的节，内联表保持内联；写入前重新解析校验，结果与预期不符时 `INTERNAL` 且不写入。TOML 不能存 `null`（`BAD_REQUEST`）。文件无法解析时 `CONFLICT`（改用 `agentConfig.write` 修复） |
| `agentConfig.write` | `{ runtime, scope, workspaceId?, text, expectedModifiedAt? }` | `AgentConfigChangeResult`；用 `text`（最多 1 MiB）整体替换文件，原样写入。Claude Code 的必须是 JSON 对象，Codex 的必须是有效的 TOML（可以为空），否则 `BAD_REQUEST`；`expectedModifiedAt` 同 `settings.write` |

### UI

| 方法 | 参数 | 结果 |
|---|---|---|
| `ui.respond` | `{ sessionId, requestId, response: UiResponse }` | `{ accepted }`；请求已被其他客户端回答 / 超时 / 取消时为 `false` |

### 其他电脑（1.9）

每台电脑的 Host 都可以作为“设备”与其他电脑配对（使用它自己的静态密钥，见 [`docs/security.md`](security.md) §4.4）。桌面界面通过本地 Gateway 的 `ws://127.0.0.1:<port>/peer/<peerId>` 连接已配对的电脑：第一帧必须是带本地 token 的 `host.hello`（与普通本地连接一样校验 Origin 与 token），Host 校验后**去掉 token**，经 Noise IK 加密通道把 hello 与之后的帧原样转发给那台电脑，并把它的帧原样转回。对那台电脑来说这是一条普通的远程连接：`host.hello` 结果带 `device`，不能调用 🔒 方法，也收不到仅限本地的事件。连不上时以 4502 关闭，那台电脑吊销了本机时以 4403 关闭（reason `UNKNOWN_DEVICE`）。

| 方法 | 参数 | 结果 |
|---|---|---|
| `peer.list` 🔒 | – | `{ peers: PeerInfo[] }`：`{ id（那台电脑的 hostId）, name, fingerprint, addresses, deviceId, pairedAt, lastConnectedAt?, platform?, version?, connected }`；`connected` 表示当前有桌面窗口经本机连着它 |
| `peer.pair` 🔒 | `{ uri }`（那台电脑显示的 `pier://pair?...` 链接） | `{ peer }`；在那台电脑的用户确认后返回。失败时 `data.reason` 为 `INVALID_LINK`（`BAD_REQUEST`）、`SELF`（本机自己的链接）、`UNREACHABLE`、`PAIRING_INVALID`、`PAIRING_REJECTED`、`PAIRING_TIMEOUT`、`BAD_HANDSHAKE` 等（`CONFLICT`）。可能耗时数分钟，客户端请放宽超时 |
| `peer.remove` 🔒 | `{ peerId }` | `{ removed }`；只在本机忘记那台电脑，并断开经本机到它的连接（4404）；那台电脑的设备列表不变 |

Host 保存已配对的电脑于 `~/.pier/peers.json`（0600），每次经代理连接成功后更新名称、系统、版本、最近连接时间，并把成功的地址排到最前。

### 远程访问、配对与设备（1.1）

| 方法 | 参数 | 结果 |
|---|---|---|
| `remote.status` 🔒 | – | `RemoteAccessStatus`：`{ enabled, port, running, addresses, hostFingerprint, mdns, pairingActive, error? }` |
| `remote.configure` 🔒 | `{ enabled?, port?(1024–65535) }` | `RemoteAccessStatus`；写入 `config.json` 并立即启动 / 停止 / 换端口（换端口或关闭会断开远程连接） |
| `pairing.start` 🔒 | – | `{ uri, expiresAt, addresses }`；`uri` 即二维码内容。远程访问未运行时 `CONFLICT`。再次调用会让旧配对码失效 |
| `pairing.cancel` 🔒 | – | `{ cancelled }` |
| `pairing.respond` 🔒 | `{ requestId, accept }` | `{ accepted }`；请求已超时或设备已断开时为 `false` |
| `device.list` 🔒 | – | `{ devices: DeviceInfo[] }`：`{ id, name, platform?, model?, appVersion?, fingerprint, pairedAt, lastSeenAt?, connected }` |
| `device.rename` 🔒 | `{ deviceId, name }` | `{ device }` |
| `device.revoke` 🔒 | `{ deviceId }` | `{ revoked }`；该设备的连接立即以 4403 断开 |

## 4. 事件

### 4.1 pi 会话事件（透传）

与 pi 的 JSON/RPC 模式相同的线上形态：`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start|update|end`、`queue_update`、`compaction_start|end`、`auto_retry_start|end`、`session_info_changed`、`thinking_level_changed`、`summarization_retry_*`、`bash_execution_update`、`entry_appended`。

两处精简：

- `message_update` 去掉累积的 `partial` 消息，只保留 `{ type, usage, assistantMessageEvent }`；`toolcall_start` 额外带 `id` 与 `toolName`。客户端用 `message_start` + 增量重建流式消息，`message_end` 为权威结果。
- `entry_appended` 对消息条目只保留元数据 `{ type: "message", id, parentId, timestamp, role }`（完整内容已在 `message_end` 中）。

`agent_settled` 表示 pi 不会再自动继续，适合作为"任务完成"通知的触发点。

Claude Code 与 Codex 会话（1.22）发出同样形态的事件与 `AgentMessage`（`user` / `assistant` / `toolResult`，以及压缩后的 `compactionSummary`），只使用其中的一个子集：`agent_start`、`agent_end`、`agent_settled`、`message_start|update|end`、`tool_execution_start|update|end`、`queue_update`、`compaction_start|end`、`auto_retry_start|end`、`session_info_changed`、`thinking_level_changed`；没有 `turn_*`、`entry_appended` 与 `bash_execution_update`。assistant 消息的 `provider` 为运行时 ID。

### 4.2 Pier 会话事件

| 事件 | 字段 | 说明 |
|---|---|---|
| `session.snapshot` | `snapshot` | 仅在订阅 / 恢复时单独发给该连接，**不带 seq**，不写入日志 |
| `session.status` | `state: idle\|streaming\|compacting\|retrying` | 状态变化时发送 |
| `session.model` | `model?, thinkingLevel` | `model.set` 之后 |
| `session.replaced` | `previousSessionId, session` | 扩展命令（如 `/new`）替换了底层 pi 会话；帧的 `sessionId` 为旧 ID，随后会收到新会话的 `session.snapshot` |
| `session.closed` | `reason: idle\|closed\|deleted\|host_shutdown` | 会话离开活跃池；`deleted` 表示会话已被 `session.delete` 删除（1.6） |
| `ui.request` | `request: UiRequest` | 对话框或审批请求，见 §6 |
| `ui.resolved` | `requestId, resolution: answered\|timeout\|cancelled, response?, by?` | `by` 为回答者的 `connectionId` |
| `ui.notify` | `message, level` | 扩展通知 |
| `ui.status` / `ui.widget` / `ui.title` / `ui.editorText` | 见类型定义 | 扩展的 fire-and-forget UI 调用；当前状态也包含在快照中 |
| `extension.error` | `extensionPath, event, error` | 扩展处理器出错 |

### 4.3 Host 事件（无 sessionId / seq）

发给所有已认证连接：

| 事件 | 字段 | 说明 |
|---|---|---|
| `host.notice` | `level, message, sessionId?` | |
| `workspace.changed` | – | 工作区列表或策略变化 |
| `session.listChanged` | `workspaceId` | 会话列表变化（新建、分叉、关闭、重命名…） |
| `session.activity` | `workspaceId, sessionId, state, pendingUi` | 活跃会话的运行状态或待回答请求数变化（1.1）。列表页据此显示“运行中 / 待批准”，无需订阅每个会话 |
| `provider.changed` | – | 服务商、凭据、`models.json` 或默认模型变化（1.2）；重新调用 `provider.list` / `model.list` |
| `extension.changed` | `workspaceId?` | 扩展或扩展包设置变化（1.8）；只改了某个工作区的项目设置时带 `workspaceId`。重新调用 `extension.list`，会话的斜杠命令也可能变化 |
| `update.status` | `status: AppUpdateStatus` | 桌面端更新器的状态或下载进度变化（1.13），见「应用更新」 |
| `settings.changed` | `scope, workspaceId?` | 通过 `settings.update` / `settings.write` 修改了 pi 的 settings 文件（1.15）；`scope: "project"` 时带 `workspaceId`。重新调用 `settings.get`。在 Pier 之外修改文件（终端 pi、手动编辑）不会触发 |
| `agentConfig.changed` | `runtime, scope, workspaceId?` | 通过 `agentConfig.update` / `agentConfig.write` 修改了 Claude Code 或 Codex 的配置文件（1.23）；工作区文件带 `workspaceId`。重新调用 `agentConfig.get`。在 Pier 之外修改文件不会触发 |

终端事件（1.18），只发给打开该终端的连接，见「终端」：

| 事件 | 字段 | 说明 |
|---|---|---|
| `terminal.output` | `terminalId, data` | 终端输出，`data` 为原始字节的 base64 |
| `terminal.exit` | `terminalId, code, error?` | 终端结束；`error` 表示终端丢失（桌面端退出等） |

仅发给本地（桌面）连接（`LOCAL_ONLY_EVENTS`）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `remote.changed` | `status: RemoteAccessStatus` | 远程访问启停、端口变化、配对码生效 / 失效 |
| `device.changed` | – | 设备登记、吊销、改名，或连接状态变化；重新调用 `device.list` |
| `pairing.request` | `request: { id, device, fingerprint, address?, createdAt, expiresAt }` | 设备出示了正确的配对码，等待用户用 `pairing.respond` 确认 |
| `pairing.resolved` | `requestId, resolution: accepted\|rejected\|expired\|cancelled, deviceId?` | 配对请求结束（`cancelled`：设备在等待中断开） |
| `peer.changed` | – | 已配对的其他电脑增删、改名，或经本机的连接建立 / 断开（1.9）；重新调用 `peer.list` |

发给所有连接（1.9 及以前仅发给本地连接）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `extension.progress` | `action: install\|remove\|update\|clone\|pull, phase: start\|progress\|complete\|error, source, message?` | `extension.install` / `remove` / `update` 的进度（1.8） |

服务商登录进度（1.2），只发给调用 `provider.login` 的那个连接；连接断开时登录自动取消：

| 事件 | 字段 | 说明 |
|---|---|---|
| `auth.prompt` | `flowId, prompt: { id, type: text\|secret\|select\|manual_code, message, placeholder?, options? }` | 需要用户输入（API Key、授权码、选项等），用 `provider.loginRespond` 回答 |
| `auth.promptClosed` | `flowId, promptId` | 问题已不需要回答（例如浏览器回调先完成） |
| `auth.notice` | `flowId, notice` | `auth_url`（打开浏览器登录）、`device_code`（设备码）、`info`、`progress` |
| `auth.done` | `flowId, providerId, ok, cancelled?, error?, defaultModel?` | 登录结束 |

## 5. EventLog、订阅与断线恢复

- 每个活跃会话有一个 EventLog：单调递增的 `seq`（从 1 开始）与环形缓冲（默认 5000 条），以及随机的 `epoch`。Host 重启、会话被重新加载或被替换都会产生新的 epoch。
- `session.subscribe` 的语义：
  - 带 `sinceSeq` 且 `epoch` 与当前一致、缺口仍在缓冲内 → `mode: "replay"`，随后按序补发 `seq > sinceSeq` 的事件；
  - 否则 → `mode: "snapshot"`，随后发送一个 `session.snapshot`，再接实时事件。
- **顺序保证**：订阅响应先于补发事件或快照到达；补发 / 快照之后才是订阅期间产生的实时事件。快照的 `seq` 表示它已包含到该 seq 为止的全部事件，之后的事件从 `seq + 1` 开始。
- 客户端应记录每个会话最后应用的 `seq` 与 `epoch`，并**丢弃 `seq <= lastSeq` 的事件**。`@pier/client` 自动完成这些：断线后指数退避重连，重新 `host.hello`，再用 `sinceSeq/epoch` 重新订阅；若会话已不在活跃池中（`NOT_FOUND`），会先 `session.open` 再从快照开始。
- **增量合并**：`host.hello` 指定 `coalesceMs > 0` 时，同一会话、同一内容块、相同类型（`text_delta` / `thinking_delta` / `toolcall_delta`）的连续增量在窗口内合并为一帧，合并帧携带最后一条的 `seq`。其他任何帧到来前都会先刷出待合并的帧，顺序不变。建议手机端使用约 50ms。
- **背压**：连接发送缓冲超过 16 MiB 时，Host 以关闭码 1013 断开，客户端重连后通过 `sinceSeq` 恢复。

### SessionSnapshot

```ts
{
  session: SessionSummary;     // 含 state
  seq: number; epoch: string;
  messages: AgentMessage[];    // 完整转录（含 system 消息，客户端可自行过滤）
  streamingMessage?: AgentMessage; // 正在流式输出的部分消息
  pendingToolCalls: string[];
  pendingUi: UiRequest[];      // 仍待回答的对话框 / 审批
  queue: { steering: string[]; followUp: string[] };
  model?: ModelInfo; thinkingLevel: string;
  statuses: Record<string, string>; widgets: Record<string, { lines: string[]; placement?: string }>;
  title?: string; errorMessage?: string;
  capabilities?: AgentRuntimeCapabilities; // 会话运行时的能力（1.22），见 §3 Agent 运行时
}
```

`SessionSummary.runtime`（1.22）是会话的 Agent 运行时；旧版 Host 不返回该字段，视为 `pi`。

`ModelInfo = { provider, id, name, reasoning, input: string[], contextWindow?, thinkingLevels? }`。`thinkingLevels`（1.19）是模型支持的思考等级，从低到高（`off`、`minimal`、`low`、`medium`、`high`，模型支持时还有 `xhigh`、`max`），不支持推理的模型为 `["off"]`；`thinking.set` 会把不支持的等级钳制到其中之一。

## 6. UI 请求与审批

- 扩展调用 `ctx.ui.select/confirm/input/editor` 时，Host 生成 `UiRequest` 并以 `ui.request` 广播给该会话的所有订阅者。**先到先得**：第一个合法的 `ui.respond` 生效，其他客户端的回答返回 `accepted: false`；所有人都会收到 `ui.resolved`。
- 没有客户端在线时请求保持挂起（出现在之后的快照里），超时（默认 30 分钟，扩展可指定更短）后按默认答案解决：`confirm` → `false`，其余 → 取消。
- `UiResponse` 依请求类型校验：`confirm` 需 `confirmed`；`select` 需 `value` 且在 `options` 中；`input` / `editor` 需 `value`；任意类型都可用 `{ cancelled: true }` 取消。
- 终端专属能力（`custom`、`setFooter`、`setHeader`、编辑器组件、主题切换等）按 pi RPC 模式降级为 no-op；`ctx.ui.theme` 始终可用。

### 审批（`pier-approval` 内置扩展）

`kind: "approval"` 的请求带 `approval` 字段：

```ts
{ toolName, toolCallId, summary, input /* 长字段截断 */, reason, severity: "normal" | "high",
  sessionAllowable: boolean, sessionScope?: string }
```

回答为 `{ decision: "allow_once" | "allow_session" | "deny", reason? }`。拒绝时 `reason` 会作为工具结果返回给模型；超时或取消视为拒绝。

工作区策略：

| 策略 | 行为 |
|---|---|
| `ask` | `bash`、`write`、`edit` 每次都需审批 |
| `smart`（默认） | 只读命令白名单（`ls`、`cat`、`rg`、`git status/log/diff/show` 等，无输出重定向、命令替换）直接放行；工作区内的 `write`/`edit` 放行；其余 shell 命令与工作区外（含经符号链接逃逸）的写入需审批 |
| `auto` | 全部放行 |

在任何非 `auto` 策略下，危险模式（`rm -r`、`sudo`、`git push --force`、`git reset --hard`、`curl … \| sh` 等）一律以 `severity: "high"` 请求审批，且不提供"本会话内允许"。"本会话内允许"的范围：shell 命令按所用程序（如"运行 `npm` 的 bash 命令"）；写入按工作区或目标目录。只读工具（`read`、`grep`、`find`、`ls`）和扩展自定义工具不受策略约束。

## 7. 与 pi CLI 的并发

- Pier 使用与 pi 相同的会话文件（`~/.pi/agent/sessions`），可在终端 `pi --resume` 继续同一会话。
- Host 在 `~/.pier/locks` 中为打开的会话加锁，防止两个 Pier Host 同时写入同一文件（持锁进程已退出时自动接管）。
- 若会话空闲时文件被外部（例如 pi CLI）修改，后续写操作（`prompt`、`rename`、`model.set`、`compact` 等）返回 `CONFLICT`，需要关闭并重新打开会话。

## 8. 空闲回收

没有订阅者、非运行中、没有待处理 UI 请求，且 30 分钟无活动的会话会被自动 `dispose`（`session.closed { reason: "idle" }`），之后可通过 `session.open` 重新加载。
