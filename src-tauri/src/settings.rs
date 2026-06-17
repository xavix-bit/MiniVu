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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InferenceBackend {
    Llama,
    Mlx,
}

impl Default for InferenceBackend {
    fn default() -> Self {
        #[cfg(target_os = "macos")]
        {
            if crate::platform_caps::is_apple_silicon() {
                return Self::Mlx;
            }
        }
        Self::Llama
    }
}

fn default_mlx_model_id() -> String {
    crate::model_cache::DEFAULT_MLX_MODEL_ID.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shortcut: String,
    pub model_warm_minutes: i32,
    pub auto_check_model_updates: bool,
    pub save_history_by_default: bool,
    pub allow_cloud_fallback: bool,
    pub onboarding_complete: bool,
    pub model_path: Option<String>,
    #[serde(default)]
    pub download_mirror: DownloadMirror,
    pub preferred_mirror: Option<MirrorId>,
    pub last_speed_test_at: Option<String>,
    #[serde(default)]
    pub theme: AppTheme,
    #[serde(default = "default_preload_model")]
    pub preload_model: bool,
    #[serde(default)]
    pub inference_backend: InferenceBackend,
    #[serde(default = "default_mlx_model_id")]
    pub mlx_model_id: String,
    pub mlx_model_path: Option<String>,
}

fn default_preload_model() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut: "Control+Option+Space".to_string(),
            model_warm_minutes: -1,
            auto_check_model_updates: false,
            save_history_by_default: false,
            allow_cloud_fallback: false,
            onboarding_complete: false,
            model_path: None,
            download_mirror: DownloadMirror::Auto,
            preferred_mirror: None,
            last_speed_test_at: None,
            theme: AppTheme::System,
            preload_model: true,
            inference_backend: InferenceBackend::default(),
            mlx_model_id: default_mlx_model_id(),
            mlx_model_path: None,
        }
    }
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
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
