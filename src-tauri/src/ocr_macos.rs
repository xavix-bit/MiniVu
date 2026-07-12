use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
use tauri::Manager;

#[derive(serde::Serialize)]
pub struct OcrResult {
    pub text: String,
    pub confidence: Option<f32>,
}

#[tauri::command]
pub async fn recognize_text_from_image_data_url(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<OcrResult, String> {
    #[cfg(target_os = "macos")]
    let command = resolve_ocr_command_for_app(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_data_url(&data_url)?;
        #[cfg(target_os = "macos")]
        return recognize_image_bytes(&bytes, &command);

        #[cfg(not(target_os = "macos"))]
        recognize_image_bytes(&bytes)
    })
    .await
    .map_err(|error| format!("OCR 任务失败: {error}"))?
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let payload = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    STANDARD.decode(payload).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[derive(Debug, Eq, PartialEq)]
enum OcrCommand {
    Helper(PathBuf),
    #[cfg(debug_assertions)]
    SwiftScript(PathBuf),
}

#[cfg(target_os = "macos")]
impl OcrCommand {
    fn process_parts(&self, image_path: &Path) -> (PathBuf, Vec<OsString>) {
        match self {
            Self::Helper(helper) => (helper.clone(), vec![image_path.as_os_str().to_owned()]),
            #[cfg(debug_assertions)]
            Self::SwiftScript(script) => (
                PathBuf::from("/usr/bin/swift"),
                vec![
                    script.as_os_str().to_owned(),
                    image_path.as_os_str().to_owned(),
                ],
            ),
        }
    }
}

#[cfg(target_os = "macos")]
fn resolve_ocr_command(
    resource_dir: &Path,
    development_script: Option<&Path>,
) -> Result<OcrCommand, String> {
    let helper = resource_dir.join("ocr-helper");
    if helper.is_file() {
        return Ok(OcrCommand::Helper(helper));
    }

    #[cfg(debug_assertions)]
    {
        if let Some(script) = development_script.filter(|path| path.is_file()) {
            return Ok(OcrCommand::SwiftScript(script.to_path_buf()));
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = development_script;

    Err("OCR 组件不可用，请重新安装 MiniVu".to_string())
}

#[cfg(target_os = "macos")]
fn resolve_ocr_command_for_app(app: &tauri::AppHandle) -> Result<OcrCommand, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| "OCR 组件不可用，请重新安装 MiniVu".to_string())?;

    #[cfg(debug_assertions)]
    let development_script = Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/ocr.swift"));
    #[cfg(not(debug_assertions))]
    let development_script: Option<PathBuf> = None;

    resolve_ocr_command(&resource_dir, development_script.as_deref())
}

#[cfg(target_os = "macos")]
struct TemporaryImage {
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl TemporaryImage {
    fn write(path: PathBuf, bytes: &[u8]) -> Result<Self, String> {
        let image = Self { path };
        fs::write(&image.path, bytes).map_err(|error| error.to_string())?;
        Ok(image)
    }
}

#[cfg(target_os = "macos")]
impl Drop for TemporaryImage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(target_os = "macos")]
fn recognize_image_bytes(bytes: &[u8], command: &OcrCommand) -> Result<OcrResult, String> {
    let temp_dir = std::env::temp_dir().join("minivu");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let image_path = temp_dir.join(format!("ocr-{}.png", uuid_simple()));
    recognize_image_bytes_at_path(bytes, command, image_path)
}

#[cfg(target_os = "macos")]
fn recognize_image_bytes_at_path(
    bytes: &[u8],
    command: &OcrCommand,
    image_path: PathBuf,
) -> Result<OcrResult, String> {
    let image = TemporaryImage::write(image_path, bytes)?;
    let (program, arguments) = command.process_parts(&image.path);
    let output = Command::new(program)
        .args(arguments)
        .output()
        .map_err(|e| format!("启动 OCR 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OCR 失败: {stderr}"));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(OcrResult {
        text,
        confidence: None,
    })
}

#[cfg(not(target_os = "macos"))]
fn recognize_image_bytes(_bytes: &[u8]) -> Result<OcrResult, String> {
    Err("OCR 仅在 macOS 上可用".to_string())
}

fn uuid_simple() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("minivu-ocr-test-{name}-{}", uuid_simple()));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    #[test]
    fn bundled_helper_takes_priority_over_development_script() {
        let resource_dir = test_dir("resolver-priority");
        let helper = resource_dir.join("ocr-helper");
        let script = resource_dir.join("ocr.swift");
        fs::write(&helper, b"helper").expect("write helper fixture");
        fs::write(&script, b"script").expect("write script fixture");

        let command = resolve_ocr_command(&resource_dir, Some(&script)).expect("resolve helper");
        assert_eq!(command, OcrCommand::Helper(helper));

        fs::remove_dir_all(resource_dir).expect("remove test directory");
    }

    #[test]
    #[cfg(debug_assertions)]
    fn development_script_is_an_explicit_fallback() {
        let resource_dir = test_dir("resolver-fallback");
        let script = resource_dir.join("ocr.swift");
        fs::write(&script, b"script").expect("write script fixture");

        let command = resolve_ocr_command(&resource_dir, Some(&script)).expect("resolve script");
        let image = resource_dir.join("image.png");
        let (program, arguments) = command.process_parts(&image);

        assert_eq!(program, PathBuf::from("/usr/bin/swift"));
        assert_eq!(
            arguments,
            vec![script.into_os_string(), image.into_os_string()]
        );
        fs::remove_dir_all(resource_dir).expect("remove test directory");
    }

    #[test]
    fn missing_bundled_helper_returns_a_user_friendly_error() {
        let resource_dir = test_dir("resolver-missing");

        let error =
            resolve_ocr_command(&resource_dir, None).expect_err("helper should be required");
        assert_eq!(error, "OCR 组件不可用，请重新安装 MiniVu");
        assert!(!error.contains(resource_dir.to_string_lossy().as_ref()));

        fs::remove_dir_all(resource_dir).expect("remove test directory");
    }

    #[test]
    fn bundled_helper_is_invoked_directly_with_only_the_image_path() {
        let helper = std::path::PathBuf::from("/Applications/MiniVu.app/ocr-helper");
        let image = std::path::Path::new("/tmp/minivu/ocr-image.png");

        let (program, arguments) = OcrCommand::Helper(helper.clone()).process_parts(image);

        assert_eq!(program, helper);
        assert_eq!(arguments, vec![image.as_os_str().to_owned()]);
    }

    #[test]
    fn temporary_image_is_removed_when_helper_cannot_start() {
        let temp_dir = test_dir("startup-cleanup");
        let image_path = temp_dir.join("ocr-image.png");
        let command = OcrCommand::Helper(temp_dir.join("missing-helper"));

        let result = recognize_image_bytes_at_path(b"image", &command, image_path.clone());

        assert!(result.is_err());
        assert!(!image_path.exists());
        fs::remove_dir_all(temp_dir).expect("remove test directory");
    }
}
