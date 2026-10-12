//! Work around WebKitGTK's DMA-BUF renderer failures on NVIDIA, including DGX Spark (GB10).
//! See https://github.com/pwilkin/trellis.cpp/issues/23.

use std::ffi::OsStr;
use std::path::Path;

const DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

fn dmabuf_override(drm_dir: &Path, existing: Option<&OsStr>) -> Option<&'static str> {
    // Keep explicit values, including "0" and an empty value.
    if existing.is_some() {
        return None;
    }

    let has_nvidia = std::fs::read_dir(drm_dir)
        .ok()?
        .filter_map(Result::ok)
        .any(|entry| {
            std::fs::read_to_string(entry.path().join("device/vendor"))
                .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
        });
    has_nvidia.then_some("1")
}

/// Call in `main` before any threads or GTK/WebKit initialization.
pub fn configure() {
    let existing = std::env::var_os(DMABUF_ENV);
    if let Some(value) = dmabuf_override(Path::new("/sys/class/drm"), existing.as_deref()) {
        std::env::set_var(DMABUF_ENV, value);
        eprintln!("Pier: NVIDIA GPU detected; disabling the WebKitGTK DMA-BUF renderer");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct DrmFixture(PathBuf);

    impl DrmFixture {
        fn new() -> Self {
            static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "pier-drm-test-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn gpu(&self, node: &str, vendor: &str) {
            let device = self.0.join(node).join("device");
            std::fs::create_dir_all(&device).unwrap();
            std::fs::write(device.join("vendor"), vendor).unwrap();
        }
    }

    impl Drop for DrmFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn nvidia_gpu_selects_the_compatible_renderer() {
        let drm = DrmFixture::new();
        drm.gpu("card0", "0x10de\n");
        assert_eq!(dmabuf_override(&drm.0, None), Some("1"));
    }

    #[test]
    fn detects_nvidia_on_secondary_and_render_nodes() {
        let drm = DrmFixture::new();
        drm.gpu("card0", "0x8086\n");
        drm.gpu("renderD129", "0x10DE\n");
        // DRM also includes connectors and nodes without a readable vendor file.
        std::fs::create_dir(drm.0.join("card0-HDMI-A-1")).unwrap();
        assert_eq!(dmabuf_override(&drm.0, None), Some("1"));
    }

    #[test]
    fn preserves_explicit_renderer_settings() {
        let drm = DrmFixture::new();
        drm.gpu("card0", "0x10de\n");
        for value in ["0", "1", ""] {
            assert_eq!(dmabuf_override(&drm.0, Some(OsStr::new(value))), None);
        }
    }

    #[test]
    fn leaves_other_gpus_and_unavailable_sysfs_unchanged() {
        let drm = DrmFixture::new();
        assert_eq!(dmabuf_override(&drm.0, None), None);
        drm.gpu("card0", "0x8086\n");
        drm.gpu("card1", "0x1002\n");
        drm.gpu("card2", "invalid");
        assert_eq!(dmabuf_override(&drm.0, None), None);
        assert_eq!(dmabuf_override(&drm.0.join("missing"), None), None);
    }
}
