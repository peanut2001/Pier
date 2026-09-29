//! Downloads from a Pier Host to a file on this computer.
//!
//! The webview cannot write local files itself, so a download goes through these commands:
//! `download_begin` asks the user where to save (a native save dialog) and opens a temporary
//! `<name>.pier-part` file next to the destination; `download_write` appends base64 chunks as
//! they arrive from the host; `download_finish` moves the complete file into place, and
//! `download_abort` deletes the partial file. Only paths the user picked in the dialog are ever
//! written.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct Download {
    file: File,
    part: PathBuf,
    dest: PathBuf,
}

#[derive(Default, Clone)]
pub struct DownloadManager {
    next: Arc<AtomicU32>,
    downloads: Arc<Mutex<HashMap<u32, Download>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTarget {
    id: u32,
    path: String,
}

/// Keep only the last path component of a suggested name, so it cannot point elsewhere.
fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() || base == "." || base == ".." {
        "download".to_string()
    } else {
        base.to_string()
    }
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".pier-part");
    dest.with_file_name(name)
}

impl DownloadManager {
    fn take(&self, id: u32) -> Option<Download> {
        self.downloads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
    }
}

/// Ask where to save `name`; resolves to `None` when the user cancels.
#[tauri::command]
pub async fn download_begin(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    name: String,
) -> Result<Option<DownloadTarget>, String> {
    let file_name = safe_file_name(&name);
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = dialog_app
            .dialog()
            .file()
            .set_title("保存文件")
            .set_file_name(file_name);
        if let Some(window) = dialog_app.get_webview_window("main") {
            builder = builder.set_parent(&window);
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let dest = picked
        .into_path()
        .map_err(|e| format!("无法使用所选位置：{e}"))?;
    let part = part_path(&dest);
    let file = File::create(&part).map_err(|e| format!("无法创建文件 {}：{e}", part.display()))?;
    let id = manager.next.fetch_add(1, Ordering::Relaxed) + 1;
    let path = dest.display().to_string();
    manager
        .downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, Download { file, part, dest });
    Ok(Some(DownloadTarget { id, path }))
}

/// Append base64 `data` to a download.
#[tauri::command(async)]
pub fn download_write(
    manager: State<'_, DownloadManager>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("数据无效：{e}"))?;
    let mut downloads = manager.downloads.lock().unwrap_or_else(|e| e.into_inner());
    let download = downloads.get_mut(&id).ok_or("下载已结束")?;
    if let Err(error) = download.file.write_all(&bytes) {
        let message = format!("写入 {} 失败：{error}", download.part.display());
        if let Some(download) = downloads.remove(&id) {
            drop(download.file);
            let _ = fs::remove_file(&download.part);
        }
        return Err(message);
    }
    Ok(())
}

/// Move a complete download into place; resolves to the saved path.
#[tauri::command(async)]
pub fn download_finish(manager: State<'_, DownloadManager>, id: u32) -> Result<String, String> {
    let Download { file, part, dest } = manager.take(id).ok_or("下载已结束")?;
    let result = (|| -> std::io::Result<()> {
        file.sync_all()?;
        drop(file);
        // The save dialog already confirmed replacing an existing file; Windows cannot rename over it.
        if dest.exists() {
            fs::remove_file(&dest)?;
        }
        fs::rename(&part, &dest)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&part);
        return Err(format!("保存到 {} 失败：{error}", dest.display()));
    }
    Ok(dest.display().to_string())
}

/// Abandon a download and delete what was written.
#[tauri::command(async)]
pub fn download_abort(manager: State<'_, DownloadManager>, id: u32) {
    if let Some(download) = manager.take(id) {
        drop(download.file);
        let _ = fs::remove_file(&download.part);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_names_stay_file_names() {
        assert_eq!(safe_file_name("a/b/c.txt"), "c.txt");
        assert_eq!(safe_file_name("..\\x.bin"), "x.bin");
        assert_eq!(safe_file_name(".."), "download");
        assert_eq!(safe_file_name(""), "download");
        assert_eq!(
            part_path(&PathBuf::from("/tmp/x.zip")),
            PathBuf::from("/tmp/x.zip.pier-part")
        );
    }
}
