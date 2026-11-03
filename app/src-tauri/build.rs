use std::{env, path::PathBuf, process::Command};

fn main() {
    tauri_build::build();
    println!("cargo:rerun-if-changed=src/plugin/runtime/privileged_monitor.m");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let source = PathBuf::from("src/plugin/runtime/privileged_monitor.m");
    let object = out_dir.join("privileged_monitor.o");
    let library = out_dir.join("libflowhub_privileged_monitor.a");
    let status = Command::new("clang")
        .args(["-fobjc-arc", "-mmacosx-version-min=10.15", "-c"])
        .arg(&source)
        .arg("-o")
        .arg(&object)
        .status()
        .expect("failed to start clang for the macOS process monitor bridge");
    assert!(status.success(), "failed to compile the macOS process monitor bridge");

    let status = Command::new("ar")
        .arg("crs")
        .arg(&library)
        .arg(&object)
        .status()
        .expect("failed to start ar for the macOS process monitor bridge");
    assert!(status.success(), "failed to archive the macOS process monitor bridge");

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=flowhub_privileged_monitor");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=ServiceManagement");
}
