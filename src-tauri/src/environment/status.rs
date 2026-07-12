use crate::inference_backend::{mlx_runtime_ready, resolve_active_backend};
use crate::model_cache::{MlxModelRef, ModelCache, ModelPaths};
use crate::runtime_installer::resolve_llama_server;
use crate::settings::{load_settings, InferenceBackend};
use serde::Serialize;
use tauri::AppHandle;

/// 环境就绪状态：引导页、入口窗口路由与前端 onboarding 的单一来源。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentStatus {
    pub onboarding_complete: bool,
    pub inference_backend: InferenceBackend,
    pub runtime_ready: bool,
    pub model_ready: bool,
    pub environment_ready: bool,
}

#[derive(Debug, Clone)]
pub struct EnvironmentSnapshot {
    pub settings_onboarding_complete: bool,
    pub backend: Option<InferenceBackend>,
    pub gguf: ModelPaths,
    pub mlx: MlxModelRef,
}

pub fn evaluate_environment(app: &AppHandle) -> Result<EnvironmentSnapshot, String> {
    let settings = load_settings(app)?;
    let cache = ModelCache::new(app)?;
    let gguf =
        cache.resolve_configured(settings.gguf_model_variant, settings.model_path.as_deref());
    let mlx = cache.resolve_mlx_configured(
        settings.mlx_model_path.as_deref(),
        Some(settings.mlx_model_id.as_str()),
    );
    let backend = resolve_active_backend(settings.inference_backend, app).ok();

    Ok(EnvironmentSnapshot {
        settings_onboarding_complete: settings.onboarding_complete,
        backend,
        gguf,
        mlx,
    })
}

fn runtime_ready_for_backend(backend: InferenceBackend, app: &AppHandle) -> bool {
    match backend {
        InferenceBackend::Llama => resolve_llama_server(app).is_some(),
        InferenceBackend::Mlx => mlx_runtime_ready(app),
    }
}

pub fn models_ready_for_backend(
    backend: InferenceBackend,
    gguf: &ModelPaths,
    mlx: &MlxModelRef,
) -> bool {
    match backend {
        InferenceBackend::Llama => gguf.is_complete(),
        InferenceBackend::Mlx => mlx.is_ready(),
    }
}

fn model_ready_for_backend(
    backend: InferenceBackend,
    app: &AppHandle,
    gguf: &ModelPaths,
    mlx: &MlxModelRef,
) -> bool {
    match backend {
        InferenceBackend::Mlx => mlx_runtime_ready(app) && mlx.is_ready(),
        InferenceBackend::Llama => models_ready_for_backend(backend, gguf, mlx),
    }
}

pub fn is_environment_ready(app: &AppHandle) -> Result<bool, String> {
    let snapshot = evaluate_environment(app)?;
    let settings = load_settings(app)?;

    if !settings.onboarding_complete {
        return Ok(false);
    }

    let Some(backend) = snapshot.backend else {
        return Ok(false);
    };

    Ok(runtime_ready_for_backend(backend, app)
        && model_ready_for_backend(backend, app, &snapshot.gguf, &snapshot.mlx))
}

impl EnvironmentSnapshot {
    pub fn to_status(&self, app: &AppHandle) -> Result<EnvironmentStatus, String> {
        let settings = load_settings(app)?;
        let mlx_ready = mlx_runtime_ready(app);
        let llama_ready = resolve_llama_server(app).is_some();
        let runtime_ready = self
            .backend
            .map(|backend| match backend {
                InferenceBackend::Llama => llama_ready,
                InferenceBackend::Mlx => mlx_ready,
            })
            .unwrap_or(false);
        let model_ready = self
            .backend
            .map(|backend| match backend {
                InferenceBackend::Mlx => mlx_ready && self.mlx.is_ready(),
                InferenceBackend::Llama => models_ready_for_backend(backend, &self.gguf, &self.mlx),
            })
            .unwrap_or(false);

        Ok(EnvironmentStatus {
            onboarding_complete: settings.onboarding_complete,
            inference_backend: settings.inference_backend,
            runtime_ready,
            model_ready,
            environment_ready: settings.onboarding_complete && runtime_ready && model_ready,
        })
    }
}
