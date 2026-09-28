//! In-app updates through the Tauri updater plugin.
//!
//! Pier checks the `latest.json` manifest attached to the newest GitHub release (see
//! `.github/workflows/release.yml`), shortly after launch and then every few hours while it
//! runs in the tray. The user decides when to install: installing downloads the signed
//! bundle, verifies it against the public key in `tauri.conf.json`, stops the Pier Host (so
//! no agent is cut off halfway through writing a file and the Windows installer can replace
//! the sidecar), installs, and relaunches Pier.
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
    /// The available update.
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    /// Unix time (ms) of the last successful check.
    pub last_checked: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    auto_check: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { auto_check: true }
    }
}

struct Inner {
    status: UpdateStatus,
    pending: Option<Update>,
    tray_item: Option<MenuItem<Wry>>,
    next_auto_check: Instant,
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
            version: None,
            notes: None,
            date: None,
            downloaded: 0,
            total: None,
            error: None,
            last_checked: None,
        };
        Self {
            app,
            inner: Arc::new(Mutex::new(Inner {
                status,
                pending: None,
                tray_item: None,
                next_auto_check: Instant::now() + FIRST_CHECK_DELAY,
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
        let _ = self.app.emit(STATUS_EVENT, self.status());
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
        save_settings(
            &self.app,
            &Settings {
                auto_check: enabled,
            },
        )?;
        self.update(|status| status.auto_check = enabled);
        Ok(self.status())
    }

    /// Check the release manifest. Concurrent checks and checks during an install are no-ops.
    pub async fn check(&self) -> UpdateStatus {
        {
            let mut inner = self.lock();
            match inner.status.state {
                UpdateState::Unsupported
                | UpdateState::Checking
                | UpdateState::Downloading
                | UpdateState::Installing => return inner.status.clone(),
                _ => {}
            }
            inner.status.state = UpdateState::Checking;
            inner.next_auto_check = Instant::now() + CHECK_INTERVAL;
        }
        self.update(|_| {});

        let result = match self.updater() {
            Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
            Err(error) => Err(error),
        };
        let checked_at = now_ms();
        match result {
            Ok(Some(update)) => {
                let (version, notes, date) = (
                    update.version.clone(),
                    update.body.clone().filter(|notes| !notes.trim().is_empty()),
                    update
                        .raw_json
                        .get("pub_date")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                );
                self.lock().pending = Some(update);
                self.update(|status| {
                    status.state = UpdateState::Available;
                    status.version = Some(version);
                    status.notes = notes;
                    status.date = date;
                    status.downloaded = 0;
                    status.total = None;
                    status.error = None;
                    status.last_checked = Some(checked_at);
                });
            }
            Ok(None) => {
                self.lock().pending = None;
                self.update(|status| {
                    status.state = UpdateState::UpToDate;
                    status.version = None;
                    status.notes = None;
                    status.date = None;
                    status.error = None;
                    status.last_checked = Some(checked_at);
                });
            }
            Err(error) => {
                self.lock().pending = None;
                self.update(|status| {
                    status.state = UpdateState::Error;
                    status.version = None;
                    status.notes = None;
                    status.date = None;
                    status.error = Some(format!("检查更新失败：{error}"));
                });
            }
        }
        self.status()
    }

    /// Download, verify, and install the pending update, then relaunch Pier.
    /// Returns only on failure (the host is started again in that case).
    pub async fn install(&self) -> Result<(), String> {
        let update = {
            let mut inner = self.lock();
            match inner.status.state {
                UpdateState::Available | UpdateState::Error => {}
                UpdateState::Downloading | UpdateState::Installing => {
                    return Err("更新已在进行中".into())
                }
                _ => return Err("没有可安装的更新".into()),
            }
            let Some(update) = inner.pending.clone() else {
                return Err("没有可安装的更新".into());
            };
            inner.status.state = UpdateState::Downloading;
            inner.status.downloaded = 0;
            inner.status.total = None;
            inner.status.error = None;
            update
        };
        self.update(|_| {});

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
        if let Ok(endpoint) = std::env::var("PIER_UPDATER_ENDPOINT") {
            let url = endpoint
                .parse()
                .map_err(|e| format!("PIER_UPDATER_ENDPOINT 无效：{e}"))?;
            builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
        }
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
