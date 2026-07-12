use std::path::{Path, PathBuf};
use std::process::Command;

const OCR_SOURCE: &str = "scripts/ocr.swift";
const OCR_HELPER: &str = "resources/generated/ocr-helper";

fn main() {
    println!("cargo:rerun-if-changed={OCR_SOURCE}");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        compile_ocr_helper();
    }

    tauri_build::build()
}

fn compile_ocr_helper() {
    let manifest_dir = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"),
    );
    let source = manifest_dir.join(OCR_SOURCE);
    let destination = manifest_dir.join(OCR_HELPER);
    let output_dir = destination
        .parent()
        .expect("OCR helper has no parent directory");
    std::fs::create_dir_all(output_dir).expect("failed to create OCR helper output directory");

    let temporary_dir = output_dir.join(format!(".ocr-helper-build-{}", std::process::id()));
    std::fs::create_dir_all(&temporary_dir)
        .expect("failed to create temporary OCR helper output directory");
    let temporary = temporary_dir.join("ocr-helper");
    let target = swift_target();
    let output = Command::new("xcrun")
        .args(["swiftc", "-O", "-target", &target])
        .arg(&source)
        .arg("-o")
        .arg(&temporary)
        .output()
        .expect("failed to start `xcrun swiftc` while building the OCR helper");

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&temporary_dir);
        panic!(
            "failed to compile the native OCR helper with `xcrun swiftc`:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    install_if_changed(&temporary, &destination)
        .expect("failed to install the compiled OCR helper resource");
    std::fs::remove_dir(&temporary_dir)
        .expect("failed to remove temporary OCR helper output directory");
}

fn swift_target() -> String {
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        Ok(other) => panic!("unsupported macOS OCR helper architecture: {other}"),
        Err(error) => panic!("CARGO_CFG_TARGET_ARCH is not set: {error}"),
    };
    let deployment_target =
        std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "10.15".to_string());
    format!("{architecture}-apple-macosx{deployment_target}")
}

fn install_if_changed(source: &Path, destination: &Path) -> std::io::Result<()> {
    if destination.is_file() && std::fs::read(source)? == std::fs::read(destination)? {
        return std::fs::remove_file(source);
    }

    if destination.exists() {
        std::fs::remove_file(destination)?;
    }
    std::fs::rename(source, destination)
}
