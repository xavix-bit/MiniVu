use crate::window::{hide_quick_panel_silent, restore_quick_panel};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedImagePayload {
    pub name: String,
    pub data_url: String,
}

#[tauri::command]
pub async fn capture_screen_region(app: AppHandle) -> Result<CapturedImagePayload, String> {
    ensure_screen_capture_access()?;

    hide_quick_panel_silent(&app)?;
    tokio::time::sleep(std::time::Duration::from_millis(380)).await;

    let capture_path = temp_capture_path(&app)?;
    let path_for_task = capture_path.clone();

    let result = tokio::task::spawn_blocking(move || run_interactive_capture(path_for_task))
        .await
        .map_err(|error| error.to_string())?;

    restore_quick_panel(&app)?;

    result
}

#[cfg(target_os = "macos")]
fn ensure_screen_capture_access() -> Result<(), String> {
    if screen_capture_access_granted() {
        return Ok(());
    }
    let _ = request_screen_capture_access();
    Err(screen_capture_permission_hint())
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_capture_access() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn screen_capture_access_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
fn request_screen_capture_access() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

fn temp_capture_path(app: &AppHandle) -> Result<PathBuf, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok(app
        .path()
        .temp_dir()
        .map_err(|error| error.to_string())?
        .join(format!("minivu-capture-{millis}.png")))
}

#[cfg(target_os = "macos")]
fn run_interactive_capture(path: PathBuf) -> Result<CapturedImagePayload, String> {
    if path.exists() {
        fs::remove_file(&path).ok();
    }

    // 写入临时文件比 -c 剪贴板更稳； -d 在缺权限时弹出系统提示。
    let status = Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-d"])
        .arg(&path)
        .status()
        .map_err(|error| format!("无法启动系统截图: {error}"))?;

    if !status.success() {
        fs::remove_file(&path).ok();
        return Err("已取消截图".to_string());
    }

    if !path.is_file() {
        return Err(screen_capture_permission_hint());
    }

    let bytes = fs::read(&path).map_err(|error| format!("读取截图失败: {error}"))?;
    fs::remove_file(&path).ok();

    if bytes.is_empty() {
        return Err(screen_capture_permission_hint());
    }

    Ok(CapturedImagePayload {
        name: "screenshot.png".to_string(),
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
    })
}

#[cfg(not(target_os = "macos"))]
fn run_interactive_capture(_path: PathBuf) -> Result<CapturedImagePayload, String> {
    Err("框选截图目前仅支持 macOS".to_string())
}

fn screen_capture_permission_hint() -> String {
    "无法截图。请在系统设置里允许屏幕录制后重启 MiniVu。".to_string()
}
