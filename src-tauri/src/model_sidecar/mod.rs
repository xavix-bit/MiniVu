use crate::environment::{evaluate_environment, is_environment_ready, EnvironmentStatus};
use crate::inference::{
    build_chat_messages, build_standalone_follow_up_prompt, emit_chunk, sidecar_health_ok,
    stream_fallback_response, stream_from_sidecar, trim_history, wait_for_sidecar_ready,
    HistoryMessage,
};
use crate::inference_backend::{
    backend_label, mlx_runtime_ready, resolve_active_backend,
};
use crate::model_cache::ModelCache;
use crate::runtime_installer::resolve_llama_server;
use crate::settings::{load_settings, InferenceBackend};
use crate::sidecar::{init_sidecar_state as sidecar_init, SidecarState};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub type GenerationFlag = Arc<AtomicBool>;

pub fn init_generation_flag() -> GenerationFlag {
    Arc::new(AtomicBool::new(false))
}

pub fn init_sidecar_state() -> SidecarState {
    sidecar_init()
}

pub use crate::environment::models_ready_for_backend;

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
    let paths = cache.resolve(settings.model_path.as_deref());
    let mlx = cache.resolve_mlx(
        settings.mlx_model_path.as_deref(),
        Some(settings.mlx_model_id.as_str()),
    );
    let mut guard = sidecar.lock().map_err(|e| e.to_string())?;
    let active = resolve_active_backend(settings.inference_backend, &app).ok();

    Ok(ModelStatusResponse {
        model_ready: active
            .map(|backend| {
                if backend == InferenceBackend::Mlx {
                    mlx_runtime_ready(&app) && mlx.is_ready()
                } else {
                    models_ready_for_backend(backend, &paths, &mlx)
                }
            })
            .unwrap_or(false),
        model_downloaded: crate::model_cache::file_is_valid(&paths.model, "model"),
        mmproj_downloaded: crate::model_cache::file_is_valid(&paths.mmproj, "mmproj"),
        model_path: paths.model.to_string_lossy().to_string(),
        mmproj_path: paths.mmproj.to_string_lossy().to_string(),
        model_size: cache
            .model_size_bytes(settings.model_path.as_deref())
            .map(crate::model_cache::format_bytes),
        sidecar_running: guard.is_running(),
        llama_server_available: resolve_llama_server(&app).is_some(),
        inference_backend: settings.inference_backend,
        active_backend: active
            .map(backend_label)
            .unwrap_or_else(|| backend_label(InferenceBackend::Llama))
            .to_string(),
        mlx_runtime_available: mlx_runtime_ready(&app),
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

    let settings = load_settings(&app)?;
    let cache = ModelCache::new(&app)?;
    let paths = cache.resolve(settings.model_path.as_deref());
    let mlx = cache.resolve_mlx(
        settings.mlx_model_path.as_deref(),
        Some(settings.mlx_model_id.as_str()),
    );
    let backend = resolve_active_backend(settings.inference_backend, &app)?;
    let models_ready = models_ready_for_backend(backend, &paths, &mlx);

    let mock_note = {
        let mut guard = sidecar.lock().map_err(|e| e.to_string())?;
        guard.touch();
        if !models_ready {
            Some(None)
        } else if let Err(error) = guard.ensure_started(&app) {
            Some(Some(error))
        } else {
            None
        }
    };

    if let Some(note) = mock_note {
        if models_ready {
            return Err(note.unwrap_or_else(|| "推理引擎启动失败".to_string()));
        }
        if backend == InferenceBackend::Mlx && mlx_runtime_ready(&app) {
            return Err(
                "MLX 模型权重尚未下载。请先在「偏好设置 → 推理引擎」或「模型文件」中下载。"
                    .to_string(),
            );
        }
        stream_fallback_response(&app, &ocr_text, &prompt, false, note).await?;
        return Ok(());
    }

    let port = {
        let guard = sidecar.lock().map_err(|e| e.to_string())?;
        guard.port
    };

    let sidecar_warm = {
        let guard = sidecar.lock().map_err(|e| e.to_string())?;
        guard.is_service_ready()
    };

    let skip_load_wait = sidecar_warm && sidecar_health_ok(port, backend).await;
    if !skip_load_wait {
        if sidecar_warm {
            if let Ok(guard) = sidecar.lock() {
                guard.set_service_ready(false);
            }
        }
        let sidecar_state = sidecar.inner().clone();
        if let Err(error) =
            wait_for_sidecar_ready(&app, port, backend, &cancel_flag, &sidecar_state).await
        {
            if cancel_flag.load(Ordering::SeqCst) {
                emit_chunk(&app, "", true)?;
                return Ok(());
            }
            if models_ready {
                return Err(error);
            }
            stream_fallback_response(&app, &ocr_text, &prompt, false, Some(error)).await?;
            return Ok(());
        }
        if let Ok(guard) = sidecar.lock() {
            guard.set_service_ready(true);
        }
    }

    let trimmed_history = trim_history(&history);
    let sidecar_warm_for_infer = skip_load_wait || sidecar_warm;
    let messages =
        build_chat_messages(&trimmed_history, &image_data_url, &ocr_text, &prompt);

    let infer_result = stream_from_sidecar(
        &app,
        port,
        &messages,
        &cancel_flag,
        sidecar_warm_for_infer,
    )
    .await;

    if let Err(error) = infer_result {
        if cancel_flag.load(Ordering::SeqCst) {
            emit_chunk(&app, "", true)?;
            return Ok(());
        }

        if !history.is_empty() {
            let fallback_prompt =
                build_standalone_follow_up_prompt(&trimmed_history, &ocr_text, &prompt);
            let fallback_messages =
                build_chat_messages(&[], &image_data_url, "", &fallback_prompt);
            if stream_from_sidecar(
                &app,
                port,
                &fallback_messages,
                &cancel_flag,
                sidecar_warm_for_infer,
            )
            .await
            .is_ok()
            {
                return Ok(());
            }
        }

        if models_ready {
            if let Ok(mut guard) = sidecar.lock() {
                if !guard.is_running() {
                    guard.set_service_ready(false);
                }
            }
            return Err(error);
        }

        stream_fallback_response(&app, &ocr_text, &prompt, false, Some(error)).await?;
    }

    Ok(())
}

#[tauri::command]
pub fn unload_model_if_idle(
    app: AppHandle,
    sidecar: tauri::State<SidecarState>,
) -> Result<(), String> {
    let settings = load_settings(&app)?;
    let mut guard = sidecar.lock().map_err(|e| e.to_string())?;
    if guard.should_unload(settings.model_warm_minutes) {
        guard.stop();
    }
    Ok(())
}

pub fn spawn_idle_unloader(app: AppHandle) {
    let sidecar = app.state::<SidecarState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let settings = match load_settings(&app) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if let Ok(mut guard) = sidecar.lock() {
                if guard.should_unload(settings.model_warm_minutes) {
                    guard.stop();
                }
            }
        }
    });
}

