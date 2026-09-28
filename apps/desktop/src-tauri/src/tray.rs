//! System tray: Pier keeps running (and the host keeps serving clients) when the window is closed.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::host::HostManager;
use crate::updater::UpdateManager;

pub const TRAY_ID: &str = "main";

/// Builds the tray icon and returns the update menu item, whose label follows the update state.
pub fn create(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let show = MenuItem::with_id(app, "show", "显示 Pier", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart-host", "重启 Pier Host", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "检查更新…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Pier", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &restart, &update, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Pier")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => crate::show_main_window(app),
            "restart-host" => {
                let manager = app.state::<HostManager>().inner().clone();
                std::thread::spawn(move || manager.restart());
            }
            "update" => app.state::<UpdateManager>().open(),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(update)
}
