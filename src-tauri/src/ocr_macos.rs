use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::process::Command;

#[derive(serde::Serialize)]
pub struct OcrResult {
    pub text: String,
    pub confidence: Option<f32>,
}

#[tauri::command]
pub async fn recognize_text_from_image_data_url(data_url: String) -> Result<OcrResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_data_url(&data_url)?;
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
fn recognize_image_bytes(bytes: &[u8]) -> Result<OcrResult, String> {
    let temp_dir = std::env::temp_dir().join("minivu");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let image_path = temp_dir.join(format!("ocr-{}.png", uuid_simple()));
    fs::write(&image_path, bytes).map_err(|e| e.to_string())?;

    let script_path = std::env!("CARGO_MANIFEST_DIR").to_string() + "/scripts/ocr.swift";
    let output = Command::new("/usr/bin/swift")
        .arg(script_path)
        .arg(&image_path)
        .output()
        .map_err(|e| format!("启动 OCR 失败: {e}"))?;

    let _ = fs::remove_file(&image_path);

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
