use crate::settings::{load_settings, save_settings, AppSettings};
use crate::sidecar::on_settings_saved;
use serde::Serialize;

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
pub fn save_app_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    let previous = load_settings(&app)?;
    if previous.shortcut != settings.shortcut {
        if let Err(error) = crate::shortcut::register_shortcut(&app, &settings.shortcut) {
            let _ = crate::shortcut::register_shortcut(&app, &previous.shortcut);
            return Err(error);
        }
    }
    if let Err(error) = save_settings(&app, &settings) {
        if previous.shortcut != settings.shortcut {
            let _ = crate::shortcut::register_shortcut(&app, &previous.shortcut);
        }
        return Err(error);
    }

    let inference_changed = previous.inference_backend != settings.inference_backend
        || previous.gguf_model_variant != settings.gguf_model_variant
        || previous.mlx_model_id != settings.mlx_model_id
        || (previous.background_warmup && !settings.background_warmup);
    if inference_changed {
        on_settings_saved(&app);
    }
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
