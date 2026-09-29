# Pier 协议 v1.3

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

## 2. 握手与版本

连接后第一个请求必须是 `host.hello`；在其成功前，其他请求返回 `UNAUTHENTICATED`。10 秒内未完成握手的连接会被关闭。握手完成前 Host 按顺序处理帧，因此客户端可以在 `host.hello` 之后立即流水线发送请求。

```jsonc
{ "type": "req", "id": "h", "method": "host.hello", "params": {
  "protocolVersion": "1.3",
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

参数中的 `sessionId` 均为 pi 会话 ID。标注 🔒 的方法仅本地桌面连接可调用（`LOCAL_ONLY_METHODS`）。

### host

| 方法 | 参数 | 结果 |
|---|---|---|
| `host.hello` | 见上 | `{ protocolVersion, host, connectionId }` |
| `host.info` | – | `HostInfo`（hostId、hostName、version、protocolVersion、platform、piVersion、agentDir） |

### workspace

| 方法 | 参数 | 结果 |
|---|---|---|
| `workspace.list` | – | `{ workspaces: WorkspaceInfo[] }` |
| `workspace.add` 🔒 | `{ path(绝对路径), name?, policy? }` | `{ workspace }`；路径会取 realpath，重复添加返回已有项 |
| `workspace.remove` 🔒 | `{ workspaceId }` | `{ removed }`；先强制关闭该工作区的活跃会话 |
| `workspace.setPolicy` 🔒 | `{ workspaceId, policy: "ask"\|"smart"\|"auto" }` | `{ workspace }`；立即对活跃会话生效 |

### session

| 方法 | 参数 | 结果 |
|---|---|---|
| `session.list` | `{ workspaceId }` | `{ sessions: SessionSummary[] }`，按修改时间倒序；活跃会话 `active: true` 并带实时 `state` 与 `pendingUi`（待回答的对话框 / 审批数，1.1） |
| `session.create` | `{ workspaceId, name? }` | `{ session }`（已进入活跃池） |
| `session.open` | `{ workspaceId, sessionId }` 或 `{ workspaceId, path }` | `{ session }`；`path` 必须出现在该工作区的会话列表中 |
| `session.close` | `{ sessionId, force? }` | `{ closed }`；运行中且未 `force` → `CONFLICT` |
| `session.forkPoints` | `{ sessionId }` | `{ points: { entryId, text }[] }`（可 fork 的用户消息） |
| `session.fork` | `{ sessionId, entryId, position?: "before"\|"at" }` | `{ session, selectedText? }`；生成**新**会话，原会话不变 |
| `session.rename` | `{ sessionId, name }` | `{ session }` |
| `session.subscribe` | `{ sessionId, sinceSeq?, epoch? }` | `{ mode: "replay"\|"snapshot", currentSeq, epoch }`，见 §5 |
| `session.unsubscribe` | `{ sessionId }` | `{ unsubscribed }` |
| `session.snapshot` | `{ sessionId }` | `SessionSnapshot`（一次性读取，不影响订阅） |

### 运行

| 方法 | 参数 | 结果 |
|---|---|---|
| `session.prompt` | `{ sessionId, text, images?, streamingBehavior? }` | `{ accepted: true }`，在 pi 接受 prompt 后立即返回，输出通过事件流给出。会话运行中且未指定 `streamingBehavior` → `CONFLICT` |
| `session.steer` | `{ sessionId, text, images? }` | `{ queue }` |
| `session.followUp` | `{ sessionId, text, images? }` | `{ queue }` |
| `session.abort` | `{ sessionId }` | `{ aborted: true }`，在会话回到空闲后返回 |
| `session.compact` | `{ sessionId, instructions? }` | `{ summary, tokensBefore }`，压缩完成后返回（可能较慢，客户端应放宽超时） |

`images`：`{ type: "image", data: <base64>, mimeType: "image/…" }[]`，最多 16 张；单帧上限 64 MiB。

### 模型

| 方法 | 参数 | 结果 |
|---|---|---|
| `model.list` | `{ sessionId? }` | `{ models: ModelInfo[], current? }`（仅列出已配置凭据的模型） |
| `model.set` | `{ sessionId, provider, modelId, persist? }` | `{ model }`；`persist: true` 写入 pi 全局默认值 |
| `thinking.set` | `{ sessionId, level, persist? }` | `{ level }`（按模型能力钳制后的实际等级） |
| `model.setDefault` 🔒 | `{ provider, modelId }` | `{ defaultModel }`；写入 pi 全局 settings，只影响新会话（1.2） |

### 服务商与凭据（1.2）

直接在 Pier 中配置模型，无需安装 pi CLI。凭据写入 pi 的 `auth.json`，自定义接口写入 `models.json`（都在 `agentDir` 中，与终端里的 pi 共用）。所有方法均为 🔒，结果中不包含任何密钥。

| 方法 | 参数 | 结果 |
|---|---|---|
| `provider.list` 🔒 | – | `ProviderListResult`：`{ providers: ProviderInfo[], defaultModel?, defaultAvailable, availableCount, agentDir, error? }`。`ProviderInfo` 含登录方式（`apiKey` / `oauth`）、凭据状态与来源、模型数量，自定义接口另有 `custom`（不含密钥，只有 `hasConfiguredKey`） |
| `provider.login` 🔒 | `{ providerId, method: "api_key"\|"oauth" }` | `{ flowId }`；随后本连接收到 `auth.*` 事件（见 §4.3）。同一连接再次调用会取消之前的登录 |
| `provider.loginRespond` 🔒 | `{ flowId, promptId, value?, cancelled? }` | `{ accepted }`；回答 `auth.prompt`，`cancelled: true` 取消整个登录 |
| `provider.loginCancel` 🔒 | `{ flowId }` | `{ cancelled }` |
| `provider.logout` 🔒 | `{ providerId }` | `{ removed }`；删除 pi 当前使用的凭据：优先删除 `auth.json` 中保存的凭据；没有时，如果密钥来自 `models.json` 里该服务商的 `apiKey`（明文密钥或 `!命令`），则删除这个字段（只剩 `name` 的条目整项删除，pi 无法加载时回滚并返回 `BAD_REQUEST`）。不影响环境变量及 `$VAR` 形式的引用 |
| `provider.saveCustom` 🔒 | `{ provider: CustomProvider, apiKey?, apiKeyRef?, create? }` | `{ provider, defaultModel? }`；`CustomProvider = { id, name?, api, baseUrl, models: { id, name?, reasoning?, images?, contextWindow?, maxTokens? }[] }`，`api` 为 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` 之一。只改动表单涉及的字段，文件中的其他内容保留（含注释的文件先备份为 `models.json.bak`）；pi 无法加载时回滚并返回 `BAD_REQUEST`。新建时必须提供 `apiKey`（或 1.3 起的 `apiKeyRef`，见下文 NewAPI），编辑时省略则保留原密钥 |
| `provider.removeCustom` 🔒 | `{ providerId }` | `{ removed }`；同时删除保存的密钥 |
| `provider.probeModels` 🔒 | `{ api, baseUrl, apiKey?, apiKeyRef?, providerId? }` | `{ models: { id, name? }[] }`；请求接口的模型列表（OpenAI：`GET <baseUrl>/models`）。省略 `apiKey` 时使用 `apiKeyRef`（1.3）或 `providerId` 已保存的密钥 |

