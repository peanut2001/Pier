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
    tauri_build::build()
}
