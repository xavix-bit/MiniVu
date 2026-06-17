#[tauri::command]
pub fn app_privacy_mode() -> &'static str {
    "local-only"
}
