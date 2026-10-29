fn main() {
    println!("cargo:rerun-if-changed=src/system_speech.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/system_speech.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("pier_system_speech");
        println!("cargo:rustc-link-lib=framework=Foundation");
        // Preserve the app's pre-10.15 launch compatibility; authorization reports
        // the unavailable feature on systems that do not ship Speech.framework.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // tauri-build embeds Common Controls v6 only into application binaries.
        // Library test executables also import TaskDialogIndirect through rfd;
        // without the manifest the loader selects v5 and exits with 0xc0000139.
        // Let the linker embed the same dependency into every linked executable.
        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("failed to prepare Windows application resources");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    } else {
        tauri_build::build()
    }
}
