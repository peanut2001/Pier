//! Pier Host sidecar lifecycle: spawn, readiness, logs, crash restart, and shutdown.
//!
//! The host prints exactly one JSON line on stdout once it listens:
//! `{"type":"pier.ready","url":"ws://127.0.0.1:<port>","port":…,"token":"…","pid":…,"version":"…","protocolVersion":"1.0"}`
//! and logs to stderr. It runs with `--watch-stdin`, so it shuts down gracefully when its
//! stdin closes — including when this process dies unexpectedly.
//!
//! The same pipes carry the shell channel (`packages/host/src/shell.ts`), so paired computers
//! can drive this app's updater through the host: the host asks with
//! `{"type":"pier.shell.request","id":…,"method":"update.check"|"update.install"}` on stdout,
//! and this side answers with `pier.shell.response` lines and pushes every updater status as
//! `{"type":"pier.shell.updateStatus","status":{…}}` on stdin.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::updater::{UpdateManager, UpdateStatus};

pub const STATUS_EVENT: &str = "pier://host-status";
pub const LOG_EVENT: &str = "pier://host-log";

const SHELL_REQUEST: &str = "pier.shell.request";
const SHELL_RESPONSE: &str = "pier.shell.response";
const SHELL_UPDATE_STATUS: &str = "pier.shell.updateStatus";

const MAX_LOG_LINES: usize = 2000;
/// A cold first start of the Bun binary takes a few seconds; leave generous headroom.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// A run that lasted this long resets the crash-loop counter.
const STABLE_AFTER: Duration = Duration::from_secs(60);
/// Consecutive short-lived runs before giving up and waiting for a manual restart.
const MAX_FAST_FAILURES: u32 = 5;
const POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostState {
    Starting,
    Ready,
    Restarting,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub state: HostState,
    pub url: Option<String>,
    pub token: Option<String>,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub protocol_version: Option<String>,
    /// Why the previous run ended, or why the host could not start.
    pub error: Option<String>,
    /// Automatic restarts since the app started.
    pub restarts: u32,
    /// Increments on every spawn; lets the UI tell host instances apart.
    pub generation: u64,
}

struct Inner {
    status: HostStatus,
    child: Option<Child>,
    /// Lines for the host's stdin, written by a per-host thread so a stuck host cannot block
    /// the shell. Dropping it closes stdin (the host's graceful-shutdown signal).
    stdin: Option<SyncSender<String>>,
    logs: VecDeque<String>,
    shutting_down: bool,
    fast_failures: u32,
    started_at: Option<Instant>,
}

#[derive(Clone)]
pub struct HostManager {
    app: AppHandle,
    inner: Arc<Mutex<Inner>>,
}

