use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::process::Command;

const OCR_SCRIPT: &str = include_str!("../scripts/ocr.swift");
const OCR_OUTPUT_BEGIN: &str = "__MINIVU_OCR_BEGIN__";
const OCR_OUTPUT_END: &str = "__MINIVU_OCR_END__";

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
    let request_id = uuid_simple();
    let image_path = temp_dir.join(format!("ocr-{request_id}.png"));
    let script_path = temp_dir.join(format!("ocr-{request_id}.swift"));
    fs::write(&image_path, bytes).map_err(|e| e.to_string())?;
    if let Err(error) = fs::write(&script_path, embedded_ocr_script()) {
        let _ = fs::remove_file(&image_path);
        return Err(error.to_string());
    }

    let output = Command::new("/usr/bin/swift")
        .arg(&script_path)
        .arg(&image_path)
        .output();

    let _ = fs::remove_file(&image_path);
    let _ = fs::remove_file(&script_path);
    let output = output.map_err(|e| format!("启动 OCR 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OCR 失败: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = parse_ocr_stdout(&stdout)?;
    Ok(OcrResult {
        text,
        confidence: None,
    })
}

fn embedded_ocr_script() -> &'static str {
    OCR_SCRIPT
}

fn parse_ocr_stdout(stdout: &str) -> Result<String, String> {
    let (_, result) = stdout
        .split_once(OCR_OUTPUT_BEGIN)
        .ok_or_else(|| "OCR 返回格式无效".to_string())?;
    let (text, _) = result
        .split_once(OCR_OUTPUT_END)
        .ok_or_else(|| "OCR 返回格式无效".to_string())?;
    Ok(text.trim().to_string())
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

#[cfg(test)]
mod tests {
    use super::{embedded_ocr_script, parse_ocr_stdout};

    #[test]
    fn embeds_the_ocr_script_in_the_application_binary() {
        let script = embedded_ocr_script();

        assert!(script.contains("VNRecognizeTextRequest"));
        assert!(!script.contains("CARGO_MANIFEST_DIR"));
    }

    #[test]
    fn ignores_framework_diagnostics_around_recognized_text() {
        let stdout = concat!(
            "Unable to find a valid E5 in provided path /System/Library/...\n",
            "__MINIVU_OCR_BEGIN__\n",
            "第一行\n第二行\n",
            "__MINIVU_OCR_END__\n",
        );

        assert_eq!(parse_ocr_stdout(stdout).unwrap(), "第一行\n第二行");
    }
}
