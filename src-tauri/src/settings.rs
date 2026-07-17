use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DownloadMirror {
    #[default]
    Auto,
    Modelscope,
    Huggingface,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MirrorId {
    Modelscope,
    Huggingface,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppTheme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum CaptureRetentionSetting {
    #[serde(rename = "none")]
    None,
    #[default]
    #[serde(rename = "24h")]
    Hours24,
    #[serde(rename = "7d")]
    Days7,
    #[serde(rename = "forever")]
    Forever,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InferenceBackend {
    Llama,
    Mlx,
}

impl Default for InferenceBackend {
    fn default() -> Self {
        // llama.cpp 单二进制约 8 MB，经 -ngl 走 Metal；MLX 需 Python venv（约 300 MB+）。
        // 默认精简路径：引擎更小，MiniCPM-V 4.6 GGUF + mmproj 约 1.6 GB。
        Self::Llama
    }
}

fn default_mlx_model_id() -> String {
    crate::model_cache::DEFAULT_MLX_MODEL_ID.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GgufModelVariant {
    #[serde(rename = "q4_k_m")]
    Q4KM,
    #[serde(rename = "q5_k_m")]
    Q5KM,
    #[serde(rename = "q6_k")]
    Q6K,
}

impl Default for GgufModelVariant {
    fn default() -> Self {
        Self::Q4KM
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingAssistantPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shortcut: String,
    pub model_warm_minutes: i32,
    pub auto_check_model_updates: bool,
    pub save_history_by_default: bool,
    pub allow_cloud_fallback: bool,
    pub onboarding_complete: bool,
    #[serde(default)]
    pub workbench_tips_complete: bool,
    #[serde(default = "default_floating_assistant_enabled")]
    pub floating_assistant_enabled: bool,
    #[serde(default)]
    pub floating_assistant_position: Option<FloatingAssistantPosition>,
    #[serde(default)]
    pub gguf_model_variant: GgufModelVariant,
    #[serde(default)]
    pub download_mirror: DownloadMirror,
    pub preferred_mirror: Option<MirrorId>,
    pub last_speed_test_at: Option<String>,
    #[serde(default)]
    pub theme: AppTheme,
    #[serde(default = "default_preload_model")]
    pub preload_model: bool,
    #[serde(default)]
    pub capture_retention: CaptureRetentionSetting,
    #[serde(default)]
    pub background_warmup: bool,
    #[serde(default)]
    pub inference_backend: InferenceBackend,
    #[serde(default = "default_mlx_model_id")]
    pub mlx_model_id: String,
}

fn default_preload_model() -> bool {
    false
}

fn default_floating_assistant_enabled() -> bool {
    true
}

impl AppSettings {
    pub fn default_for_device() -> Self {
        let mut settings = Self::default();
        settings.background_warmup = crate::platform_caps::system_memory_gb() >= 16.0;
        settings
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut: "Control+Option+Space".to_string(),
            model_warm_minutes: 10,
            auto_check_model_updates: false,
            save_history_by_default: true,
            allow_cloud_fallback: false,
            onboarding_complete: false,
            workbench_tips_complete: false,
            floating_assistant_enabled: default_floating_assistant_enabled(),
            floating_assistant_position: None,
            gguf_model_variant: GgufModelVariant::default(),
            download_mirror: DownloadMirror::Auto,
            preferred_mirror: None,
            last_speed_test_at: None,
            theme: AppTheme::System,
            preload_model: default_preload_model(),
            capture_retention: CaptureRetentionSetting::default(),
            background_warmup: false,
            inference_backend: InferenceBackend::default(),
            mlx_model_id: default_mlx_model_id(),
        }
    }
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default_for_device());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    #[test]
    fn legacy_settings_default_workbench_tips_to_incomplete() {
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("workbenchTipsComplete");

        let settings: AppSettings = serde_json::from_value(legacy).unwrap();

        assert!(!settings.workbench_tips_complete);
    }

    #[test]
    fn legacy_settings_default_floating_assistant_preferences() {
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        let fields = legacy.as_object_mut().unwrap();
        fields.remove("floatingAssistantEnabled");
        fields.remove("floatingAssistantPosition");

        let settings: AppSettings = serde_json::from_value(legacy).unwrap();

        assert!(settings.floating_assistant_enabled);
        assert_eq!(settings.floating_assistant_position, None);
    }
}
