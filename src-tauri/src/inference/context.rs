use crate::environment::models_ready_for_backend;
use crate::inference_backend::resolve_active_backend;
use crate::model_cache::{MlxModelRef, ModelCache, ModelPaths};
use crate::settings::{load_settings, AppSettings, GgufModelVariant, InferenceBackend};
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
    pub gguf_model_variant: GgufModelVariant,
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
    pub fn model_label(&self) -> String {
        match self.backend {
            InferenceBackend::Llama if self.paths.is_managed() => {
                let quality = match self.gguf_model_variant {
                    GgufModelVariant::Q4KM => "Q4",
                    GgufModelVariant::Q5KM => "Q5",
                    GgufModelVariant::Q6K => "Q6",
                };
                format!("MiniCPM-V 4.6 GGUF · {quality}")
            }
            InferenceBackend::Llama => format!(
                "Custom GGUF · {}",
                path_basename(&self.paths.model, "local-model.gguf")
            ),
            InferenceBackend::Mlx if self.mlx.is_local => format!(
                "Custom MLX · {}",
                path_basename(std::path::Path::new(&self.mlx.spec), "local-model")
            ),
            InferenceBackend::Mlx => {
                let model_id = self.mlx.spec.trim();
                if model_id.is_empty() {
                    "MiniVu local model".to_string()
                } else {
                    model_id.to_string()
                }
            }
        }
    }

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
            gguf_model_variant: settings.gguf_model_variant,
        })
    }
}

fn path_basename(path: &std::path::Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::models_ready_for_backend;
    use crate::model_cache::{EXPECTED_MMPROJ_BYTES, GGUF_MODEL_SPECS};
    use crate::settings::GgufModelVariant;
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

    #[test]
    fn managed_gguf_context_labels_include_the_selected_quality() {
        let root = temp_dir("managed-labels");
        let cache = ModelCache { root: root.clone() };

        for (variant, quality) in [
            (crate::settings::GgufModelVariant::Q4KM, "Q4"),
            (crate::settings::GgufModelVariant::Q5KM, "Q5"),
            (crate::settings::GgufModelVariant::Q6K, "Q6"),
        ] {
            let context = ActiveInferenceContext {
                backend: InferenceBackend::Llama,
                paths: cache.resolve(variant),
                mlx: cache.resolve_mlx(None),
                models_ready: false,
                gguf_model_variant: variant,
            };

            assert_eq!(
                context.model_label(),
                format!("MiniCPM-V 4.6 GGUF · {quality}")
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_context_labels_only_include_the_model_basename() {
        let root = temp_dir("custom-labels");
        let managed = root.join("managed");
        let custom_gguf = root.join("private").join("vision-special.gguf");
        let custom_mlx = root.join("private").join("mlx-special");
        fs::create_dir_all(custom_gguf.parent().unwrap()).unwrap();
        fs::create_dir_all(&custom_mlx).unwrap();
        fs::write(&custom_gguf, b"GGUF").unwrap();
        fs::write(custom_mlx.join("config.json"), b"{}").unwrap();
        let cache = ModelCache { root: managed };

        let gguf_context = ActiveInferenceContext {
            backend: InferenceBackend::Llama,
            paths: cache.resolve_configured(GgufModelVariant::Q4KM, custom_gguf.to_str()),
            mlx: cache.resolve_mlx(None),
            models_ready: true,
            gguf_model_variant: GgufModelVariant::Q4KM,
        };
        let mlx_context = ActiveInferenceContext {
            backend: InferenceBackend::Mlx,
            paths: cache.resolve(GgufModelVariant::Q4KM),
            mlx: cache.resolve_mlx_configured(custom_mlx.to_str(), None),
            models_ready: true,
            gguf_model_variant: GgufModelVariant::Q4KM,
        };

        assert_eq!(
            gguf_context.model_label(),
            "Custom GGUF · vision-special.gguf"
        );
        assert_eq!(mlx_context.model_label(), "Custom MLX · mlx-special");
        assert!(!gguf_context.model_label().contains("private"));
        assert!(!mlx_context.model_label().contains("private"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mlx_hub_context_label_is_the_model_id() {
        let root = temp_dir("mlx-hub-label");
        let cache = ModelCache { root: root.clone() };
        let context = ActiveInferenceContext {
            backend: InferenceBackend::Mlx,
            paths: cache.resolve(GgufModelVariant::Q4KM),
            mlx: cache.resolve_mlx(Some("org/vision-model")),
            models_ready: false,
            gguf_model_variant: GgufModelVariant::Q4KM,
        };

        assert_eq!(context.model_label(), "org/vision-model");

        fs::remove_dir_all(root).unwrap();
    }
}
