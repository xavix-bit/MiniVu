use crate::environment::{evaluate_environment, is_environment_ready, EnvironmentStatus};
use crate::inference::{
    run_ask_image, ActiveInferenceContext, AskImageRequest, GenerationFlag, HistoryMessage,
};
use crate::inference_backend::{backend_label, mlx_runtime_ready, resolve_active_backend};
use crate::model_cache::ModelCache;
use crate::runtime_installer::resolve_llama_server;
use crate::settings::{load_settings, GgufModelVariant, InferenceBackend};
use crate::sidecar::lifecycle::{warmup_model_inner, WarmupTrigger};
use crate::sidecar::{init_sidecar_state as sidecar_init, lock_sidecar, SidecarState};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::AppHandle;

pub use crate::environment::models_ready_for_backend;

pub fn init_sidecar_state() -> SidecarState {
    sidecar_init()
}

pub use crate::inference::init_generation_flag;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatusResponse {
    pub model_ready: bool,
    pub model_downloaded: bool,
    pub mmproj_downloaded: bool,
    pub model_path: String,
    pub mmproj_path: String,
    pub model_size: Option<String>,
    pub sidecar_running: bool,
    pub llama_server_available: bool,
    pub inference_backend: InferenceBackend,
    pub gguf_model_variant: GgufModelVariant,
    pub active_backend: String,
    pub mlx_runtime_available: bool,
    pub mlx_model_id: String,
    pub mlx_model_ready: bool,
    pub mlx_requires_network: bool,
}

#[tauri::command]
pub fn cancel_generation(cancel: tauri::State<GenerationFlag>) {
    cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn get_model_status(
    app: AppHandle,
    sidecar: tauri::State<SidecarState>,
) -> Result<ModelStatusResponse, String> {
    let settings = load_settings(&app)?;
    let cache = ModelCache::new(&app)?;
    let ctx = ActiveInferenceContext::from_parts(&app, &settings, &cache)?;
    let paths = &ctx.paths;
    let mlx = &ctx.mlx;
    let mut guard = lock_sidecar(sidecar.inner());
    let active = resolve_active_backend(settings.inference_backend, &app).ok();
    let mlx_ready = mlx_runtime_ready(&app);

    Ok(ModelStatusResponse {
        model_ready: active
            .map(|backend| {
                if backend == InferenceBackend::Mlx {
                    mlx_ready && mlx.is_ready()
                } else {
                    models_ready_for_backend(backend, paths, mlx)
                }
            })
            .unwrap_or(false),
        model_downloaded: crate::model_cache::file_is_valid(&paths.model, "model"),
        mmproj_downloaded: crate::model_cache::file_is_valid(&paths.mmproj, "mmproj"),
        model_path: paths.model.to_string_lossy().to_string(),
        mmproj_path: paths.mmproj.to_string_lossy().to_string(),
        model_size: cache
            .model_size_bytes(settings.gguf_model_variant)
            .map(crate::model_cache::format_bytes),
        sidecar_running: guard.is_running(),
        llama_server_available: resolve_llama_server(&app).is_some(),
        inference_backend: settings.inference_backend,
        gguf_model_variant: settings.gguf_model_variant,
        active_backend: active
            .map(backend_label)
            .unwrap_or_else(|| backend_label(InferenceBackend::Llama))
            .to_string(),
        mlx_runtime_available: mlx_ready,
        mlx_model_id: mlx.spec.clone(),
        mlx_model_ready: mlx.is_ready(),
        mlx_requires_network: mlx.requires_network_on_first_run(),
    })
}

#[tauri::command]
pub async fn ask_image(
    app: AppHandle,
    sidecar: tauri::State<'_, SidecarState>,
    cancel: tauri::State<'_, GenerationFlag>,
    image_data_url: String,
    ocr_text: String,
    prompt: String,
    history: Vec<HistoryMessage>,
) -> Result<(), String> {
    let cancel_flag = cancel.inner().clone();
    cancel_flag.store(false, Ordering::SeqCst);
    run_ask_image(
        &app,
        sidecar.inner(),
        &cancel_flag,
        AskImageRequest {
            image_data_url,
            ocr_text,
            prompt,
            history,
        },
    )
    .await
}

#[tauri::command]
pub async fn warmup_model(
    app: AppHandle,
    sidecar: tauri::State<'_, SidecarState>,
) -> Result<(), String> {
    warmup_model_inner(&app, sidecar.inner(), WarmupTrigger::UserImage).await
}

#[tauri::command]
pub fn unload_model_if_idle(
    app: AppHandle,
    sidecar: tauri::State<SidecarState>,
) -> Result<(), String> {
    let settings = load_settings(&app)?;
    let mut guard = lock_sidecar(sidecar.inner());
    if guard.should_unload(settings.model_warm_minutes) {
        guard.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn get_environment_status(app: AppHandle) -> Result<EnvironmentStatus, String> {
    evaluate_environment(&app)?.to_status(&app)
}

#[tauri::command]
pub fn is_app_environment_ready(app: AppHandle) -> Result<bool, String> {
    is_environment_ready(&app)
}
