use crate::environment::models_ready_for_backend;
use crate::inference::backends::read_mlx_sidecar_log_tail;
use crate::inference_backend::backend_label;
use crate::model_cache::ModelCache;
use crate::settings::{load_settings, InferenceBackend};
use crate::sidecar::{lock_sidecar, SidecarState};
use reqwest::Client;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SIDECAR_READY_POLL: Duration = Duration::from_millis(500);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SidecarLoadProgress {
    elapsed_sec: u64,
    message: String,
    backend: String,
}

pub fn emit_sidecar_load_progress(
    app: &AppHandle,
    backend: InferenceBackend,
    elapsed_sec: u64,
    weights_on_disk: bool,
) {
    let message = match backend {
        InferenceBackend::Mlx => {
            if weights_on_disk {
                if elapsed_sec < 10 {
                    "正在启动 MLX 服务…".to_string()
                } else {
                    "正在加载模型…".to_string()
                }
            } else if elapsed_sec < 10 {
                "正在启动 MLX 服务…".to_string()
            } else {
                "正在下载模型…".to_string()
            }
        }
        InferenceBackend::Llama => {
            if elapsed_sec < 30 {
                "正在启动 llama-server…".to_string()
            } else {
                "正在加载模型…".to_string()
            }
        }
    };
    let _ = app.emit(
        "sidecar-load-progress",
        SidecarLoadProgress {
            elapsed_sec,
            message,
            backend: backend_label(backend).to_string(),
        },
    );
}

pub fn sidecar_health_ok_blocking(port: u16, backend: InferenceBackend) -> bool {
    std::thread::spawn(move || tauri::async_runtime::block_on(sidecar_health_ok(port, backend)))
        .join()
        .unwrap_or(false)
}

pub async fn sidecar_health_ok(port: u16, backend: InferenceBackend) -> bool {
    let client = match Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(value) => value,
        Err(_) => return false,
    };
    let url = format!("http://127.0.0.1:{port}/health");
    let Ok(response) = client.get(&url).send().await else {
        return false;
    };
    sidecar_health_response_ready(response, backend).await
}

async fn sidecar_health_response_ready(
    response: reqwest::Response,
    backend: InferenceBackend,
) -> bool {
    if !response.status().is_success() {
        return false;
    }
    if backend == InferenceBackend::Mlx {
        let Ok(json) = response.json::<serde_json::Value>().await else {
            return false;
        };
        return json
            .get("loaded_model")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.is_empty());
    }
    true
}

fn weights_on_disk(app: &AppHandle, backend: InferenceBackend) -> Result<bool, String> {
    let settings = load_settings(app)?;
    let cache = ModelCache::new(app)?;
    let paths = cache.resolve(settings.gguf_model_variant);
    let mlx = cache.resolve_mlx(Some(settings.mlx_model_id.as_str()));
    Ok(models_ready_for_backend(backend, &paths, &mlx))
}

pub fn format_mlx_sidecar_exit_error(tail: &str) -> String {
    if tail.contains("address already in use") || tail.contains("[Errno 48]") {
        return "推理端口被占用。请关闭其他 MiniVu 窗口后重试。".to_string();
    }
    if tail.is_empty() {
        return "MLX 已退出，请重试。".to_string();
    }
    "MLX 异常退出，请重试。".to_string()
}

pub fn format_sidecar_load_timeout(
    backend: InferenceBackend,
    weights_on_disk: bool,
    tail: &str,
) -> String {
    match backend {
        InferenceBackend::Mlx if !weights_on_disk => "模型下载超时，请重试。".to_string(),
        InferenceBackend::Mlx => {
            if tail.contains("address already in use") {
                return format_mlx_sidecar_exit_error(tail);
            }
            "模型加载超时，请稍后重试。".to_string()
        }
        InferenceBackend::Llama => "模型加载超时，请稍后重试。".to_string(),
    }
}

pub async fn wait_for_sidecar_ready(
    app: &AppHandle,
    port: u16,
    backend: InferenceBackend,
    generation: u64,
    cancel: &AtomicBool,
    sidecar: &SidecarState,
) -> Result<(), String> {
    let mut weights_cached = weights_on_disk(app, backend)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/health");
    let timeout = match backend {
        InferenceBackend::Mlx => Duration::from_secs(900),
        InferenceBackend::Llama => Duration::from_secs(300),
    };
    let deadline = Instant::now() + timeout;
    let started = Instant::now();
    let mut last_progress_emit = Instant::now();

    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".to_string());
        }

        let child_alive = {
            let mut guard = lock_sidecar(sidecar);
            if guard.generation() != Some(generation) {
                return Err("模型已切换，请重试。".to_string());
            }
            guard.is_child_alive()?
        };
        if !child_alive {
            let tail = read_mlx_sidecar_log_tail(app, 8);
            if backend == InferenceBackend::Mlx {
                eprintln!("MLX sidecar exit log:\n{tail}");
                return Err(format_mlx_sidecar_exit_error(&tail));
            }
            return Err("推理进程已退出，请重试。".to_string());
        }

        if last_progress_emit.elapsed() >= Duration::from_secs(1) {
            weights_cached = weights_on_disk(app, backend).unwrap_or(weights_cached);
            emit_sidecar_load_progress(app, backend, started.elapsed().as_secs(), weights_cached);
            last_progress_emit = Instant::now();
        }

        match client.get(&url).send().await {
            Ok(response) => {
                if sidecar_health_response_ready(response, backend).await {
                    return Ok(());
                }
            }
            Err(_) => {}
        }
        tokio::time::sleep(SIDECAR_READY_POLL).await;
    }

    let tail = read_mlx_sidecar_log_tail(app, 6);
    if !tail.is_empty() {
        eprintln!("MLX sidecar timeout log:\n{tail}");
    }
    Err(format_sidecar_load_timeout(backend, weights_cached, &tail))
}
