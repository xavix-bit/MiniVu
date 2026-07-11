use crate::model_lifecycle::ModelLifecycleState;
use crate::settings::{
    load_settings, save_app_settings as persist_app_settings, AppSettings, SettingsSaveIntent,
};
use crate::sidecar::on_settings_saved;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub platform: String,
    pub is_apple_silicon: bool,
    pub memory_gb: f64,
    pub recommended: bool,
    pub message: String,
}

#[tauri::command]
pub fn load_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    load_settings(&app)
}

#[tauri::command]
pub fn save_app_settings(
    app: tauri::AppHandle,
    lifecycle: State<'_, ModelLifecycleState>,
    settings: AppSettings,
    intent: Option<SettingsSaveIntent>,
) -> Result<(), String> {
    let _mutation = lifecycle.begin_mutation()?;
    let settings = persist_app_settings(&app, settings, intent.unwrap_or_default())?;
    crate::shortcut::register_shortcut(&app, &settings.shortcut)?;
    on_settings_saved(&app);
    Ok(())
}

#[tauri::command]
pub fn get_device_info() -> DeviceInfo {
    use crate::platform_caps::{is_apple_silicon, system_memory_gb};
    let platform = std::env::consts::OS.to_string();
    let apple_silicon = is_apple_silicon();
    let memory_gb = system_memory_gb();
    let recommended = apple_silicon && memory_gb >= 16.0;

    let message = if recommended {
        "设备可用。".to_string()
    } else if apple_silicon {
        "可以运行，但 16GB 内存体验更稳定。".to_string()
    } else {
        "当前版本优先支持 Apple Silicon macOS。".to_string()
    };

    DeviceInfo {
        platform,
        is_apple_silicon: apple_silicon,
        memory_gb,
        recommended,
        message,
    }
}
