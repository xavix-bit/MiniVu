use crate::settings::{load_settings, save_settings, AppSettings};
use crate::sidecar::on_settings_saved;
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;

static SETTINGS_UPDATE_LOCK: Mutex<()> = Mutex::new(());

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

fn merge_settings_patch(current: &AppSettings, patch: Value) -> Result<AppSettings, String> {
    let patch = patch
        .as_object()
        .ok_or_else(|| "设置更新格式无效".to_string())?;
    let mut merged = serde_json::to_value(current).map_err(|error| error.to_string())?;
    let fields = merged
        .as_object_mut()
        .ok_or_else(|| "设置更新格式无效".to_string())?;

    for (key, value) in patch {
        if !fields.contains_key(key) {
            return Err(format!("未知设置字段: {key}"));
        }
        fields.insert(key.clone(), value.clone());
    }

    serde_json::from_value(merged).map_err(|error| error.to_string())
}

fn commit_settings_update<F>(
    app: &tauri::AppHandle,
    register_current_shortcut: bool,
    update: F,
) -> Result<AppSettings, String>
where
    F: FnOnce(&AppSettings) -> Result<AppSettings, String>,
{
    let _guard = SETTINGS_UPDATE_LOCK
        .lock()
        .map_err(|_| "设置暂时无法更新，请重试。".to_string())?;
    let previous = load_settings(&app)?;
    let next = update(&previous)?;
    let shortcut_changed = previous.shortcut != next.shortcut;

    if shortcut_changed || register_current_shortcut {
        if let Err(error) = crate::shortcut::register_shortcut(app, &next.shortcut) {
            let _ = crate::shortcut::register_shortcut(&app, &previous.shortcut);
            return Err(error);
        }
    }
    if previous == next {
        return Ok(previous);
    }
    if let Err(error) = save_settings(app, &next) {
        if shortcut_changed {
            let _ = crate::shortcut::register_shortcut(&app, &previous.shortcut);
        }
        return Err(error);
    }

    let inference_changed = previous.inference_backend != next.inference_backend
        || previous.gguf_model_variant != next.gguf_model_variant
        || previous.mlx_model_id != next.mlx_model_id
        || (previous.background_warmup && !next.background_warmup);
    if inference_changed {
        on_settings_saved(app);
    }
    Ok(next)
}

#[tauri::command]
pub fn save_app_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    commit_settings_update(&app, false, move |_| Ok(settings)).map(|_| ())
}

#[tauri::command]
pub fn update_app_settings(app: tauri::AppHandle, patch: Value) -> Result<AppSettings, String> {
    update_settings_patch(&app, patch)
}

pub(crate) fn update_settings_patch(
    app: &tauri::AppHandle,
    patch: Value,
) -> Result<AppSettings, String> {
    commit_settings_update(app, false, move |current| {
        merge_settings_patch(current, patch)
    })
}

pub fn ensure_setup_shortcut(app: &tauri::AppHandle) -> Result<AppSettings, String> {
    commit_settings_update(app, true, |current| {
        let mut next = current.clone();
        if next.shortcut.trim().is_empty() {
            next.shortcut = "Control+Option+Space".to_string();
        }
        Ok(next)
    })
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

#[cfg(test)]
mod tests {
    use super::merge_settings_patch;
    use crate::settings::{AppSettings, AppTheme};
    use serde_json::json;

    #[test]
    fn merges_owned_patch_without_overwriting_other_settings() {
        let mut current = AppSettings::default();
        current.shortcut = "Command+Shift+8".to_string();
        current.preferred_mirror = Some(crate::settings::MirrorId::Modelscope);

        let next = merge_settings_patch(
            &current,
            json!({
                "theme": "dark",
                "preferredMirror": null
            }),
        )
        .expect("patch should deserialize");

        assert_eq!(next.theme, AppTheme::Dark);
        assert_eq!(next.shortcut, "Command+Shift+8");
        assert_eq!(next.preferred_mirror, None);
        assert_eq!(next.inference_backend, current.inference_backend);
    }
}