登录、保存或删除后，如果当前默认模型不可用，Host 会自动把默认模型设为刚配置的服务商的第一个可用模型，并在结果中返回 `defaultModel`。

### NewAPI 登录（1.3）

登录 [NewAPI](https://github.com/QuantumNous/new-api) 中转站，读取令牌和可用模型，再用 `provider.saveCustom` 保存为自定义接口。登录会话只保存在 Host 内存中，只属于发起的连接；连接断开、调用 `newapi.close` 或 30 分钟未使用后丢弃。令牌密钥由 Host 直接读取，客户端只拿到 `keyRef`，可在同一连接的 `provider.saveCustom` / `provider.probeModels` 中代替 `apiKey`。所有方法均为 🔒。

同时支持当前版本的仪表盘登录（登录返回 Bearer 访问令牌，可选的 RSA 密码加密、`/api/user/login/verify` 两步验证）和旧版本的 Cookie 会话（`New-Api-User` 请求头、`/api/user/login/2fa`）。开启 Turnstile 或只能第三方登录的站点，改用「系统访问令牌」。

| 方法 | 参数 | 结果 |
|---|---|---|
| `newapi.login` 🔒 | `{ baseUrl, username, password }` 或 `{ baseUrl, accessToken, userId? }` | `NewApiLoginResult`：`{ status: "ok", sessionId, account }` 或需要两步验证时 `{ status: "verify", sessionId, methods }`。`baseUrl` 可以带 `/v1`、`/console/...` 等路径，Host 会规范为站点根地址。`account = { site: { name, url, version?, logo? }, user: { id?, username, displayName?, group? }, tokens: NewApiToken[], groups: { name, description?, ratio? }[] }`，`NewApiToken = { id, name, maskedKey, status, group?, expiresAt?, unlimitedQuota, remainQuota?, modelLimits? }`（`status`：1 启用、2 禁用、3 过期、4 额度用尽） |
| `newapi.verify` 🔒 | `{ sessionId, code }` | `NewApiLoginResult`；提交两步验证码（或备用码） |
| `newapi.createToken` 🔒 | `{ sessionId, name, group? }` | `{ tokenId, tokens }`；新建无限额度、永不过期、不限模型的令牌 |
| `newapi.useToken` 🔒 | `{ sessionId, tokenId }` | `{ keyRef, models: { id }[], modelsError? }`；读取令牌密钥（`POST /api/token/:id/key`，旧版本从令牌列表读取），并用它请求 `GET /v1/models` |
| `newapi.close` 🔒 | `{ sessionId }` | `{ closed }`；丢弃登录，并退出 Host 用密码建立的仪表盘会话（不会吊销用户自己的访问令牌） |

### UI

| 方法 | 参数 | 结果 |
|---|---|---|
| `ui.respond` | `{ sessionId, requestId, response: UiResponse }` | `{ accepted }`；请求已被其他客户端回答 / 超时 / 取消时为 `false` |

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

### 4.2 Pier 会话事件

| 事件 | 字段 | 说明 |
|---|---|---|
| `session.snapshot` | `snapshot` | 仅在订阅 / 恢复时单独发给该连接，**不带 seq**，不写入日志 |
| `session.status` | `state: idle\|streaming\|compacting\|retrying` | 状态变化时发送 |
| `session.model` | `model?, thinkingLevel` | `model.set` 之后 |
| `session.replaced` | `previousSessionId, session` | 扩展命令（如 `/new`）替换了底层 pi 会话；帧的 `sessionId` 为旧 ID，随后会收到新会话的 `session.snapshot` |
| `session.closed` | `reason: idle\|closed\|host_shutdown` | 会话离开活跃池 |
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

仅发给本地（桌面）连接（`LOCAL_ONLY_EVENTS`）：

| 事件 | 字段 | 说明 |
|---|---|---|
| `remote.changed` | `status: RemoteAccessStatus` | 远程访问启停、端口变化、配对码生效 / 失效 |
| `device.changed` | – | 设备登记、吊销、改名，或连接状态变化；重新调用 `device.list` |
| `pairing.request` | `request: { id, device, fingerprint, address?, createdAt, expiresAt }` | 设备出示了正确的配对码，等待用户用 `pairing.respond` 确认 |
| `pairing.resolved` | `requestId, resolution: accepted\|rejected\|expired\|cancelled, deviceId?` | 配对请求结束（`cancelled`：设备在等待中断开） |

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
}
```

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
