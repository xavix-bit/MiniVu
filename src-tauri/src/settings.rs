use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static SETTINGS_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static SETTINGS_UPDATE_LOCK: Mutex<()> = Mutex::new(());

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SettingsSaveIntent {
    #[default]
    General,
    ModelVariant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shortcut: String,
    pub model_warm_minutes: i32,
    pub auto_check_model_updates: bool,
    pub save_history_by_default: bool,
    pub allow_cloud_fallback: bool,
    pub onboarding_complete: bool,
    /// Deprecated compatibility field from origin/main. Managed variants remain the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_path: Option<String>,
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
    /// Deprecated compatibility field from origin/main. Hub model IDs remain the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mlx_model_path: Option<String>,
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
            model_path: None,
            gguf_model_variant: GgufModelVariant::default(),
            download_mirror: DownloadMirror::Auto,
            preferred_mirror: None,
            last_speed_test_at: None,
            theme: AppTheme::System,
            preload_model: default_preload_model(),
            inference_backend: InferenceBackend::default(),
            mlx_model_id: default_mlx_model_id(),
            mlx_model_path: None,
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

pub fn update_settings(
    app: &AppHandle,
    update: impl FnOnce(&mut AppSettings),
) -> Result<AppSettings, String> {
    update_settings_at(&settings_path(app)?, update)
}

fn write_settings_atomically(path: &Path, settings: &AppSettings) -> Result<(), String> {
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
        fs::rename(&temp_path, path)?;
        #[cfg(unix)]
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result.map_err(|e| e.to_string())
}

fn update_settings_at(
    path: &Path,
    update: impl FnOnce(&mut AppSettings),
) -> Result<AppSettings, String> {
    update_settings_at_with_hook(path, || {}, update)
}

fn update_settings_at_with_hook(
    path: &Path,
    after_update: impl FnOnce(),
    update: impl FnOnce(&mut AppSettings),
) -> Result<AppSettings, String> {
    let _guard = SETTINGS_UPDATE_LOCK
        .lock()
        .map_err(|_| "settings update lock is poisoned".to_string())?;
    let mut settings = load_settings_at(path)?;
    update(&mut settings);
    after_update();
    write_settings_atomically(path, &settings)?;
    Ok(settings)
}

fn save_app_settings_at(
    path: &Path,
    incoming: AppSettings,
    intent: SettingsSaveIntent,
) -> Result<AppSettings, String> {
    update_settings_at(path, move |current| match intent {
        SettingsSaveIntent::General => {
            let persisted_variant = current.gguf_model_variant;
            let persisted_model_path = current.model_path.clone();
            let persisted_mlx_model_path = current.mlx_model_path.clone();
            *current = incoming;
            current.gguf_model_variant = persisted_variant;
            if current.model_path.is_none() {
                current.model_path = persisted_model_path;
            }
            if current.mlx_model_path.is_none() {
                current.mlx_model_path = persisted_mlx_model_path;
            }
        }
        SettingsSaveIntent::ModelVariant => {
            current.gguf_model_variant = incoming.gguf_model_variant;
        }
    })
}

pub(crate) fn save_app_settings(
    app: &AppHandle,
    settings: AppSettings,
    intent: SettingsSaveIntent,
) -> Result<AppSettings, String> {
    save_app_settings_at(&settings_path(app)?, settings, intent)
}

pub(crate) fn commit_gguf_model_variant(
    app: &AppHandle,
    variant: GgufModelVariant,
) -> Result<(), String> {
    commit_gguf_model_variant_at(&settings_path(app)?, variant)
}

fn commit_gguf_model_variant_at(path: &Path, variant: GgufModelVariant) -> Result<(), String> {
    update_settings_at(path, |settings| settings.gguf_model_variant = variant).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::TryLockError;
    use std::thread;
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
    fn legacy_model_paths_are_deserialized_without_being_discarded() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({
            "shortcut": "Control+Option+Space",
            "modelWarmMinutes": -1,
            "autoCheckModelUpdates": false,
            "saveHistoryByDefault": false,
            "allowCloudFallback": false,
            "onboardingComplete": true,
            "modelPath": "/tmp/custom-gguf",
            "downloadMirror": "auto",
            "preferredMirror": null,
            "lastSpeedTestAt": null,
            "theme": "system",
            "preloadModel": false,
            "inferenceBackend": "mlx",
            "mlxModelId": "mlx-community/MiniCPM-V-4.6-4bit",
            "mlxModelPath": "/tmp/custom-mlx"
        }))
        .expect("origin/main settings should remain readable");

        assert_eq!(settings.model_path.as_deref(), Some("/tmp/custom-gguf"));
        assert_eq!(settings.mlx_model_path.as_deref(), Some("/tmp/custom-mlx"));
        assert_eq!(settings.gguf_model_variant, GgufModelVariant::Q4KM);
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
        save_app_settings_at(&path, stale_submission, SettingsSaveIntent::General)
            .expect("general settings should be saved");

        let raw = fs::read_to_string(&path).expect("saved settings should be readable");
        let saved: AppSettings =
            serde_json::from_str(&raw).expect("saved settings should be parseable");
        assert_eq!(saved.gguf_model_variant, GgufModelVariant::Q6K);
        assert_eq!(saved.shortcut, "Control+Shift+M");

        fs::remove_dir_all(root).expect("temp directory should be removed");
    }

    #[test]
    fn generic_settings_save_preserves_legacy_paths_when_submission_omits_them() {
        let root = temp_dir("legacy-path-save");
        let path = root.join("settings.json");
        let mut current = AppSettings::default();
        current.model_path = Some("/tmp/custom-gguf".to_string());
        current.mlx_model_path = Some("/tmp/custom-mlx".to_string());
        write_settings_atomically(&path, &current).expect("current settings should be written");

        let mut incoming = AppSettings::default();
        incoming.shortcut = "Control+Shift+M".to_string();
        save_app_settings_at(&path, incoming, SettingsSaveIntent::General)
            .expect("general settings should be saved");

        let saved = load_settings_at(&path).expect("saved settings should be readable");
        assert_eq!(saved.model_path, current.model_path);
        assert_eq!(saved.mlx_model_path, current.mlx_model_path);
        assert_eq!(saved.shortcut, "Control+Shift+M");

        fs::remove_dir_all(root).expect("temp directory should be removed");
    }

    #[test]
    fn general_settings_save_preserves_variant_for_variant_only_submission() {
        let root = temp_dir("general-variant-only");
        let path = root.join("settings.json");
        let current = AppSettings::default();
        write_settings_atomically(&path, &current).expect("current settings should be written");

        let mut variant_only_submission = current.clone();
        variant_only_submission.gguf_model_variant = GgufModelVariant::Q5KM;
        save_app_settings_at(&path, variant_only_submission, SettingsSaveIntent::General)
            .expect("general settings should be saved");

        let saved = load_settings_at(&path).expect("saved settings should be readable");
        assert_eq!(saved.gguf_model_variant, GgufModelVariant::Q4KM);

        fs::remove_dir_all(root).expect("temp directory should be removed");
    }

    #[test]
    fn model_variant_save_intent_accepts_incoming_variant() {
        let root = temp_dir("model-variant-intent");
        let path = root.join("settings.json");
        let mut current = AppSettings::default();
        current.shortcut = "Control+Shift+M".to_string();
        write_settings_atomically(&path, &current).expect("current settings should be written");

        let mut variant_submission = AppSettings::default();
        variant_submission.gguf_model_variant = GgufModelVariant::Q5KM;
        save_app_settings_at(&path, variant_submission, SettingsSaveIntent::ModelVariant)
            .expect("model variant settings should be saved");

        let saved = load_settings_at(&path).expect("saved settings should be readable");
        assert_eq!(saved.gguf_model_variant, GgufModelVariant::Q5KM);
        assert_eq!(saved.shortcut, "Control+Shift+M");

        fs::remove_dir_all(root).expect("temp directory should be removed");
    }

    #[test]
    fn locked_field_update_cannot_overwrite_concurrent_variant_commit() {
        let root = temp_dir("serialized-update");
        let path = root.join("settings.json");
        let current = AppSettings::default();
        write_settings_atomically(&path, &current).expect("current settings should be written");

        let update_path = path.clone();
        let (update_locked_tx, update_locked_rx) = mpsc::channel();
        let (release_update_tx, release_update_rx) = mpsc::channel();
        let update = thread::spawn(move || {
            update_settings_at_with_hook(
                &update_path,
                || {
                    update_locked_tx
                        .send(())
                        .expect("update lock signal should be sent");
                    release_update_rx
                        .recv()
                        .expect("field update should be released");
                },
                |settings| settings.shortcut = "Control+Shift+M".to_string(),
            )
            .expect("field update should be saved");
        });

        update_locked_rx
            .recv()
            .expect("field update should hold the settings lock");
        assert!(matches!(
            SETTINGS_UPDATE_LOCK.try_lock(),
            Err(TryLockError::WouldBlock)
        ));

        let commit_path = path.clone();
        let (commit_started_tx, commit_started_rx) = mpsc::channel();
        let commit = thread::spawn(move || {
            commit_started_tx
                .send(())
                .expect("commit start should be sent");
            commit_gguf_model_variant_at(&commit_path, GgufModelVariant::Q6K)
                .expect("variant should be committed");
        });

        commit_started_rx
            .recv()
            .expect("variant commit should be attempted");
        release_update_tx
            .send(())
            .expect("field update should be released");
        update.join().expect("field update thread should finish");
        commit.join().expect("variant commit thread should finish");

        let saved = load_settings_at(&path).expect("saved settings should be readable");
        assert_eq!(saved.gguf_model_variant, GgufModelVariant::Q6K);
        assert_eq!(saved.shortcut, "Control+Shift+M");

        fs::remove_dir_all(root).expect("temp directory should be removed");
    }
}
