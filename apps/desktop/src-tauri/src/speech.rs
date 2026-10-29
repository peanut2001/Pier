use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, Webview};

/// WebKitGTK denies media capture without a handler. Grant only the app UI's microphone;
/// the operating system still enforces its microphone permission.
pub fn permission(webview: Webview, kind: PermissionKind) -> PermissionResponse {
    if !matches!(kind, PermissionKind::Microphone) {
        return PermissionResponse::Default;
    }
    let Ok(url) = webview.url() else {
        return PermissionResponse::Deny;
    };
    let bundled = matches!(url.scheme(), "tauri" | "http" | "https")
        && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost"))
        && url.port().is_none()
        && (url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && webview
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| dev.origin() == url.origin());
    if webview.label() == "main" && (bundled || development) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}
