use crate::environment::{evaluate_environment, is_environment_ready, EnvironmentStatus};
use crate::inference::{
    build_chat_messages, build_standalone_follow_up_prompt, emit_chunk, sidecar_health_ok,
    sidecar_request_model, stream_from_sidecar, trim_history, wait_for_sidecar_ready, HistoryMessage,
};
use crate::inference_backend::{
    backend_label, mlx_runtime_ready, resolve_active_backend,
};
use crate::model_cache::ModelCache;
use crate::runtime_installer::resolve_llama_server;
use crate::settings::{load_settings, InferenceBackend};
use crate::sidecar::{lock_sidecar, init_sidecar_state as sidecar_init, SidecarState};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub type GenerationFlag = Arc<AtomicBool>;

pub fn init_generation_flag() -> GenerationFlag {
    Arc::new(AtomicBool::new(false))
}

pub fn init_sidecar_state() -> SidecarState {
    sidecar_init()
}

pub use crate::environment::models_ready_for_backend;

fn model_not_ready_message(backend: InferenceBackend, app: &AppHandle) -> String {
    match backend {
        InferenceBackend::Mlx => {
            if mlx_runtime_ready(app) {
                "模型权重尚未下载。请前往「环境配置」或「模型文件」下载 MLX 权重（约 2 GB）。"
                    .to_string()
            } else {
                "MLX 推理引擎未安装。请前往「环境配置」完成安装。".to_string()
            }
        }
        InferenceBackend::Llama => {
            "GGUF 模型尚未下载。请前往「环境配置」或「模型文件」下载主模型与 mmproj（约 6 GB）。"
                .to_string()
        }
    }
}

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
    let mut guard = lock_sidecar(sidecar.inner());
    let active = resolve_active_backend(settings.inference_backend, &app).ok();
    let mlx_ready = mlx_runtime_ready(&app);

    Ok(ModelStatusResponse {
        model_ready: active
            .map(|backend| {
                if backend == InferenceBackend::Mlx {
                    mlx_ready && mlx.is_ready()
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

    let settings = load_settings(&app)?;
    let cache = ModelCache::new(&app)?;
    let paths = cache.resolve(settings.model_path.as_deref());
    let mlx = cache.resolve_mlx(
        settings.mlx_model_path.as_deref(),
        Some(settings.mlx_model_id.as_str()),
    );
    let backend = resolve_active_backend(settings.inference_backend, &app)?;
    let models_ready = models_ready_for_backend(backend, &paths, &mlx);

    if !models_ready {
        return Err(model_not_ready_message(backend, &app));
    }

    {
        let mut guard = lock_sidecar(sidecar.inner());
        guard.touch();
        guard.ensure_started(&app)?;
    }

    let port = {
        let guard = lock_sidecar(sidecar.inner());
        guard.port
    };

    let sidecar_warm = {
        let guard = lock_sidecar(sidecar.inner());
        guard.is_service_ready()
    };

    let skip_load_wait = sidecar_warm && sidecar_health_ok(port, backend).await;
    if !skip_load_wait {
        if sidecar_warm {
            lock_sidecar(sidecar.inner()).set_service_ready(false);
        }
        let sidecar_state = sidecar.inner().clone();
        if let Err(error) =
            wait_for_sidecar_ready(&app, port, backend, &cancel_flag, &sidecar_state).await
        {
            if cancel_flag.load(Ordering::SeqCst) {
                emit_chunk(&app, "", true)?;
                return Ok(());
            }
            return Err(error);
        }
        lock_sidecar(sidecar.inner()).set_service_ready(true);
    }

    let trimmed_history = trim_history(&history);
    let sidecar_warm_for_infer = skip_load_wait || sidecar_warm;
    let messages =
        build_chat_messages(&trimmed_history, &image_data_url, &ocr_text, &prompt);
    let request_model = sidecar_request_model(backend, &mlx);

    let infer_result = stream_from_sidecar(
        &app,
        port,
        &request_model,
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
                &request_model,
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
            let mut guard = lock_sidecar(sidecar.inner());
            if !guard.is_running() {
                guard.set_service_ready(false);
            }
            return Err(error);
        }

        return Err(error);
    }

    Ok(())
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

pub fn spawn_idle_unloader(app: AppHandle) {
    let sidecar = app.state::<SidecarState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let settings = match load_settings(&app) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let mut guard = lock_sidecar(&sidecar);
            if guard.should_unload(settings.model_warm_minutes) {
                guard.stop();
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
        let mut guard = lock_sidecar(sidecar);
        guard.touch();
        guard.ensure_started(app)?;
        guard.port
    };

    let cancel = AtomicBool::new(false);
    let sidecar_state = sidecar.clone();
    wait_for_sidecar_ready(app, port, backend, &cancel, &sidecar_state).await?;
    lock_sidecar(sidecar).set_service_ready(true);
    Ok(())
}

pub fn spawn_model_warmup(app: AppHandle) {
    let sidecar = app.state::<SidecarState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let settings = match load_settings(&app) {
            Ok(value) => value,
            Err(_) => return,
        };
        if !settings.preload_model {
            return;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Err(error) = warmup_model_inner(&app, &sidecar).await {
            eprintln!("模型预热: {error}");
            let _ = app.emit("warmup-failed", serde_json::json!({ "message": error }));
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