impl HostManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Arc::new(Mutex::new(Inner {
                status: HostStatus {
                    state: HostState::Stopped,
                    url: None,
                    token: None,
                    pid: None,
                    version: None,
                    protocol_version: None,
                    error: None,
                    restarts: 0,
                    generation: 0,
                },
                child: None,
                stdin: None,
                logs: VecDeque::new(),
                shutting_down: false,
                fast_failures: 0,
                started_at: None,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock must not take the whole shell down.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> HostStatus {
        self.lock().status.clone()
    }

    pub fn logs(&self) -> Vec<String> {
        self.lock().logs.iter().cloned().collect()
    }

    fn emit_status(&self) {
        let status = self.status();
        if let Some(tray) = self.app.tray_by_id(crate::tray::TRAY_ID) {
            let label = match status.state {
                HostState::Starting => "正在启动 Host…",
                HostState::Ready => "Host 运行中",
                HostState::Restarting => "Host 正在重启…",
                HostState::Failed => "Host 启动失败",
                HostState::Stopped => "Host 已停止",
            };
            let _ = tray.set_tooltip(Some(format!("Pier · {label}")));
        }
        let _ = self.app.emit(STATUS_EVENT, status);
    }

    fn push_log(&self, line: String) {
        {
            let mut inner = self.lock();
            if inner.logs.len() >= MAX_LOG_LINES {
                inner.logs.pop_front();
            }
            inner.logs.push_back(line.clone());
        }
        let _ = self.app.emit(LOG_EVENT, line);
    }

    /// Start the host (no-op while one is running or starting).
    pub fn start(&self) {
        {
            let inner = self.lock();
            if inner.shutting_down || inner.child.is_some() {
                return;
            }
        }
        self.spawn();
    }

    fn spawn(&self) {
        let generation = {
            let mut inner = self.lock();
            inner.status.generation += 1;
            inner.status.state = HostState::Starting;
            inner.status.url = None;
            inner.status.token = None;
            inner.status.pid = None;
            inner.status.generation
        };
        self.emit_status();

        let mut command = match self.command() {
            Ok(command) => command,
            Err(error) => {
                self.push_log(format!("[pier] {error}"));
                self.on_exit(generation, error);
                return;
            }
        };
        match command.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                let stdin = child.stdin.take().map(stdin_writer);
                let pid = child.id();
                {
                    let mut inner = self.lock();
                    inner.child = Some(child);
                    inner.stdin = stdin;
                    inner.started_at = Some(Instant::now());
                    inner.status.pid = Some(pid);
                }
                self.push_log(format!(
                    "[pier] Host 进程已启动（pid {pid}，第 {generation} 次）"
                ));
                if let Some(stdout) = stdout {
                    let manager = self.clone();
                    thread::spawn(move || manager.read_stdout(generation, stdout));
                }
                if let Some(stderr) = stderr {
                    let manager = self.clone();
                    thread::spawn(move || manager.read_stderr(stderr));
                }
                let manager = self.clone();
                thread::spawn(move || manager.watch(generation));
            }
            Err(error) => {
                let message = format!("无法启动 Pier Host：{error}");
                self.push_log(format!("[pier] {message}"));
                self.on_exit(generation, message);
            }
        }
    }

    fn command(&self) -> Result<Command, String> {
        let exe = sidecar_path()?;
        if !exe.exists() {
            return Err(format!(
                "找不到 Pier Host 可执行文件 {}（开发时先运行 `bun run --cwd apps/desktop sidecar`）",
                exe.display()
            ));
        }
        let mut command = Command::new(&exe);
        command
            .arg("--watch-stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if std::env::var_os("PI_PACKAGE_DIR").is_none() {
            if let Some(assets) = self.pi_assets_dir() {
                command.env("PI_PACKAGE_DIR", assets);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        Ok(command)
    }

    /// Bundled pi runtime assets (see `scripts/prepare-sidecar.mjs`).
    fn pi_assets_dir(&self) -> Option<PathBuf> {
        let dir = self.app.path().resource_dir().ok()?.join("pi-assets");
        dir.join("package.json").exists().then_some(dir)
    }

    fn read_stdout(&self, generation: u64, stdout: impl Read) {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !self.try_ready(generation, &line) && !self.try_shell_request(&line) {
                self.push_log(line);
            }
        }
    }

    fn try_ready(&self, generation: u64, line: &str) -> bool {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("pier.ready") {
            return false;
        }
        let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
        let version = text("version");
        let url = text("url");
        {
            let mut inner = self.lock();
            if inner.status.generation != generation || inner.status.state != HostState::Starting {
                return true;
            }
            inner.status.state = HostState::Ready;
            inner.status.url = url.clone();
            inner.status.token = text("token");
            inner.status.version = version.clone();
            inner.status.protocol_version = text("protocolVersion");
            inner.status.error = None;
        }
        self.push_log(format!(
            "[pier] Host 已就绪：{}（v{}）",
            url.unwrap_or_default(),
            version.unwrap_or_default()
        ));
        self.emit_status();
        if let Some(updates) = self.app.try_state::<UpdateManager>() {
            self.send_update_status(&updates.status());
        }
        true
    }

    /// Write one line to the host's stdin (the shell channel). Dropped while no host runs or
    /// when the host stopped reading.
    fn send_shell(&self, message: &Value) {
        let inner = self.lock();
        if let Some(stdin) = inner.stdin.as_ref() {
            let _ = stdin.try_send(format!("{message}\n"));
        }
    }

    /// Tell the host about the updater's state (it relays it to its clients).
    pub fn send_update_status(&self, status: &UpdateStatus) {
        self.send_shell(&json!({ "type": SHELL_UPDATE_STATUS, "status": status }));
    }

    /// Handle a `pier.shell.request` line from the host: drive the updater and answer.
    fn try_shell_request(&self, line: &str) -> bool {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if value.get("type").and_then(Value::as_str) != Some(SHELL_REQUEST) {
            return false;
        }
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(updates) = self.app.try_state::<UpdateManager>() else {
            self.send_shell(&json!({
                "type": SHELL_RESPONSE, "id": id, "ok": false, "error": "更新服务尚未就绪"
            }));
            return true;
        };
        let updates = updates.inner().clone();
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = match method.as_str() {
                "update.check" => {
                    manager.push_log("[pier] 远程请求：检查更新".into());
                    Ok(updates.check().await)
                }
                "update.install" => {
                    manager.push_log("[pier] 远程请求：安装更新".into());
                    Ok(updates.install_latest().await)
                }
                other => Err(format!("未知的请求 {other}")),
            };
            let response = match result {
                Ok(status) => {
                    json!({ "type": SHELL_RESPONSE, "id": id, "ok": true, "result": status })
                }
                Err(error) => {
                    json!({ "type": SHELL_RESPONSE, "id": id, "ok": false, "error": error })
                }
            };
            manager.send_shell(&response);
        });
        true
    }

    fn read_stderr(&self, stderr: impl Read) {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            self.push_log(line);
        }
    }

    /// Poll the child until it exits (or is replaced), enforcing the readiness timeout.
    fn watch(&self, generation: u64) {
        loop {
            thread::sleep(POLL_INTERVAL);
            let mut inner = self.lock();
            if inner.status.generation != generation {
                return;
            }
            let starting_too_long = inner.status.state == HostState::Starting
                && inner
                    .started_at
                    .is_some_and(|t| t.elapsed() > READY_TIMEOUT);
            let Some(child) = inner.child.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    drop(inner);
                    self.on_exit(generation, format!("Pier Host 已退出（{status}）"));
                    return;
                }
                Ok(None) if starting_too_long => {
                    let _ = child.kill();
                    drop(inner);
                    self.push_log(format!(
                        "[pier] Host 在 {} 秒内未就绪，已终止",
                        READY_TIMEOUT.as_secs()
                    ));
                }
                Ok(None) => {}
                Err(error) => {
                    drop(inner);
                    self.on_exit(generation, format!("无法获取 Host 进程状态：{error}"));
                    return;
                }
            }
        }
    }

    fn on_exit(&self, generation: u64, reason: String) {
        let delay = {
            let mut inner = self.lock();
            if inner.status.generation != generation {
                return;
            }
            inner.child = None;
            inner.stdin = None;
            inner.status.url = None;
            inner.status.token = None;
            inner.status.pid = None;
            if inner.shutting_down {
                inner.status.state = HostState::Stopped;
                None
            } else {
                let stable = inner
                    .started_at
                    .is_some_and(|t| t.elapsed() >= STABLE_AFTER);
                inner.fast_failures = if stable { 1 } else { inner.fast_failures + 1 };
                inner.status.error = Some(reason.clone());
                if inner.fast_failures >= MAX_FAST_FAILURES {
                    inner.status.state = HostState::Failed;
                    None
                } else {
                    inner.status.state = HostState::Restarting;
                    inner.status.restarts += 1;
                    Some(Duration::from_secs(1 << (inner.fast_failures - 1).min(5)))
                }
            }
        };
        self.push_log(format!("[pier] {reason}"));
        self.emit_status();
        if let Some(delay) = delay {
            self.push_log(format!("[pier] {} 秒后自动重启", delay.as_secs()));
            let manager = self.clone();
            thread::spawn(move || {
                thread::sleep(delay);
                let should_spawn = {
                    let inner = manager.lock();
                    !inner.shutting_down
                        && inner.status.generation == generation
                        && inner.status.state == HostState::Restarting
                };
                if should_spawn {
                    manager.spawn();
                }
            });
        }
    }

    /// Stop the current host (gracefully) and start a new one. Blocks up to the shutdown grace period.
    pub fn restart(&self) {
        let (child, stdin) = {
            let mut inner = self.lock();
            if inner.shutting_down {
                return;
            }
            inner.fast_failures = 0;
            inner.status.error = None;
            // Bump the generation so watchers of the old process stand down.
            inner.status.generation += 1;
            (inner.child.take(), inner.stdin.take())
        };
        self.push_log("[pier] 正在重启 Host…".into());
        stop_child(child, stdin);
        self.spawn();
    }

    /// Stop the host for good (app exit). Blocks up to the shutdown grace period.
    pub fn shutdown(&self) {
        self.stop(None);
    }

    /// Stop the host while an update is installed, reporting `reason` to the UI.
    /// The host stays down until [`Self::resume`] (install failed) or the app restarts.
    pub fn suspend(&self, reason: &str) {
        self.push_log(format!("[pier] {reason}"));
        self.stop(Some(reason.to_string()));
    }

    /// Start the host again after [`Self::suspend`].
    pub fn resume(&self) {
        {
            let mut inner = self.lock();
            if !inner.shutting_down {
                return;
            }
            inner.shutting_down = false;
            inner.fast_failures = 0;
            inner.status.error = None;
        }
        self.start();
    }

    fn stop(&self, reason: Option<String>) {
        let (child, stdin) = {
            let mut inner = self.lock();
            if inner.shutting_down {
                return;
            }
            inner.shutting_down = true;
            inner.status.state = HostState::Stopped;
            inner.status.url = None;
            inner.status.token = None;
            inner.status.pid = None;
            inner.status.generation += 1;
            if reason.is_some() {
                inner.status.error = reason.clone();
            }
            (inner.child.take(), inner.stdin.take())
        };
        // On app exit the UI is going away; only report a suspension.
        if reason.is_some() {
            self.emit_status();
        }
        stop_child(child, stdin);
    }
}

