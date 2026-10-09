//! Undo what an AppImage runtime injects into the environment.
//!
//! The AppImage runtime mounts the image at `$TMPDIR/.mount_<name><random>` and its `AppRun`
//! (plus the bundled GTK hook) puts that directory in front of `LD_LIBRARY_PATH`, `PATH`,
//! `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`, `PYTHONPATH`, … Programs Pier starts — the
//! integrated terminal's shell, the Pier Host sidecar and with it every agent and its `bash`
//! tool — would otherwise inherit those entries and load the bundled (older) libraries instead
//! of the system ones, e.g. the system `curl` failing with
//! `undefined symbol: nghttp2_option_set_no_rfc9113_leading_and_trailing_ws_validation`.
//!
//! A relaunch (updater, or Pier started from its own terminal) runs the new AppImage with the
//! old environment, so the entries pile up, one stale mount per launch. Each stale mount stays
//! busy (GLib maps `gschemas.compiled` from every schema directory), so its runtime never
//! exits. Hence two clean-ups:
//!
//! - [`drop_stale_entries`] at startup removes entries from *other* AppImage mounts from this
//!   process (its own mount is still needed by GTK);
//! - [`child_overrides`] gives the environment changes for a child process: every AppImage
//!   entry and marker is removed, while the user's own values are kept.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

/// Set by the AppImage runtime / `AppRun`; meaningless outside the image.
const MARKERS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// Overwritten by the bundled GTK hook (the user's value is already lost), not a path.
const OVERWRITTEN: &[&str] = &["GTK_THEME"];

/// Path-list (or single path) variables the runtime and its hooks prepend to or set.
const PATH_LISTS: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "PYTHONPATH",
    "PYTHONHOME",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    "GSETTINGS_SCHEMA_DIR",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GI_TYPELIB_PATH",
    "GTK_PATH",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
];

/// A change to apply: set the variable, or remove it (`None`).
pub(crate) type EnvOverride = (OsString, Option<OsString>);

/// The AppImage mount directory a path lies in (`…/.mount_xxxx`), if any.
fn mount_root(path: &Path) -> Option<PathBuf> {
    let mut root = PathBuf::new();
    for component in path.components() {
        root.push(component);
        if let Component::Normal(name) = component {
            if name.to_string_lossy().starts_with(".mount_") {
                return Some(root);
            }
        }
    }
    None
}

fn var<'a>(vars: &'a [(OsString, OsString)], key: &str) -> Option<&'a OsStr> {
    vars.iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_os_str())
}

/// `value`'s entries without the dropped ones, empty entries and duplicates; `None` when that
/// changes nothing. `Some(None)` means no entry is left.
fn filter_list(value: &OsStr, drop: impl Fn(&Path) -> bool) -> Option<Option<OsString>> {
    let mut seen = HashSet::new();
    let kept: Vec<PathBuf> = std::env::split_paths(value)
        .filter(|entry| !entry.as_os_str().is_empty() && !drop(entry))
        .filter(|entry| seen.insert(entry.clone()))
        .collect();
    let next = if kept.is_empty() {
        None
    } else {
        Some(std::env::join_paths(&kept).ok()?)
    };
    (next.as_deref() != Some(value)).then_some(next)
}

fn overrides(
    vars: &[(OsString, OsString)],
    drop: impl Fn(&Path) -> bool,
    extra: &[&str],
) -> Vec<EnvOverride> {
    let mut changes: Vec<EnvOverride> = extra
        .iter()
        .filter(|key| var(vars, key).is_some())
        .map(|key| (OsString::from(key), None))
        .collect();
    for key in PATH_LISTS {
        if let Some(next) = var(vars, key).and_then(|value| filter_list(value, &drop)) {
            changes.push((OsString::from(key), next));
        }
    }
    changes
}

/// Changes that remove every AppImage entry from `vars` for a child process.
pub(crate) fn child_overrides(vars: &[(OsString, OsString)]) -> Vec<EnvOverride> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let appdir = var(vars, "APPDIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);
    let extra: Vec<&str> = if appdir.is_some() {
        MARKERS.iter().chain(OVERWRITTEN).copied().collect()
    } else {
        Vec::new()
    };
    overrides(
        vars,
        |entry| {
            mount_root(entry).is_some()
                || appdir.as_deref().is_some_and(|dir| entry.starts_with(dir))
        },
        &extra,
    )
}

/// Changes that remove entries of AppImage mounts other than this process's own (`$APPDIR`).
pub(crate) fn stale_overrides(vars: &[(OsString, OsString)]) -> Vec<EnvOverride> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let Some(own) = var(vars, "APPDIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
    else {
        return Vec::new();
    };
    let own_root = mount_root(&own).unwrap_or(own);
    overrides(
        vars,
        |entry| mount_root(entry).is_some_and(|root| root != own_root),
        &[],
    )
}

