use crate::environment::models_ready_for_backend;
use crate::inference_backend::resolve_active_backend;
use crate::model_cache::{MlxModelRef, ModelCache, ModelPaths};
use crate::settings::{load_settings, AppSettings, InferenceBackend};
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarIdentity {
    Llama {
        model: std::path::PathBuf,
        mmproj: std::path::PathBuf,
    },
    Mlx {
        spec: String,
    },
}

/// 当前活跃推理后端的模型路径与就绪状态（settings + ModelCache 解析的单一入口）。
pub struct ActiveInferenceContext {
    pub backend: InferenceBackend,
    pub paths: ModelPaths,
    pub mlx: MlxModelRef,
    pub models_ready: bool,
}

pub(crate) fn resolve_model_refs(
    settings: &AppSettings,
    cache: &ModelCache,
) -> (ModelPaths, MlxModelRef) {
    let paths =
        cache.resolve_configured(settings.gguf_model_variant, settings.model_path.as_deref());
    let mlx = cache.resolve_mlx_configured(
        settings.mlx_model_path.as_deref(),
        Some(settings.mlx_model_id.as_str()),
    );
    (paths, mlx)
}

impl ActiveInferenceContext {
    pub fn sidecar_identity(&self) -> SidecarIdentity {
        match self.backend {
            InferenceBackend::Llama => SidecarIdentity::Llama {
                model: self.paths.model.clone(),
                mmproj: self.paths.mmproj.clone(),
            },
            InferenceBackend::Mlx => SidecarIdentity::Mlx {
                spec: self.mlx.spec.clone(),
            },
        }
    }

    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let settings = load_settings(app)?;
        let cache = ModelCache::new(app)?;
        Self::from_parts(app, &settings, &cache)
    }

    pub fn from_parts(
        app: &AppHandle,
        settings: &AppSettings,
        cache: &ModelCache,
    ) -> Result<Self, String> {
        let (paths, mlx) = resolve_model_refs(settings, cache);
        let backend = resolve_active_backend(settings.inference_backend, app)?;
        let models_ready = models_ready_for_backend(backend, &paths, &mlx);
        Ok(Self {
            backend,
            paths,
            mlx,
            models_ready,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::models_ready_for_backend;
    use crate::model_cache::{EXPECTED_MMPROJ_BYTES, GGUF_MODEL_SPECS};
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(test_name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "minivu-context-{test_name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp directory should be created");
        path
    }

    fn write_sparse_gguf(path: &Path, bytes: u64) {
        let mut file = File::create(path).expect("test GGUF should be created");
        file.write_all(b"GGUF")
            .expect("test GGUF magic should be written");
        file.set_len(bytes).expect("test GGUF should be resized");
    }

    #[test]
    fn legacy_paths_resolve_into_context_and_model_readiness() {
        let root = temp_dir("legacy-paths");
        let managed = root.join("managed");
        let custom_gguf = root.join("custom-gguf");
        let custom_mlx = root.join("custom-mlx");
        fs::create_dir_all(&managed).unwrap();
        fs::create_dir_all(&custom_gguf).unwrap();
        fs::create_dir_all(&custom_mlx).unwrap();

        let model = custom_gguf.join("custom-model.gguf");
        let mmproj = custom_gguf.join("custom-mmproj.gguf");
        write_sparse_gguf(&model, GGUF_MODEL_SPECS[0].model_bytes);
        write_sparse_gguf(&mmproj, EXPECTED_MMPROJ_BYTES);
        fs::write(custom_mlx.join("config.json"), b"{}").unwrap();

        let settings: AppSettings = serde_json::from_value(serde_json::json!({
            "shortcut": "Control+Option+Space",
            "modelWarmMinutes": -1,
            "autoCheckModelUpdates": false,
            "saveHistoryByDefault": false,
            "allowCloudFallback": false,
            "onboardingComplete": true,
            "modelPath": custom_gguf,
            "downloadMirror": "auto",
            "preferredMirror": null,
            "lastSpeedTestAt": null,
            "theme": "system",
            "preloadModel": false,
            "inferenceBackend": "llama",
            "mlxModelId": "mlx-community/MiniCPM-V-4.6-4bit",
            "mlxModelPath": custom_mlx
        }))
        .expect("legacy settings should deserialize");
        let cache = ModelCache { root: managed };

        let (paths, mlx) = resolve_model_refs(&settings, &cache);

        assert_eq!(paths.model, model);
        assert_eq!(paths.mmproj, mmproj);
        assert_eq!(mlx.spec, custom_mlx.to_string_lossy());
        assert!(mlx.is_local);
        assert!(models_ready_for_backend(
            InferenceBackend::Llama,
            &paths,
            &mlx
        ));
        assert!(models_ready_for_backend(
            InferenceBackend::Mlx,
            &paths,
            &mlx
        ));

        fs::remove_dir_all(root).unwrap();
    }
}
