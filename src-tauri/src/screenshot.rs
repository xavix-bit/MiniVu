use crate::window::{hide_quick_panel_silent, restore_quick_panel};
use std::process::Command;
use std::time::Duration;
use tauri::AppHandle;

#[tauri::command]
pub async fn capture_screen_region(app: AppHandle) -> Result<(), String> {
    hide_quick_panel_silent(&app)?;
    tokio::time::sleep(Duration::from_millis(220)).await;

    let result = tokio::task::spawn_blocking(run_interactive_capture)
        .await
        .map_err(|error| error.to_string())?;

    restore_quick_panel(&app)?;

    result
}

#[cfg(target_os = "macos")]
fn run_interactive_capture() -> Result<(), String> {
    let status = Command::new("/usr/sbin/screencapture")
        .args(["-i", "-c"])
        .status()
        .map_err(|error| format!("无法启动系统截图: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("已取消截图".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn run_interactive_capture() -> Result<(), String> {
    Err("框选截图目前仅支持 macOS".to_string())
}
