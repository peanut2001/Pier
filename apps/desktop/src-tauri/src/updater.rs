//! In-app updates through the Tauri updater plugin.
//!
//! Pier checks the `latest.json` manifest attached to the newest GitHub release (see
//! `.github/workflows/release.yml`), shortly after launch and then every few hours while it
//! runs in the tray. The user decides when to install: installing downloads the signed
//! bundle, verifies it against the public key in `tauri.conf.json`, stops the Pier Host (so
//! no agent is cut off halfway through writing a file and the Windows installer can replace
//! the sidecar), installs, and relaunches Pier.
//!
//! Paired computers and phones can drive the same flow through the Pier Host (`update.*` in
//! the protocol, relayed over the sidecar's stdio by `host.rs`); every status change is also
//! pushed to the host.
//!
//! Development builds and unpackaged binaries cannot update themselves; their state is
//! `unsupported`. `PIER_UPDATER_ENDPOINT` points a packaged build at another manifest (for
//! testing); signatures are still verified against the built-in public key.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::host::HostManager;
use crate::update_route::{download_url, normalize_mirror};

pub const STATUS_EVENT: &str = "pier://update-status";
/// Asks the UI to show the update dialog (from the tray menu).
pub const OPEN_EVENT: &str = "pier://update-open";

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const SCHEDULER_TICK: Duration = Duration::from_secs(15);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const SETTINGS_FILE: &str = "updater.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    /// Development build or unpackaged binary.
    Unsupported,
    /// Not checked yet.
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
    /// The last check, download, or install failed (`error`). If `version` is set, the
    /// update is still pending and installing can be retried.
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub current_version: String,
    pub auto_check: bool,
    /// Empty for GitHub direct; otherwise an HTTPS acceleration prefix.
    pub mirror_prefix: String,
    /// The available update.
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    /// Unix time (ms) of the last successful check.
    pub last_checked: Option<u64>,
    /// Installing asks for an administrator password on this computer (Linux .deb / .rpm).
    pub install_needs_auth: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    auto_check: bool,
    #[serde(default)]
    mirror_prefix: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_check: true,
            mirror_prefix: String::new(),
        }
    }
}

struct Inner {
    status: UpdateStatus,
    pending: Option<Update>,
    tray_item: Option<MenuItem<Wry>>,
    next_auto_check: Instant,
    next_check_id: u64,
    checking: Option<CheckOperation>,
}

struct CheckOperation {
    id: u64,
    previous_state: UpdateState,
    abort: Option<tokio::task::AbortHandle>,
}

impl Inner {
    fn cancel_check(&mut self) {
        if let Some(check) = self.checking.take() {
            if let Some(abort) = check.abort {
                abort.abort();
            }
            self.status.state = check.previous_state;
        }
    }

    fn finish_check(&mut self, id: u64, result: Result<Option<Update>, String>) {
        if self.checking.as_ref().map(|check| check.id) != Some(id) {
            return;
        }
        self.checking = None;
        let status = &mut self.status;
        match result {
            Ok(Some(update)) => {
                status.state = UpdateState::Available;
                status.version = Some(update.version.clone());
                status.notes = update.body.clone().filter(|notes| !notes.trim().is_empty());
                status.date = update
                    .raw_json
                    .get("pub_date")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                status.downloaded = 0;
                status.total = None;
                status.error = None;
                status.last_checked = Some(now_ms());
                self.pending = Some(update);
            }
            Ok(None) => {
                self.pending = None;
                status.state = UpdateState::UpToDate;
                status.version = None;
                status.notes = None;
                status.date = None;
                status.error = None;
                status.last_checked = Some(now_ms());
            }
            Err(error) => {
                self.pending = None;
                status.state = UpdateState::Error;
                status.version = None;
                status.notes = None;
                status.date = None;
                status.error = Some(format!("检查更新失败：{error}"));
            }
        }
    }
}

