use crate::environment::models_ready_for_backend;
use crate::inference_backend::{mlx_runtime_ready, resolve_active_backend};
use crate::runtime_installer::{
    emit_setup_progress, install_llama_runtime, install_mlx_runtime, resolve_llama_server,
};
use crate::settings::{load_settings, InferenceBackend};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupEnvironmentResult {
    pub runtime_ready: bool,
    pub model_ready: bool,
    pub shortcut: String,
}

pub async fn setup_environment(app: AppHandle) -> Result<SetupEnvironmentResult, String> {
    use crate::commands::get_device_info;
    use crate::model_cache::ModelCache;
    use crate::model_download::{download_mlx_model, download_model};

    emit_setup_progress(&app, "device", "running", "正在检测本机配置…", 0);
    let device = get_device_info();
    let device_message = format!(
        "{}（{} · {:.1} GB）",
        device.message, device.platform, device.memory_gb
    );
    emit_setup_progress(&app, "device", "done", &device_message, 100);

    let settings = load_settings(&app)?;
    let backend = settings.inference_backend;

    match backend {
        InferenceBackend::Mlx => {
            install_mlx_runtime(&app).await?;
        }
        InferenceBackend::Llama => {
            install_llama_runtime(&app).await?;
        }
    }

    let settings = load_settings(&app)?;
    let cache = ModelCache::new(&app)?;
    let paths = cache.resolve(settings.gguf_model_variant);
    let mlx = cache.resolve_mlx(Some(settings.mlx_model_id.as_str()));

    if backend == InferenceBackend::Llama && !paths.is_complete() {
        emit_setup_progress(&app, "model", "running", "正在下载主模型…", 0);
        emit_setup_progress(&app, "mmproj", "waiting", "等待主模型完成后开始…", 0);
        download_model(app.clone(), None).await?;
        emit_setup_progress(&app, "mmproj", "done", "图片理解支持已下载", 100);
        emit_setup_progress(&app, "model", "done", "主模型已下载", 100);
    } else if backend == InferenceBackend::Mlx {
        if !mlx.is_ready() {
            emit_setup_progress(&app, "model", "running", "正在下载加速模型…", 0);
            emit_setup_progress(&app, "mmproj", "waiting", "等待模型下载完成…", 0);
            download_mlx_model(app.clone(), None).await?;
        } else {
            emit_setup_progress(&app, "model", "done", "加速模型已下载", 100);
            emit_setup_progress(&app, "mmproj", "done", "图片理解支持已准备", 100);
        }
    } else {
        emit_setup_progress(&app, "mmproj", "done", "图片理解支持已下载", 100);
        emit_setup_progress(&app, "model", "done", "主模型已下载", 100);
    }

    let settings = crate::commands::ensure_setup_shortcut(&app)?;
    emit_setup_progress(
        &app,
        "shortcut",
        "done",
        &format!("快捷键已设置为 {}", settings.shortcut),
        100,
    );

    let refreshed = load_settings(&app)?;
    let cache = ModelCache::new(&app)?;
    let paths = cache.resolve(refreshed.gguf_model_variant);
    let mlx = cache.resolve_mlx(Some(refreshed.mlx_model_id.as_str()));
    let active = resolve_active_backend(refreshed.inference_backend, &app).ok();

    emit_setup_progress(&app, "done", "done", "准备完成", 100);

    let runtime_ready = match refreshed.inference_backend {
        InferenceBackend::Mlx => mlx_runtime_ready(&app),
        InferenceBackend::Llama => resolve_llama_server(&app).is_some(),
    };

    Ok(SetupEnvironmentResult {
        runtime_ready,
        model_ready: active
            .map(|value| {
                if value == InferenceBackend::Mlx {
                    mlx_runtime_ready(&app) && mlx.is_ready()
                } else {
                    models_ready_for_backend(value, &paths, &mlx)
                }
            })
            .unwrap_or(false),
        shortcut: refreshed.shortcut,
    })
}
