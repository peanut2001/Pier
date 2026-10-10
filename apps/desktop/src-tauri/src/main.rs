// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before any thread or GTK starts: forget the entries of earlier launches' AppImage mounts.
    pier_desktop_lib::drop_stale_appimage_env();
    pier_desktop_lib::run()
}
