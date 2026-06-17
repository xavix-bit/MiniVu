use crate::inference_backend::backend_label;
use crate::inference::backends::read_mlx_sidecar_log_tail;
use crate::sidecar::SidecarState;
use crate::settings::InferenceBackend;
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

pub fn emit_sidecar_load_progress(app: &AppHandle, backend: InferenceBackend, elapsed_sec: u64) {
    let message = match backend {
        InferenceBackend::Mlx => {
            if elapsed_sec < 15 {
                "正在启动 MLX 服务…".to_string()
            } else if elapsed_sec < 120 {
                "正在从 HuggingFace 下载 MLX 权重（约 2GB，仅首次）…".to_string()
            } else {
                "正在将 MLX 模型载入内存…".to_string()
            }
        }
        InferenceBackend::Llama => {
            if elapsed_sec < 30 {
                "正在启动 llama-server…".to_string()
            } else {
                "正在将 GGUF 模型载入内存…".to_string()
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

pub async fn wait_for_sidecar_ready(
    app: &AppHandle,
    port: u16,
    backend: InferenceBackend,
    cancel: &AtomicBool,
    sidecar: &SidecarState,
) -> Result<(), String> {
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

        if let Ok(mut guard) = sidecar.lock() {
            if !guard.is_child_alive() {
                let tail = read_mlx_sidecar_log_tail(app, 8);
                let message = if backend == InferenceBackend::Mlx {
                    if tail.is_empty() {
                        "MLX 推理进程已退出，请检查网络或在设置中重新安装 MLX 引擎。".to_string()
                    } else {
                        format!("MLX 推理进程已退出：{tail}")
                    }
                } else {
                    "llama-server 进程已退出，请在环境配置中重新安装推理引擎。".to_string()
                };
                return Err(message);
            }
        }

        if last_progress_emit.elapsed() >= Duration::from_secs(1) {
            emit_sidecar_load_progress(app, backend, started.elapsed().as_secs());
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
    if backend == InferenceBackend::Mlx {
        if tail.is_empty() {
            return Err(
                "MLX 模型加载超时（首次需下载约 2GB，请保持联网并重试）".to_string(),
            );
        }
        return Err(format!(
            "MLX 模型加载超时（首次下载可能较慢）。最近日志：{tail}"
        ));
    }

    Err("模型加载超时（首次载入约需 30–90 秒），请稍后重试".to_string())
}