fn current_vars() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}

/// The changes to apply when spawning a child of this process.
pub(crate) fn child_env() -> Vec<EnvOverride> {
    child_overrides(&current_vars())
}

/// Remove other (stale) AppImage mounts' entries from this process's environment.
///
/// Call first thing in `main`, before any other thread exists and before GTK starts.
pub fn drop_stale_entries() {
    for (key, value) in stale_overrides(&current_vars()) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect()
    }

    fn get<'a>(changes: &'a [EnvOverride], key: &str) -> Option<&'a Option<OsString>> {
        changes
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    const OWN: &str = "/tmp/.mount_pier-AAAAAA";
    const OLD: &str = "/tmp/.mount_pier-BBBBBB";

    fn appimage_env() -> Vec<(OsString, OsString)> {
        vars(&[
            ("APPDIR", OWN),
            ("APPIMAGE", "/home/me/pier.AppImage"),
            ("ARGV0", "/home/me/pier.AppImage"),
            ("OWD", "/tmp/.mount_pier-BBBBBB/usr"),
            ("GTK_THEME", "Adwaita:light"),
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_pier-AAAAAA/usr/lib/:/tmp/.mount_pier-BBBBBB/usr/lib/:/opt/mine/lib:",
            ),
            (
                "PATH",
                "/home/me/.local/bin:/tmp/.mount_pier-AAAAAA/usr/bin/:/usr/bin:/tmp/.mount_pier-BBBBBB/usr/bin/:/usr/bin",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_pier-AAAAAA/usr/share/:/usr/share:/tmp/.mount_pier-BBBBBB/usr/share:/usr/share",
            ),
            ("PYTHONHOME", "/tmp/.mount_pier-AAAAAA/usr/"),
            ("GTK_PATH", "/tmp/.mount_pier-AAAAAA//usr/lib/gtk-3.0"),
            ("PYTHONPATH", "/home/me/py"),
            ("HOME", "/home/me"),
        ])
    }

    #[test]
    fn children_get_no_appimage_entries_but_keep_the_users_values() {
        let changes = child_overrides(&appimage_env());
        for key in [
            "APPDIR",
            "APPIMAGE",
            "ARGV0",
            "OWD",
            "GTK_THEME",
            "PYTHONHOME",
            "GTK_PATH",
        ] {
            assert_eq!(get(&changes, key), Some(&None), "{key}");
        }
        assert_eq!(
            get(&changes, "LD_LIBRARY_PATH"),
            Some(&Some("/opt/mine/lib".into()))
        );
        assert_eq!(
            get(&changes, "PATH"),
            Some(&Some("/home/me/.local/bin:/usr/bin".into()))
        );
        assert_eq!(
            get(&changes, "XDG_DATA_DIRS"),
            Some(&Some("/usr/share".into()))
        );
        // Untouched values are not overridden at all.
        assert_eq!(get(&changes, "PYTHONPATH"), None);
        assert_eq!(get(&changes, "HOME"), None);
    }

    #[test]
    fn this_process_only_drops_other_mounts() {
        let changes = stale_overrides(&appimage_env());
        assert_eq!(
            get(&changes, "LD_LIBRARY_PATH"),
            Some(&Some(
                "/tmp/.mount_pier-AAAAAA/usr/lib/:/opt/mine/lib".into()
            ))
        );
        assert_eq!(
            get(&changes, "XDG_DATA_DIRS"),
            Some(&Some(
                "/tmp/.mount_pier-AAAAAA/usr/share/:/usr/share".into()
            ))
        );
        for key in ["APPDIR", "APPIMAGE", "GTK_THEME", "PYTHONHOME", "GTK_PATH"] {
            assert_eq!(get(&changes, key), None, "{key}");
        }
        assert!(!format!("{changes:?}").contains(OLD));
    }

    #[test]
    fn outside_an_appimage_only_leftover_mount_entries_go() {
        let plain = vars(&[("PATH", "/usr/local/bin:/usr/bin"), ("GTK_THEME", "Mine")]);
        assert!(child_overrides(&plain).is_empty());
        assert!(stale_overrides(&plain).is_empty());

        let leftover = vars(&[("LD_LIBRARY_PATH", "/tmp/.mount_pier-BBBBBB/usr/lib")]);
        assert_eq!(
            child_overrides(&leftover),
            vec![(OsString::from("LD_LIBRARY_PATH"), None)]
        );
    }

    #[test]
    fn finds_the_mount_root() {
        assert_eq!(
            mount_root(Path::new("/tmp/.mount_pier-AAAAAA//usr/lib")),
            Some(PathBuf::from(OWN))
        );
        assert_eq!(mount_root(Path::new("/usr/lib")), None);
    }
}
