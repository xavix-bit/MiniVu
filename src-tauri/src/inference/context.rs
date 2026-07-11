use crate::environment::models_ready_for_backend;
use crate::inference_backend::resolve_active_backend;
use crate::model_cache::{MlxModelRef, ModelCache, ModelPaths};
use crate::settings::{load_settings, AppSettings, InferenceBackend};
use tauri::AppHandle;

/// 当前活跃推理后端的模型路径与就绪状态（settings + ModelCache 解析的单一入口）。
pub struct ActiveInferenceContext {
    pub backend: InferenceBackend,
    pub paths: ModelPaths,
    pub mlx: MlxModelRef,
    pub models_ready: bool,
}

impl ActiveInferenceContext {
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
        let paths = cache.resolve(settings.gguf_model_variant);
        let mlx = cache.resolve_mlx(Some(settings.mlx_model_id.as_str()));
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