/// Own the host's stdin on a thread that writes the queued lines; stdin closes once the
/// sender is dropped (or the host stops reading and the pipe breaks).
fn stdin_writer(mut stdin: ChildStdin) -> SyncSender<String> {
    let (sender, receiver) = sync_channel::<String>(256);
    thread::spawn(move || {
        for line in receiver {
            if stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.flush())
                .is_err()
            {
                break;
            }
        }
    });
    sender
}

/// Close stdin (the host's graceful-shutdown signal), wait, then kill if needed.
fn stop_child(child: Option<Child>, stdin: Option<SyncSender<String>>) {
    drop(stdin);
    let Some(mut child) = child else { return };
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The sidecar sits next to the app executable (Tauri strips the target-triple suffix
/// from `externalBin` when bundling and in dev builds). `PIER_HOST_BIN` overrides it.
fn sidecar_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PIER_HOST_BIN") {
        return Ok(PathBuf::from(path));
    }
    let exe = std::env::current_exe().map_err(|e| format!("无法定位应用路径：{e}"))?;
    let dir = exe.parent().ok_or_else(|| "无法定位应用目录".to_string())?;
    Ok(dir.join(if cfg!(windows) {
        "pier-host.exe"
    } else {
        "pier-host"
    }))
}

#[tauri::command]
pub fn host_status(manager: tauri::State<'_, HostManager>) -> HostStatus {
    manager.status()
}

#[tauri::command]
pub fn host_logs(manager: tauri::State<'_, HostManager>) -> Vec<String> {
    manager.logs()
}

#[tauri::command]
pub fn host_restart(manager: tauri::State<'_, HostManager>) {
    let manager = manager.inner().clone();
    thread::spawn(move || manager.restart());
}