async fn warmup_model_inner(app: &AppHandle, sidecar: &SidecarState) -> Result<(), String> {
    let settings = load_settings(app)?;
    if !settings.preload_model {
        return Ok(());
    }

    let cache = ModelCache::new(app)?;
    let paths = cache.resolve(settings.model_path.as_deref());
    let mlx = cache.resolve_mlx(
        settings.mlx_model_path.as_deref(),
        Some(settings.mlx_model_id.as_str()),
    );
    let backend = resolve_active_backend(settings.inference_backend, app)?;
    if !models_ready_for_backend(backend, &paths, &mlx) {
        return Ok(());
    }

    let port = {
        let mut guard = sidecar.lock().map_err(|e| e.to_string())?;
        guard.touch();
        guard.ensure_started(app)?;
        guard.port
    };

    let cancel = AtomicBool::new(false);
    let sidecar_state = sidecar.clone();
    wait_for_sidecar_ready(app, port, backend, &cancel, &sidecar_state).await?;
    if let Ok(guard) = sidecar.lock() {
        guard.set_service_ready(true);
    }
    Ok(())
}

pub fn spawn_model_warmup(app: AppHandle) {
    let sidecar = app.state::<SidecarState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = warmup_model_inner(&app, &sidecar).await {
            eprintln!("模型预热: {error}");
        }
    });
}

#[tauri::command]
pub fn get_environment_status(app: AppHandle) -> Result<EnvironmentStatus, String> {
    evaluate_environment(&app)?.to_status(&app)
}

#[tauri::command]
pub fn is_app_environment_ready(app: AppHandle) -> Result<bool, String> {
    is_environment_ready(&app)
}
