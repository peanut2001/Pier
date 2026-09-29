# Changelog

Pier 的所有重要变更都记录在这里。版本号规则：日常发版只递增最后一位（0.2.1、0.2.2……），`x.y.0` 留给大版本；1.0 之前，大版本可能包含不兼容的变更。

## v0.2.13 — 2026-09-30

可以在设置中搜索并一键安装 pi 官方扩展仓库中的扩展包；可以在设置页直接修改其他电脑上的 Pier；输入框中可以选择模型与思考程度；用户消息不再显示 pi 附加的图片尺寸说明。

### 新增

- **扩展市场**：「设置 → 扩展」新增「扩展市场」标签页（原来的列表在「已安装」中），直接搜索 pi 官方扩展仓库 [pi.dev/packages](https://pi.dev/packages)：可以按名称、描述或作者搜索，按类型（扩展 / 技能 / 主题 / 提示词）筛选，按下载量、发布时间或名称排序，每页 50 个并可加载更多。每个扩展包显示版本、类型、作者、月下载量、更新时间以及 pi.dev / npm / 源码链接，已经安装的会标出「已安装」。点击「安装」即安装 `npm:<包名>`（可选装到全局或所选工作区），与按来源安装一样显示进度并重新加载空闲的会话。搜索由所设置电脑上的 Pier Host 完成，结果缓存 5 分钟；pi.dev 无法访问时自动改用 npm registry 搜索（带 `pi-package` 关键词的包，此时类型筛选与排序不可用）并给出提示。
- **协议 1.20**（向后兼容）：新增 `extension.search`，对已配对设备开放。设置其他电脑的扩展时，那台电脑需要升级到这个版本才能使用扩展市场。
- **设置其他电脑上的 Pier**：添加了其他电脑后，设置页左上角会出现「设置哪台电脑上的 Pier」选择框。切换到另一台电脑后，「常规」「个人中心」「模型与服务商」「扩展」「pi 配置」这几页通过加密通道读取并直接修改那台电脑上的 Pier（凭据、自定义接口、默认模型、扩展包与 `settings.json` 都保存在那台电脑上），点击「同步」可随时重新读取；「设备与远程」「日志」仍只针对本机。浏览器授权只能回到本机，设置其他电脑时请在个人中心用账号密码或访问令牌登录。那台电脑需要协议 1.10 或更高（pi 配置需要 1.15），版本过旧时页面会提示先更新它。
- **在输入框中选择模型与思考程度**：模型选择从会话顶部移到输入框工具栏（发送按钮旁），新建会话页面也有，第一条消息就能发给选定的模型。思考程度改为分档滑块，只列出当前模型支持的档位。
- **协议 1.19**（向后兼容）：`model.list` 可以只带 `workspaceId`，返回在该工作区新建会话时会使用的模型与思考程度；结果新增 `thinkingLevel`，`ModelInfo` 新增 `thinkingLevels`。

### 修复

- **隐藏图片尺寸说明**：带图片的消息中，pi 为模型附加的「[Image: original WxH, displayed at WxH. …]」说明不再显示在用户消息、会话标题和会话列表预览中（会话数据保持不变）。

## v0.2.12 — 2026-09-30

修复其他电脑重启后立刻重新连接时无法在它上面打开终端的问题；修复个人中心中名称相近的分组互相覆盖的问题。

### 修复

- **其他电脑重启后没有终端**：另一台电脑上的 Pier 重启（例如远程更新到新版本）后，本机往往在它刚开始监听时就自动重新连接，此时那台电脑还没声明能运行终端，于是在重新连接之前，它的工作区一直没有「在终端中打开」、目录旁的终端按钮和顶部终端按钮。现在桌面端启动内置 Pier Host 时就声明能运行终端（`pier-host --shell-terminals`），重新连接得再快也能打开终端。需要升级的是被连接的那台电脑；已经遇到这个问题时，切换到其他电脑再切回来（或重启本机的 Pier）即可恢复。
- **个人中心分组互相覆盖**：名称只差大小写或附加文字的分组（例如「Claude」和「claude企业级」）会得到同一个服务商 ID，添加其中一个时显示为已配置，保存时还会覆盖另一个分组的服务商和令牌。现在这类分组各自得到独立的服务商 ID；已经保存的服务商仍能找到，多个分组共用的旧 ID 归属于最初保存它的那个分组。

## v0.2.11 — 2026-09-29

可以在其他电脑的工作区中直接打开终端；个人中心改为在浏览器中登录；可以检测并选用本机的 npm / pnpm / bun；从程序坞或启动器打开的 Pier 也能使用终端中的 `PATH`。

### 新增

- **检测本机的 npm / pnpm / bun**：「设置 → pi 配置 → 工具与 Shell → npm 命令」下方列出本机找到的 npm、pnpm 和 bun（版本、完整路径、是否在 PATH 中、哪一个是默认的 npm），点「使用」即把 `npmCommand` 设为它的完整路径，正在使用的一项会高亮；无法运行的（例如 npm 找不到 `node`）会标出原因。除 `PATH` 外还会查找 `~/.bun/bin`、pnpm 与 Volta 的安装目录、Homebrew、`/usr/local/bin` 等常见位置。
- **协议 1.17**（向后兼容）：新增 `host.packageManagers`，对已配对设备开放。
- **在其他电脑上打开终端**：内置终端现在在工作区所在的电脑上打开。查看其他电脑的工作区时，文件面板的「在终端中打开」、目录旁的终端按钮、顶部的终端按钮与 `` Ctrl+` `` 都会在那台电脑上启动 shell，标签页标出电脑名称；本机与各台电脑的终端共用底部面板。那台电脑上的 Pier 用它的桌面端伪终端运行 shell（等同于在那台电脑上登录），打开终端会写入它的审计日志（不记录输入）；连接断开时终端随之关闭并在标签页中说明。那台电脑需要升级到这个版本，并运行桌面端（独立运行的 `pier-host` 不提供终端）。
- **协议 1.18**（向后兼容）：新增 `terminal.open` / `terminal.write` / `terminal.resize` / `terminal.close` 与 `terminal.output` / `terminal.exit` 事件，对已配对设备开放；`HostInfo.terminals` 表示 Host 能否运行终端。Host 通过 sidecar 的 stdio 使用桌面端的伪终端（`pier.shell.capabilities`、`terminal.spawn`、`pier.shell.terminal*` 消息），输出按连接的积压暂停 / 恢复读取。`faux-host --demo-terminals` 提供可远程打开的演示终端。

### 变更

- **个人中心改为浏览器登录**：「设置 → 个人中心」不再在 Pier 中输入账号密码，而是点击「在浏览器中登录」，在系统浏览器里用云链API 支持的任意方式（账号密码、GitHub、LinuxDO、Passkey 等）登录并授权 Pier，完成后自动回到 Pier 显示余额与分组。Pier 只保存站点为它建立的独立登录会话（可以在网页「登录会话」中随时注销），不会接触密码；没有账号可以在登录页面注册。站点需要支持应用授权登录的 NewAPI（`app_authorization_scopes` 包含 `account`），不支持的站点仍显示原来的账号密码 / 访问令牌表单。
- **协议 1.16**（向后兼容）：新增 `account.authorizeStart` / `account.authorizeWait` / `account.authorizeCancel`，`AccountSite` 新增 `browserLogin`。
- **使用终端中的 PATH**：在 macOS 和 Linux 上，从程序坞 / 启动器打开的 Pier（包括 AppImage）没有终端里的 `PATH`，用 nvm、fnm、mise、Volta、Homebrew 或 bun 安装的工具会报「找不到命令」。内置的 Pier Host 现在启动时会向登录 Shell 读取一次 `PATH`（最多 5 秒）并放在前面，扩展安装和 Agent 的 bash 工具都能找到这些命令。Shell 启动文件可以根据 `PIER_RESOLVING_ENVIRONMENT=1` 跳过耗时的初始化；`pier-host --no-login-shell-path` 可关闭这一行为。

## v0.2.10 — 2026-09-29

可以在设置中远程更新其他电脑上的 Pier；会话支持归档与按时间批量清理；新增 pi 配置（`settings.json`）的可视化编辑。

### 新增

- **远程更新其他电脑**：“设置 → 关于与更新”新增「其他电脑」，列出每台已添加电脑上的 Pier 版本，可以直接检查更新并「更新到 vX」。那台电脑上的 Pier 会下载官方正式版、用内置公钥校验签名、安装并自动重启，本机随后自动重新连接并提示「已更新到 vX」；更新失败时显示原因并可重试。那台电脑上有会话正在运行或等待审批时会先提醒；Linux `.deb` / `.rpm` 安装需要有人在那台电脑上输入管理员密码，界面会提示。那台电脑的窗口会收到「某某正在远程更新 Pier」的通知，远程发起的安装写入它的审计日志。被更新的电脑需要先手动升级到这个版本，之后即可远程更新。
- **协议 1.13**（向后兼容）：新增 `update.status`、`update.check`、`update.install` 与 `update.status` 事件，对已配对设备开放；Host 通过 sidecar 的 stdin / stdout 驱动桌面端的更新器（`pier.shell.*` 消息）。`faux-host --demo-updates` 提供模拟的更新器，便于调试界面。
- **归档与批量清理会话**：侧边栏的会话悬停时新增「归档」按钮（与删除并列），归档的会话收进每个工作区底部可展开的「已归档（N）」分组，随时可以取消归档；会话顶部「…」菜单也可以归档 / 取消归档，工作区首页的「最近的会话」不再列出已归档的会话。工作区悬停时新增「清理会话…」，可以按「超过 1 / 3 / 7 / 30 天未更新」或「全部会话」一次性归档或删除（可只删除已归档的会话），执行前预览将受影响的会话；删除的会话照常移到 `~/.pier/trash/sessions`，运行中或等待审批的会话会被跳过。归档只是 Pier 的标记（`~/.pier/archived-sessions.json`），不修改会话文件，归档的会话照常可以打开和继续对话。手机端默认隐藏已归档的会话（可展开），长按会话可以归档或取消归档。会话所在的电脑需要升级到这个版本。
- **协议 1.14**（向后兼容）：新增 `session.archive` 与 `session.cleanup`（支持 `dryRun` 预览），`SessionSummary` 新增 `archived`。
- **pi 配置可视化编辑**：「设置 → pi 配置」可以直接编辑 pi 的 `settings.json`（与终端中的 pi 共用）：全局设置或某个工作区的 `.pi/settings.json`。表单按「模型与思考」「交互」「工具与 Shell」「会话与压缩」「网络与重试」「图片」「更新与统计」分组，列出每一项的键名、默认值（编辑工作区设置时显示继承的全局值）和是否已设置，支持搜索、一键恢复默认；只影响终端 pi 的界面设置单独折叠在「终端中的 pi」中。表单没有覆盖的设置（如 `modelThinkingLevels`、`compaction.modelOverrides`）可以切换到 JSON 视图编辑：保存前检查格式，文件在别处被修改时提示冲突，文件损坏时自动进入 JSON 视图以便修复。修改立即写入（保留 Pier 不认识的键，并使用 pi 的文件锁），空闲的会话随后重新加载。
- **协议 1.15**（向后兼容）：新增 `settings.get` / `settings.update` / `settings.write` 与 `settings.changed` 事件，对已配对设备开放。

## v0.2.9 — 2026-09-29

修复安装版中发送的图片被丢弃、模型看不到图片的问题；远程电脑升级后重新连接即可识别新版本。

### 修复

- **发送的图片被丢弃**：安装版中，附加到消息里的图片（以及工具读取的图片）会被替换成 "[Image omitted: could not be resized below the inline image size limit.]"，模型看不到图片。原因是内置的 Pier Host 在构建机以外的电脑上找不到图片缩放所需的 Photon 组件（`photon_rs_bg.wasm`），现在会从安装包自带的资源目录加载。发送图片的电脑（会话所在的 Host）需要升级到这个版本。`pier-host` 新增 `--check-images`，可自检图片处理是否可用，发版冒烟测试会据此校验安装包。
- 已配对的电脑升级 Pier 后，桌面端重新连接时会刷新它的版本信息，不再一直误报「Pier 版本较旧」直到重启应用。

## v0.2.8 — 2026-09-29

所有电脑的工作区统一列在侧边栏，点开即在它所在的电脑上运行；已配对的设备获得完全信任，可以远程管理工作区、审批策略、文件和模型配置；窗口底部新增状态栏，可查看本机和远程主机的 CPU、内存、磁盘与网络占用；文件面板支持删除文件。

### 新增

- **底部状态栏与主机状态**：窗口底部新增一条状态栏，最右侧显示当前工作区所在电脑的 CPU、内存、磁盘占用和网络上下行速率（每 2 秒刷新，窗口隐藏时暂停；占用超过 75% / 90% 时变为黄色 / 红色）。点击后弹出「主机状态」，同时列出本机和所有已添加的远程主机：CPU（核数与负载）、内存、磁盘的用量与进度条、网络速率、已运行时间和 Pier 自身的内存占用；远程主机离线时可以直接重新连接，Pier 版本过旧时提示升级；底部还可以「添加电脑」或进入「管理远程主机」。远程主机需要升级到这个版本才能显示资源占用。
- **协议 1.12**（向后兼容）：新增 `host.stats`，返回 Host 所在电脑的 CPU、内存、磁盘和网络占用，对已配对设备开放。
- **文件面板删除文件**：在右侧文件面板中右键文件或目录，选择「删除…」（或选中后按 Delete / ⌘⌫），确认后永久删除该文件或整个目录；删除符号链接只删除链接本身。删除不进入废纸篓 / 回收站，确认框会明确提示。已打开的该文件预览会随之关闭。连接其他电脑时同样可用（那台电脑需升级到这个版本），远程删除会写入那台电脑的审计日志。
- **协议 1.11**（向后兼容）：新增 `workspace.deletePath`。

### 变更

- **工作区不再按电脑区分**：侧边栏去掉了顶部的电脑切换器，本机和所有已配对电脑的工作区与会话统一列在左侧，其他电脑上的工作区旁显示电脑名称（离线时变灰，恢复连接后自动加载会话）。点开任一工作区或会话就直接在它所在的电脑上查看和驱动，不需要先切换电脑；新建会话时选择的工作区决定 Agent 在哪台电脑上运行。侧边栏「添加工作区」在有其他电脑时会先询问添加到哪台电脑（也可以从这里添加电脑），「设置 → 工作区」按电脑分组管理所有工作区。桌面端会同时连接所有已配对的电脑（离线的电脑在后台重试），并记住它们的工作区列表，离线时也能看到。
- **配对即完全信任**：已配对的其他电脑和手机不再只能使用现有工作区，而是可以像本机一样管理这台电脑：在切换到的电脑上直接「添加工作区」（浏览那台电脑的目录选择项目）、移除工作区、修改工作区的审批策略、在文件预览中编辑文件；服务商与模型、账号和扩展的方法也对远程连接开放。只有配对、设备管理、远程访问设置和已连接的其他电脑仍只能在本机操作。远程设备的这些管理操作会写入审计日志。被连接的电脑需要升级到这个版本；较旧的版本仍会提示在那台电脑上添加。
- **协议 1.10**（向后兼容）：新增 `host.listDirectories`；`LOCAL_ONLY_METHODS` 只保留 `device.*` / `pairing.*` / `remote.*` / `peer.*`，`auth.*` 与 `extension.progress` 事件不再仅限本地连接。

### 修复

- Windows 上在「设置 → 扩展」中启用或停用扩展时，如果 settings 里已有用 `/` 写的同一条覆盖项（手动编辑或从其他系统同步过来的配置），现在会替换它，而不是再追加一条相互冲突的覆盖项。

## v0.2.7 — 2026-09-29

电脑之间也可以互相连接，切换到另一台电脑查看和驱动它的会话；文件面板新增右键菜单，弹窗不再因误触遮罩或 Esc 而关闭。

### 新增

- **电脑连电脑**：每台运行 Pier 的电脑都是一个节点，除了手机，电脑之间也可以互相连接。在侧边栏顶部的电脑切换器（或「设置 → 设备与远程 → 可连接的其他电脑」）中点「添加电脑」，粘贴另一台电脑「显示配对二维码 → 复制配对链接」得到的链接，并在那台电脑上确认，就能切换过去查看和驱动它的工作区与会话：新建会话、流式查看输出、steer / 中止、审批命令、切换模型、浏览和预览文件，Agent 仍在那台电脑上运行。可以随时切回本机或切换到其他电脑，每台电脑分别记住上次打开的会话；那台电脑离线时自动重试，被那台电脑移除后提示重新配对。两台电脑想互相连接时在两边各添加一次；只有被连接的电脑需要开启局域网访问。连接使用本机 Pier Host 的密钥、与手机相同的端到端加密通道（私钥不离开 Host 进程），被连接的电脑把它当作普通的远程设备：出现在其设备列表中（显示为「Linux / macOS / Windows 电脑」）、可以随时移除，并且不能修改那台电脑的工作区、审批策略、模型、扩展或配对设置，也不能编辑文件或打开终端。
- **协议 1.9**（向后兼容）：新增仅限本地连接的 `peer.list` / `peer.pair` / `peer.remove` 与 Host 事件 `peer.changed`；本地 Gateway 新增 `/peer/<id>` 路径，把桌面界面的连接经加密通道转发到已配对的电脑。
- **文件面板右键菜单**：在右侧文件面板中右键文件或目录，可以打开 / 展开折叠、插入路径到输入框、复制相对路径 / 绝对路径 / 名称、在终端中打开（文件为所在目录），以及在访达 / 资源管理器 / 文件管理器中显示；右键空白处可以刷新、全部折叠、复制工作区路径、在终端或文件管理器中打开工作区。菜单支持方向键选择、Enter 执行、Esc 关闭，也可以用菜单键或 Shift+F10 打开。

### 变更

- 「设置 → 手机与远程」改名为「设备与远程」，配对说明同时覆盖手机与电脑；设备列表区分手机与电脑。
- `@pier/client`：连接成功过的客户端在重连时如果 `host.hello` 因连接断开或超时失败，会继续重连，而不是直接关闭（经代理连接时本地连接总能建立，失败发生在 hello 阶段）。
- **弹窗防误触**：桌面端的弹窗（添加 / 编辑自定义接口、登录、工作区设置、文件预览等）不再因点击遮罩或按 Esc 而关闭，只能通过右上角的关闭按钮或弹窗内的按钮关闭，避免误触丢失已填写的内容。

### 修复

- 桌面端终端面板的标签关闭按钮在悬停标签和当前标签上正常显示。

## v0.2.6 — 2026-09-29

桌面端新增内置终端、在设置中管理 pi 扩展与扩展包，文件预览窗口可以直接编辑并保存工作区文件；界面视觉焕新，侧边栏收起和展开带有过渡动画。

### 新增

- **内置终端**：桌面端可以直接打开终端，不必再切换到系统终端。点会话标题栏（以及工作区首页、新建会话页右上角）的终端按钮或按 Ctrl+`（macOS 上同样是 Ctrl+`）打开底部终端面板，新终端在当前工作区目录中启动；文件面板中目录行尾的终端按钮可以直接在该目录打开终端。支持多个终端标签、拖动调整面板高度（双击恢复默认）、清屏，链接可以点击在浏览器中打开；Linux / Windows 上用 Ctrl+Shift+C / V 复制粘贴，macOS 上用 ⌘C / ⌘V，⌘K 清屏。隐藏面板或切换会话时终端继续运行，关闭标签才会结束进程；在终端里执行 `exit` 会关闭标签，非零退出码会保留输出供查看。终端使用用户的默认 shell（macOS / Linux 上作为登录 shell 启动，Windows 上为 PowerShell），只在本机运行，不会经过 Pier Host，也不会暴露给手机端。
- **扩展管理**：「设置」新增「通用 → 扩展」，不用再到终端里执行 `pi install` / `pi remove` / `pi config`：
  - 安装扩展包：填写 `npm:包名`、`git:github.com/用户/仓库`、Git 仓库地址，或本地扩展文件 / 扩展包目录的绝对路径，可以选择全局安装（所有工作区）或只装到某个工作区（写入它的 `.pi/settings.json`）。安装过程显示进度，npm / git 来源需要电脑上装有 npm / git。
  - 列出已安装的扩展包（名称、版本、说明、来源与安装位置），展开可以看到包里的扩展、技能、提示词和主题，并逐项启用或停用；npm / git 包可以检查更新、单独更新或全部更新，也可以移除（本地目录只从配置中移除，文件保留）。
  - 列出 `extensions` 目录中的独立扩展和 settings 中列出的扩展路径，可以启用、停用或删除（扩展目录中的文件移到 Pier 回收站 `~/.pier/trash/extensions`，settings 中的路径只从配置中移除）；其他独立的技能、提示词和主题也可以启用或停用。支持搜索，选择工作区后同时管理该工作区的项目级扩展。
  - 与终端里的 pi 共用同一份配置。修改后空闲的会话会立即重新加载，正在运行的会话会提示在完成后执行 `/reload`。扩展会以你的系统权限运行，页面顶部有安全提示；这些操作只能在桌面端进行，手机等远程设备无权调用。
- **协议 1.8**（向后兼容）：新增仅限本地连接的 `extension.list` / `install` / `remove` / `update` / `checkUpdates` / `setEnabled` / `delete`，新增 Host 事件 `extension.changed` 与仅限本地的 `extension.progress`。
- **编辑工作区文件**：文件预览窗口中，完整读取的文本文件（含 Markdown 源码）新增「编辑」按钮，可以直接修改并保存回磁盘：编辑区带行号，Tab 按文件已有的缩进风格插入缩进，Ctrl/⌘+S 保存，「撤销修改」恢复到上次保存的内容。保存时保留文件原有的 CRLF 换行、UTF-8 BOM、权限与硬链接；如果文件在打开后被 Agent 或其他程序改过，会提示「仍然覆盖」或「放弃修改并重新读取」，不会静默覆盖。有未保存的修改时关闭窗口（Esc、点击遮罩或关闭按钮）会先询问是否保存。超过 512 KB 只显示了开头部分的文件、二进制文件和图片不能编辑。
- **协议 1.8**（向后兼容）：另新增仅限本地连接的 `workspace.writeFile`，用文本覆盖工作区中一个已存在的文件（不会新建文件，只能写入工作区内的路径），可以带上读取时的 `modifiedAt`，文件已被修改时返回 `CONFLICT`。旧版 Host 上保存时提示需要更新 Pier。

### 变更

- **桌面端界面焕新**：界面文字改用内置的 Inter 字体（中文仍使用系统字体），圆角、阴影和配色层次重新调整，面板顶部增加细微高光，窗口背景带有淡淡的品牌色光晕；输入框聚焦时显示品牌渐变描边，发送按钮、「新建会话」按钮和空状态标题使用品牌渐变；侧边栏选中的会话在树线上显示高亮条；下拉菜单和通知改为半透明毛玻璃效果。收起和展开左侧边栏时有平滑的过渡动画。

## v0.2.5 — 2026-09-29

新增文件预览与输入框中的文件标签，桌面端侧边栏可以收起；从云链API 导入的模型会按站点报告的接口自动选择 Anthropic Messages、Responses 或 Chat Completions，个人中心只列出已配置的分组。

### 新增

- **收起左侧边栏**：桌面端侧边栏顶部「Pier」右侧新增收起按钮，也可以按 Ctrl/⌘+B；收起后会话标题栏左侧（以及工作区首页、新建会话页左上角）显示展开按钮。开关状态会被记住。
- **预览工作区文件**：桌面端右侧文件面板中单击文件即可查看内容（双击仍然把路径插入输入框）。文本文件显示行号并按扩展名高亮，Markdown 可以在渲染预览和源码之间切换，常见图片格式直接显示；超过 512 KB 的文本只显示开头部分，二进制文件和超过 8 MB 的图片会给出提示。预览窗口可以复制内容、复制路径、把路径插入输入框或重新读取。私钥（`id_ed25519` 等）、`.env`、`*.pem`/`*.key`、`.netrc` 这类可能包含凭据的文件，需要先确认「仍然显示」才会读取。
- **协议 1.7**（向后兼容）：新增 `workspace.readFile`，读取工作区中的一个文件（只能访问工作区内的路径）。旧版 Host 上，预览窗口提示需要更新 Pier。
- **文件标签**：从文件面板双击文件（或点击行尾按钮、预览窗口中的「插入路径」）后，输入框中插入的不再是纯文本路径，而是显示文件名的标签：点击标签打开文件预览，悬停可查看完整路径；可以用标签上的 × 或退格键整体删除，和文字一样可以在任意位置插入、换行。发送时标签会替换为相对工作区的路径，Agent 收到的内容与之前一致；草稿切换会话后仍然保留标签。

### 变更

- **NewAPI 模型自动选择接口**：从云链API（一键登录或个人中心「配置到本地」）导入模型时，Pier 会按站点报告的各模型支持的接口（NewAPI 的 `supported_endpoint_types`）选择调用方式：Claude 模型改用 Anthropic Messages（`/v1/messages`），只提供 Responses 的模型（如 Codex 渠道）用 OpenAI Responses，其他模型仍用 Chat Completions；不报告接口的旧版站点按名称识别 Claude 模型。服务商仍按原来的接口类型保存，只有需要不同接口的模型单独记录接口，Base URL 自动换算。已经导入的服务商，再次点「更新本地配置」或重新登录即可生效。自定义接口的模型列表新增「接口」列，可以为单个模型指定接口（「默认」跟随服务商）；对 NewAPI 站点点「从接口获取」时也会自动识别。
- **协议 1.7**（向后兼容）：`CustomModel` 新增可选的 `api`；`newapi.useToken`、`account.useToken`、`newapi.authorizeWait` 返回的模型带上识别出的 `api`。
- **个人中心只列出已配置的分组**：「分组与令牌」默认只显示已配置到本地的分组，不再一次列出账号的全部分组；点右上角「添加分组」从下拉框中选择要使用的分组，加入列表后再选择令牌并「配置到本地」。还没配置的分组可以点 × 移除。

## v0.2.4 — 2026-09-29

新增云链API 个人中心与一键登录、斜杠命令、右侧文件面板和删除会话，自动识别中转模型的推理等能力，并改用 Bun 管理依赖。

### 新增

- **个人中心**：「设置」最上方新增「账号 → 个人中心」，直连云链API：
  - 在 Pier 中直接用账号密码登录（支持两步验证）或注册（支持邮箱验证码和邀请码）；用 GitHub、LinuxDO 等第三方账号登录的用户可以用系统访问令牌登录。「忘记密码」「在网页上注册」会在浏览器中打开对应页面。
  - 登录后显示当前余额、历史消耗和请求次数（按站点设置显示为美元、人民币或额度），「充值」「网页控制台」「管理令牌」在浏览器中打开对应页面。
  - 按分组列出令牌和倍率。选择分组的令牌（或直接新建令牌），点「配置到本地」，Pier 会读取这个令牌可用的全部模型，保存为服务商「云链API · 分组」；再次点击「更新本地配置」会同步新的模型，已有的模型设置保留。「模型与服务商」中这些服务商显示「个人中心」按钮。
  - 登录由 Pier Host 保存（`~/.pier/account.json`，仅当前用户可读），重启后仍然有效，30 天后需要重新登录；只保存站点的刷新凭据，不保存密码，访问令牌过期时自动续期。令牌密钥不会显示在界面上。
- **自动识别模型能力**：从云链API、NewAPI 或自定义接口导入的模型，不再全部被当成不支持思考的普通模型。Pier 会按 pi 内置的模型目录识别推理、图片输入、上下文和最大输出长度，所以 `claude-opus-4-5`、`gpt-5`、`gemini-2.5-pro` 这类模型导入后，模型选择器里就会显示思考等级，不需要再手动勾选「推理」。带厂商前缀、日期后缀、`4.5`/`4-5` 等不同写法，以及 `-thinking` 变体都能识别；目录中没有的模型只按常见推理系列的名称推断，其他保持原样。已经配置过的服务商会在 Pier 启动时自动补全缺少的设置；手动修改过的设置保持不变，取消勾选的「推理」也会被记住。修改服务商配置后，已打开的会话会立即使用新的模型设置，不需要重新选择模型；模型刚变成推理模型时，思考等级会从「不思考」改为默认等级。
- **协议 1.6**（向后兼容）：新增仅限本地连接的 `account.status` / `login` / `verify` / `sendCode` / `register` / `overview` / `createToken` / `useToken` / `logout`。新增 `session.delete`（删除会话并把文件移到 Pier 回收站），`session.closed` 新增 `reason: "deleted"`。`provider.probeModels` 返回的模型会带上 pi 模型目录中的能力信息。NewAPI 登录会话的访问令牌过期后也会自动续期，不再在 15 分钟后失效。
- **斜杠命令**：桌面端和手机端的输入框中输入 `/` 会弹出命令菜单，可以按名称或说明过滤，桌面端支持 ↑↓ 选择、Enter 执行、Tab 补全、Esc 关闭。菜单列出 Pier 内置命令和当前会话可用的 pi 命令（扩展命令、提示词模板与 `/skill:<名称>`）：
  - `/new` 新建会话、`/model` 切换模型、`/thinking` 设置思考等级、`/compact [摘要要点]` 压缩上下文、`/fork` 从历史消息分叉、`/name <名称>` 重命名会话、`/reload` 重新加载扩展、skills、提示词模板与上下文文件。`/model`、`/thinking`、`/fork` 在菜单里直接列出可选的模型、等级和历史消息。
  - 扩展命令在 Agent 运行时也可以执行；需要回答对话框的扩展命令不再让输入框一直等待。
  - 无法识别的命令会提示“未知命令”，不再原样发给模型；`/usr/bin` 这类路径仍按普通消息发送。
- **云链API 服务商**：「设置 → 模型与服务商 → 添加服务商」的第一项改为内置的「云链API」（`api.yunnet.top`），点「浏览器登录」即可：Pier 在浏览器中打开云链API 的授权页面，用任意方式登录并点击「授权」后，自动保存令牌和全部可用模型，不需要填写站点地址、选择令牌或确认表单。已添加后，在已配置列表中点「重新登录」可以更新令牌和模型列表，已有的模型设置会保留。没有可用模型时，首页提示也提供「登录云链API」。
- **缓存命中率**：桌面端会话底部状态栏新增「缓存命中 xx%」，按本会话累计的缓存读取 token ÷ 输入 token（含缓存读写）计算；悬停可查看缓存读取、缓存写入与输入合计。模型未返回任何输入用量时不显示。
- **右侧文件面板**：桌面端会话标题栏右上角（以及工作区首页和新建会话页右上角）新增「文件」按钮，也可以按 Ctrl/⌘+Shift+E，在右侧打开当前工作区的文件树：目录在前，按需逐级展开，不显示 `.git` 等版本库目录；悬停可查看大小与修改时间。双击文件或点击行尾按钮可以把相对路径插入到输入框的光标处，也可以复制相对路径。Agent 运行结束、窗口重新获得焦点或点击刷新时自动更新。面板宽度可以拖动左边缘调整（双击恢复默认），开关状态和宽度会被记住。
- **删除会话**：桌面端侧栏中鼠标悬停在会话上会出现删除按钮，再点一次确认即可删除；会话标题栏的「更多操作」菜单也新增「删除会话」。手机端可以在会话列表中长按会话，或在会话页的菜单中删除。正在运行的会话会先中止再删除。会话文件不会被直接抹掉，而是移到电脑上的 `~/.pier/trash/sessions`，需要时可以手动移回 pi 的会话目录恢复。
- **协议 1.5**（向后兼容）：新增 `session.commands`（列出会话的斜杠命令）、`session.reload`，以及列出工作区目录的 `workspace.files`（只能访问工作区内的路径）。旧版 Host 上，客户端仍提供内置命令，其他命令照常发送；文件面板提示需要更新。

### 变更

- **新建会话先选工作区**：桌面端点「新建会话」（侧栏按钮、工作区行的 `+`、工作区首页按钮或 `/new`）会打开空白的新对话页面，显示「我们应该在〈工作区〉中做些什么？」；输入框下方的工作区芯片可以切换工作区或添加新的工作区，也可以直接调整该工作区的审批策略、附加图片。发送第一条消息时才在所选工作区中创建会话并切换过去继续对话，只打开不发送不会留下空会话；草稿在离开页面后保留。
- **不再单独发布 Pier Host**：Pier Host 已内置在桌面端安装包中，无需单独下载安装，GitHub Release 不再附带 `pier-host-v<版本>-<系统>-<架构>` 压缩包。发版流水线改为直接冒烟测试各平台安装包内置的 sidecar。需要单独运行 Host 时，可以按 README 用 `bun run build:sidecar` 从源码构建。
- **改用 Bun 管理依赖**：仓库从 pnpm 换成 Bun workspaces（`bun.lock`，`bunfig.toml` 保持 hoisted 布局以兼容 Expo/Metro），开发只需 Node 与 Bun，不再需要 pnpm / Corepack；README 中的命令相应改为 `bun install`、`bun run …`。CI 与发版流水线同步改用 Bun，Bun 版本由 `package.json` 的 `packageManager` 固定。
- **移除通用的「NewAPI 登录」**：「添加服务商」不再单独提供 NewAPI 登录按钮和账号密码 / 访问令牌登录对话框，改为上面的「云链API」服务商；其他 NewAPI 中转站可以用「自定义接口」填写 Base URL 和 API Key。Host 的 `newapi.*` 协议方法保持不变。

### 修复

- **macOS 程序坞图标偏小**：桌面端图标按 macOS 图标网格重新生成（1024 画布中 824 的圆角方块，四周留 100 像素透明边距）。此前图标几乎铺满画布，macOS 26 会把它当成不规范的图标，缩小后放进浅灰色底板里，看起来比其他应用的图标小一圈。Windows 图标保持不变。
- **发送消息后回复区域一片空白**：模型开始回复但还没有输出可见内容时（尤其是开启思考、服务商只回传空的或加密的思考块时），桌面端和手机端的「正在输入」动画会立刻消失，直到正文开始输出前都是空白。现在正在进行的思考块会显示为「思考中…」，回复还没有任何可见内容时继续显示「正在输入」动画。

## v0.2.3 — 2026-09-29

新增 NewAPI 浏览器授权登录，macOS 安装包改为本机签名，不再提示“已损坏”。

### 新增

- **NewAPI 浏览器授权**：「NewAPI 登录」新增并默认选中「浏览器授权」。填写站点地址后，Pier 会在浏览器中打开站点的授权页面，用站点支持的任意方式登录（包括 GitHub、LinuxDO、Passkey 等第三方或无密码登录）并确认后，站点为 Pier 新建一个令牌，Pier 自动读取模型并预填自定义接口，全程不需要在 Pier 中输入密码或复制访问令牌。需要站点使用支持「应用授权」的 NewAPI 并由管理员开启；其他站点仍可用账号密码或访问令牌登录。对话框会记住上次使用的站点地址。
- **协议 1.4**（向后兼容）：新增仅限本地连接的 `newapi.authorizeStart` / `authorizeWait` / `authorizeCancel`（RFC 8252 回环重定向 + PKCE）。

### 修复

- **macOS 安装包不再提示“已损坏”**：macOS 安装包之前完全未签名，从浏览器下载后打开会被误报为“已损坏，无法打开”，只能在终端里移除隔离属性。现在安装包改为本机签名（ad-hoc，含 Pier Host sidecar，启用 hardened runtime 并授予 Bun 所需的 JIT 权限），首次打开时 macOS 改为提示“无法验证开发者”，在「系统设置 → 隐私与安全性」中点「仍要打开」即可。发版流水线会校验签名并在签名后的 `.app` 中冒烟测试 sidecar。仍未进行 Apple 公证。
- **可以移除 `models.json` 中的密钥**：内置服务商（如 DeepSeek）的密钥直接写在 `models.json` 的 `apiKey` 里（明文或 `!命令`）时，「设置 → 模型与服务商」之前既不显示「删除」也不显示「移除密钥」，只能手动改文件。现在这类服务商也会显示「移除密钥」，Pier 只删除该条目的 `apiKey`，其他覆盖配置保留；条目只剩名称时整项删除。`provider.logout` 在没有 `auth.json` 凭据时会删除这类密钥，环境变量不受影响。

## v0.2.2 — 2026-09-29

支持直接登录 NewAPI 中转站配置模型，桌面端新增设置界面，并开始提供 Android 安装包。

### 新增

- **NewAPI 登录**：「设置 → 模型与服务商」新增「NewAPI 登录」。填写站点地址，用账号密码（支持两步验证和站点开启的登录密码加密）或系统访问令牌登录后，选择一个令牌或直接新建（可选分组），Pier 会读取它可用的模型列表，并预填名称、Base URL 和全部模型，确认后保存为自定义接口。令牌密钥由 Pier Host 直接读取并保存到 pi 的 `auth.json`，不会出现在界面或协议消息中；登录会话只在内存中保留，关闭对话框即退出。同时兼容新版本的访问令牌登录和旧版本的 Cookie 会话。
- **协议 1.3**（向后兼容）：新增仅限本地连接的 `newapi.login` / `verify` / `createToken` / `useToken` / `close`；`provider.saveCustom` 与 `provider.probeModels` 新增 `apiKeyRef` 参数。
- **Android 安装包**：GitHub Release 开始附带签名的 Android APK（`pier-mobile-v<版本>-android.apk`，包含 arm64-v8a / armeabi-v7a / x86_64），可以直接下载安装手机端；之后的版本可以覆盖升级。

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
