use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

static SETTINGS_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shortcut: String,
    pub model_warm_minutes: i32,
    pub auto_check_model_updates: bool,
    pub save_history_by_default: bool,
    pub allow_cloud_fallback: bool,
    pub onboarding_complete: bool,
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
    pub inference_backend: InferenceBackend,
    #[serde(default = "default_mlx_model_id")]
    pub mlx_model_id: String,
}

fn default_preload_model() -> bool {
    false
}

impl AppSettings {
    pub fn default_for_device() -> Self {
        let mut settings = Self::default();
        if crate::platform_caps::system_memory_gb() < 16.0 {
            settings.model_warm_minutes = 15;
        }
        settings
    }
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
            gguf_model_variant: GgufModelVariant::default(),
            download_mirror: DownloadMirror::Auto,
            preferred_mirror: None,
            last_speed_test_at: None,
            theme: AppTheme::System,
            preload_model: default_preload_model(),
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
    load_settings_at(&path)
}

fn load_settings_at(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default_for_device());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    write_settings_atomically(&path, settings)
}

pub(crate) fn write_settings_atomically(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "settings path has no file name".to_string())?
        .to_string_lossy();
    let counter = SETTINGS_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        counter
    ));

    let result = (|| -> std::io::Result<()> {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        temp.write_all(raw.as_bytes())?;
        temp.flush()?;
        temp.sync_all()?;
        drop(temp);
        fs::rename(&temp_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result.map_err(|e| e.to_string())
}

fn save_settings_preserving_gguf_variant_at(
    path: &Path,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.gguf_model_variant = load_settings_at(path)?.gguf_model_variant;
    write_settings_atomically(path, &settings)?;
    Ok(settings)
}

pub(crate) fn save_settings_preserving_gguf_variant(
    app: &AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    save_settings_preserving_gguf_variant_at(&settings_path(app)?, settings)
}

pub(crate) fn commit_gguf_model_variant(
    app: &AppHandle,
    variant: GgufModelVariant,
) -> Result<(), String> {
    let mut settings = load_settings(app)?;
    settings.gguf_model_variant = variant;
    save_settings(app, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(test_name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "minivu-settings-{test_name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp directory should be created");
        path
    }

    #[test]
    fn atomic_writer_produces_parseable_settings_without_lingering_temp_file() {
        let root = temp_dir("atomic-write");
        let path = root.join("settings.json");
        let mut settings = AppSettings::default();
        settings.gguf_model_variant = GgufModelVariant::Q5KM;

        write_settings_atomically(&path, &settings).expect("settings should be written");

        let raw = fs::read_to_string(&path).expect("settings should be readable");
        let saved: AppSettings = serde_json::from_str(&raw).expect("settings should be parseable");
        assert_eq!(saved.gguf_model_variant, GgufModelVariant::Q5KM);
        let entries: Vec<_> = fs::read_dir(&root)
            .expect("temp directory should be readable")
            .map(|entry| {
                entry
                    .expect("directory entry should be readable")
                    .file_name()
            })
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("settings.json")]);

        fs::remove_dir_all(root).expect("temp directory should be removed");
    }

    #[test]
    fn generic_settings_save_preserves_current_gguf_variant() {
        let root = temp_dir("stale-variant");
        let path = root.join("settings.json");
        let mut current = AppSettings::default();
        current.gguf_model_variant = GgufModelVariant::Q6K;
        write_settings_atomically(&path, &current).expect("current settings should be written");

        let mut stale_submission = AppSettings::default();
        stale_submission.gguf_model_variant = GgufModelVariant::Q4KM;
        stale_submission.shortcut = "Control+Shift+M".to_string();
        save_settings_preserving_gguf_variant_at(&path, stale_submission)
            .expect("generic settings should be saved");

        let raw = fs::read_to_string(&path).expect("saved settings should be readable");
        let saved: AppSettings =
            serde_json::from_str(&raw).expect("saved settings should be parseable");
        assert_eq!(saved.gguf_model_variant, GgufModelVariant::Q6K);
        assert_eq!(saved.shortcut, "Control+Shift+M");

        fs::remove_dir_all(root).expect("temp directory should be removed");
    }
}