#[derive(Clone)]
pub struct UpdateManager {
    app: AppHandle,
    inner: Arc<Mutex<Inner>>,
}

/// Packaged release builds only: a dev binary would overwrite itself (or its target dir).
fn supported() -> bool {
    !cfg!(debug_assertions) && tauri::utils::platform::bundle_type().is_some()
}

/// The updater installs .deb / .rpm packages through pkexec or sudo, which prompt for a password.
fn install_needs_auth() -> bool {
    use tauri::utils::config::BundleType;
    matches!(
        tauri::utils::platform::bundle_type(),
        Some(BundleType::Deb | BundleType::Rpm)
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

impl UpdateManager {
    pub fn new(app: AppHandle) -> Self {
        let settings = load_settings(&app);
        let state = if supported() {
            UpdateState::Idle
        } else {
            UpdateState::Unsupported
        };
        let status = UpdateStatus {
            state,
            current_version: app.package_info().version.to_string(),
            auto_check: settings.auto_check,
            mirror_prefix: normalize_mirror(&settings.mirror_prefix).unwrap_or_default(),
            version: None,
            notes: None,
            date: None,
            downloaded: 0,
            total: None,
            error: None,
            last_checked: None,
            install_needs_auth: supported() && install_needs_auth(),
        };
        Self {
            app,
            inner: Arc::new(Mutex::new(Inner {
                status,
                pending: None,
                tray_item: None,
                next_auto_check: Instant::now() + FIRST_CHECK_DELAY,
                next_check_id: 0,
                checking: None,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> UpdateStatus {
        self.lock().status.clone()
    }

    pub fn set_tray_item(&self, item: MenuItem<Wry>) {
        self.lock().tray_item = Some(item);
        self.refresh_tray();
    }

    fn update(&self, change: impl FnOnce(&mut UpdateStatus)) {
        {
            let mut inner = self.lock();
            change(&mut inner.status);
        }
        self.refresh_tray();
        let status = self.status();
        if let Some(host) = self.app.try_state::<HostManager>() {
            host.send_update_status(&status);
        }
        let _ = self.app.emit(STATUS_EVENT, status);
    }

    fn refresh_tray(&self) {
        let (item, status) = {
            let inner = self.lock();
            (inner.tray_item.clone(), inner.status.clone())
        };
        let Some(item) = item else { return };
        let label = match (status.state, status.version.as_deref()) {
            (UpdateState::Available | UpdateState::Error, Some(version)) => {
                format!("安装更新 v{version}…")
            }
            (UpdateState::Downloading, _) => "正在下载更新…".to_string(),
            (UpdateState::Installing, _) => "正在安装更新…".to_string(),
            _ => "检查更新…".to_string(),
        };
        let _ = item.set_text(label);
        let _ = item.set_enabled(status.state != UpdateState::Unsupported);
    }

    /// Show the window and the update dialog (tray menu).
    pub fn open(&self) {
        crate::show_main_window(&self.app);
        let _ = self.app.emit(OPEN_EVENT, ());
    }

    pub fn set_auto_check(&self, enabled: bool) -> Result<UpdateStatus, String> {
        {
            let mut inner = self.lock();
            save_settings(
                &self.app,
                &Settings {
                    auto_check: enabled,
                    mirror_prefix: inner.status.mirror_prefix.clone(),
                },
            )?;
            inner.status.auto_check = enabled;
            if !enabled {
                inner.cancel_check();
            }
        }
        self.update(|_| {});
        Ok(self.status())
    }

    pub fn set_mirror(&self, prefix: &str) -> Result<UpdateStatus, String> {
        let prefix = normalize_mirror(prefix)?;
        {
            let mut inner = self.lock();
            if matches!(
                inner.status.state,
                UpdateState::Downloading | UpdateState::Installing
            ) {
                return Err("请等待当前更新操作结束后再切换线路".into());
            }
            save_settings(
                &self.app,
                &Settings {
                    auto_check: inner.status.auto_check,
                    mirror_prefix: prefix.clone(),
                },
            )?;
            inner.cancel_check();
            inner.status.mirror_prefix = prefix;
        }
        self.update(|_| {});
        Ok(self.status())
    }

    pub fn cancel_check(&self) -> UpdateStatus {
        self.lock().cancel_check();
        self.update(|_| {});
        self.status()
    }

    /// Check the release manifest. Concurrent checks and checks during an install are no-ops.
    pub async fn check(&self) -> UpdateStatus {
        let id = {
            let mut inner = self.lock();
            match inner.status.state {
                UpdateState::Unsupported
                | UpdateState::Checking
                | UpdateState::Downloading
                | UpdateState::Installing => return inner.status.clone(),
                _ => {}
            }
            inner.next_check_id = inner.next_check_id.wrapping_add(1);
            let id = inner.next_check_id;
            inner.checking = Some(CheckOperation {
                id,
                previous_state: inner.status.state,
                abort: None,
            });
            inner.status.state = UpdateState::Checking;
            inner.next_auto_check = Instant::now() + CHECK_INTERVAL;
            id
        };
        self.update(|_| {});

        let result = match self.updater() {
            Ok(updater) => {
                let task = tauri::async_runtime::spawn(async move {
                    // Bound the whole check, including DNS, redirects and the response body.
                    tokio::time::timeout(CHECK_TIMEOUT, updater.check())
                        .await
                        .map_err(|_| "连接超时，请切换更新线路后重试".to_string())?
                        .map_err(|e| e.to_string())
                });
                {
                    let mut inner = self.lock();
                    match inner.checking.as_mut() {
                        Some(check) if check.id == id => {
                            check.abort = Some(task.inner().abort_handle())
                        }
                        _ => {
                            task.abort();
                            return inner.status.clone();
                        }
                    }
                }
                task.await
                    .map_err(|e| e.to_string())
                    .and_then(|result| result)
            }
            Err(error) => Err(error),
        };
        self.lock().finish_check(id, result);
        self.update(|_| {});
        self.status()
    }

    /// Download, verify, and install the pending update, then relaunch Pier.
    /// Returns only on failure (the host is started again in that case).
    pub async fn install(&self) -> Result<(), String> {
        let update = self.begin_install()?;
        self.run_install(update).await
    }

    /// Install the newest release for a remote request: check first unless an update is
    /// already known, then start installing in the background. Returns the status right after
    /// the install started, or after a check that found nothing to install (or failed).
    pub async fn install_latest(&self) -> UpdateStatus {
        let known = {
            let inner = self.lock();
            match inner.status.state {
                UpdateState::Unsupported
                | UpdateState::Checking
                | UpdateState::Downloading
                | UpdateState::Installing => return inner.status.clone(),
                UpdateState::Available | UpdateState::Error => inner.pending.is_some(),
                _ => false,
            }
        };
        if !known {
            let status = self.check().await;
            if status.state != UpdateState::Available {
                return status;
            }
        }
        // Fails only when another install claimed the update meanwhile.
        if let Ok(update) = self.begin_install() {
            let manager = self.clone();
            tauri::async_runtime::spawn(async move {
                // Failures are reported through the status (state `error`).
                let _ = manager.run_install(update).await;
            });
        }
        self.status()
    }

    /// Claim the pending update for installing (state `downloading`).
    fn begin_install(&self) -> Result<Update, String> {
        let update = {
            let mut inner = self.lock();
            match inner.status.state {
                UpdateState::Available | UpdateState::Error => {}
                UpdateState::Downloading | UpdateState::Installing => {
                    return Err("更新已在进行中".into())
                }
                _ => return Err("没有可安装的更新".into()),
            }
            let Some(mut update) = inner.pending.clone() else {
                return Err("没有可安装的更新".into());
            };
            // Keep the pending URL original so changing routes never stacks mirror prefixes.
            update.download_url = download_url(&update.download_url, &inner.status.mirror_prefix)?;
            inner.status.state = UpdateState::Downloading;
            inner.status.downloaded = 0;
            inner.status.total = None;
            inner.status.error = None;
            update
        };
        self.update(|_| {});
        Ok(update)
    }

    async fn run_install(&self, update: Update) -> Result<(), String> {
        let mut downloaded: u64 = 0;
        let mut last_emit = Instant::now();
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    if last_emit.elapsed() >= PROGRESS_INTERVAL {
                        last_emit = Instant::now();
                        let done = downloaded;
                        self.update(|status| {
                            status.downloaded = done;
                            status.total = total;
                        });
                    }
                },
                || {},
            )
            .await;
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) => return Err(self.fail(format!("下载或校验更新失败：{error}"))),
        };
        let size = bytes.len() as u64;
        self.update(|status| {
            status.state = UpdateState::Installing;
            status.downloaded = size;
            status.total = Some(size);
        });

        // Stop the host first: running agents are ended cleanly, and on Windows the
        // installer (which exits this process) must be able to replace pier-host.exe.
        let host = self.app.state::<HostManager>().inner().clone();
        let install = tauri::async_runtime::spawn_blocking(move || {
            host.suspend("正在安装更新，Pier 将自动重启…");
            update.install(bytes).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result);

        if let Err(error) = install {
            self.app.state::<HostManager>().resume();
            return Err(self.fail(format!("安装更新失败：{error}")));
        }
        // RunEvent::Exit then runs as for a normal quit (host already stopped, tray removed).
        self.app.request_restart();
        Ok(())
    }

    fn fail(&self, error: String) -> String {
        self.update(|status| {
            status.state = UpdateState::Error;
            status.error = Some(error.clone());
        });
        error
    }

    fn updater(&self) -> Result<tauri_plugin_updater::Updater, String> {
        let mut builder = self.app.updater_builder().timeout(CHECK_TIMEOUT);
        let endpoints = match std::env::var("PIER_UPDATER_ENDPOINT") {
            Ok(endpoint) => vec![endpoint
                .parse::<tauri::Url>()
                .map_err(|e| format!("PIER_UPDATER_ENDPOINT 无效：{e}"))?],
            Err(_) => self
                .app
                .config()
                .plugins
                .0
                .get("updater")
                .and_then(|config| config.get("endpoints"))
                .cloned()
                .ok_or("未配置更新地址")
                .and_then(|value| {
                    serde_json::from_value::<Vec<tauri::Url>>(value).map_err(|_| "更新地址无效")
                })?,
        };
        let mirror = self.status().mirror_prefix;
        let endpoints = endpoints
            .iter()
            .map(|url| download_url(url, &mirror))
            .collect::<Result<Vec<_>, _>>()?;
        builder = builder.endpoints(endpoints).map_err(|e| e.to_string())?;
        let host = self.app.state::<HostManager>().inner().clone();
        let app = self.app.clone();
        builder
            // Windows: runs right before the installer starts and this process exits.
            .on_before_exit(move || {
                host.shutdown();
                app.cleanup_before_exit();
            })
            .build()
            .map_err(|e| e.to_string())
    }

    /// Background checks: shortly after launch, then every `CHECK_INTERVAL` while enabled.
    pub fn start_scheduler(&self) {
        if !supported() {
            return;
        }
        let manager = self.clone();
        thread::spawn(move || loop {
            thread::sleep(SCHEDULER_TICK);
            let due = {
                let inner = manager.lock();
                inner.status.auto_check
                    && Instant::now() >= inner.next_auto_check
                    && matches!(
                        inner.status.state,
                        UpdateState::Idle | UpdateState::UpToDate | UpdateState::Error
                    )
            };
            if due {
                tauri::async_runtime::block_on(manager.check());
            }
        });
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("无法定位配置目录")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("无法保存更新设置：{e}"))
}

#[tauri::command]
pub fn update_status(manager: tauri::State<'_, UpdateManager>) -> UpdateStatus {
    manager.status()
}

#[tauri::command]
pub async fn update_check(manager: tauri::State<'_, UpdateManager>) -> Result<UpdateStatus, ()> {
    Ok(manager.inner().clone().check().await)
}

#[tauri::command]
pub fn update_cancel_check(manager: tauri::State<'_, UpdateManager>) -> UpdateStatus {
    manager.cancel_check()
}

#[tauri::command]
pub async fn update_install(manager: tauri::State<'_, UpdateManager>) -> Result<(), String> {
    manager.inner().clone().install().await
}

#[tauri::command]
pub fn update_set_auto_check(
    manager: tauri::State<'_, UpdateManager>,
    enabled: bool,
) -> Result<UpdateStatus, String> {
    manager.set_auto_check(enabled)
}

#[tauri::command]
pub fn update_set_mirror(
    manager: tauri::State<'_, UpdateManager>,
    prefix: String,
) -> Result<UpdateStatus, String> {
    manager.set_mirror(&prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checking_inner() -> Inner {
        Inner {
            status: UpdateStatus {
                state: UpdateState::Checking,
                current_version: "1.0.0".into(),
                auto_check: false,
                mirror_prefix: "https://mirror.example/".into(),
                version: Some("1.2.3".into()),
                notes: Some("known update".into()),
                date: None,
                downloaded: 0,
                total: None,
                error: None,
                last_checked: Some(123),
                install_needs_auth: false,
            },
            pending: None,
            tray_item: None,
            next_auto_check: Instant::now(),
            next_check_id: 1,
            checking: Some(CheckOperation {
                id: 1,
                previous_state: UpdateState::Available,
                abort: None,
            }),
        }
    }

    #[test]
    fn cancel_restores_known_update_and_aborts_a_stalled_task() {
        let mut inner = checking_inner();
        let task = tauri::async_runtime::spawn(std::future::pending::<()>());
        inner.checking.as_mut().unwrap().abort = Some(task.inner().abort_handle());
        inner.cancel_check();
        assert!(tauri::async_runtime::block_on(task).is_err());
        assert!(inner.checking.is_none());
        assert_eq!(inner.status.state, UpdateState::Available);
        assert_eq!(inner.status.version.as_deref(), Some("1.2.3"));
        assert_eq!(inner.status.mirror_prefix, "https://mirror.example/");
        assert!(!inner.status.auto_check);
        inner.cancel_check();
        assert_eq!(inner.status.state, UpdateState::Available);
    }

    #[test]
    fn canceled_check_results_cannot_overwrite_or_retire_a_new_check() {
        let mut inner = checking_inner();
        inner.cancel_check();
        inner.status.state = UpdateState::Checking;
        inner.checking = Some(CheckOperation {
            id: 2,
            previous_state: UpdateState::Available,
            abort: None,
        });
        inner.finish_check(1, Ok(None));
        inner.finish_check(1, Err("old connection failed".into()));
        assert_eq!(inner.status.state, UpdateState::Checking);
        assert_eq!(inner.status.version.as_deref(), Some("1.2.3"));
        assert_eq!(inner.checking.as_ref().unwrap().id, 2);
        inner.finish_check(2, Ok(None));
        assert_eq!(inner.status.state, UpdateState::UpToDate);
        assert!(inner.checking.is_none());
        assert!(inner.status.version.is_none());
    }

    #[test]
    fn old_settings_keep_auto_check_and_default_to_github_direct() {
        let settings: Settings = serde_json::from_str(r#"{"autoCheck":false}"#).unwrap();
        assert!(!settings.auto_check);
        assert!(settings.mirror_prefix.is_empty());
    }
}
