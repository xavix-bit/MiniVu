use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub record_id: String,
    pub request_id: String,
    pub text: String,
    pub done: bool,
}

pub fn emit_chunk(
    app: &AppHandle,
    record_id: &str,
    request_id: &str,
    text: &str,
    done: bool,
) -> Result<(), String> {
    app.emit(
        "model-stream",
        StreamChunk {
            record_id: record_id.to_string(),
            request_id: request_id.to_string(),
            text: text.to_string(),
            done,
        },
    )
    .map_err(|e| e.to_string())
}

use crate::model_cache::MlxModelRef;
use crate::settings::InferenceBackend;

/// OpenAI 请求里的 `model` 字段：MLX 必须用 HF repo 或本地路径，不能用占位名。
pub fn sidecar_request_model(backend: InferenceBackend, mlx: &MlxModelRef) -> String {
    match backend {
        InferenceBackend::Mlx => mlx.spec.clone(),
        InferenceBackend::Llama => "minicpm-v".to_string(),
    }
}

async fn wait_until_cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
    }
}

async fn sleep_or_cancel(cancel: &AtomicBool, duration: Duration) -> bool {
    tokio::select! {
        _ = wait_until_cancelled(cancel) => true,
        _ = tokio::time::sleep(duration) => false,
    }
}

fn complete_cancelled(app: &AppHandle, record_id: &str, request_id: &str) -> Result<(), String> {
    emit_chunk(app, record_id, request_id, "", true)
}

pub async fn stream_from_sidecar(
    app: &AppHandle,
    port: u16,
    model: &str,
    messages: &[serde_json::Value],
    cancel: &AtomicBool,
    sidecar_warm: bool,
    record_id: &str,
    request_id: &str,
) -> Result<(), String> {
    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");

    let retry_delay = if sidecar_warm {
        Duration::from_millis(400)
    } else {
        Duration::from_secs(2)
    };
    let max_retries = if sidecar_warm { 12 } else { 30 };

    let mut response = None;
    for _ in 0..max_retries {
        let attempt = tokio::select! {
            _ = wait_until_cancelled(cancel) => {
                return complete_cancelled(app, record_id, request_id);
            }
            result = client.post(&url).json(&body).send() => result,
        };
        match attempt {
            Ok(resp) if resp.status() == StatusCode::SERVICE_UNAVAILABLE => {
                if sleep_or_cancel(cancel, retry_delay).await {
                    return complete_cancelled(app, record_id, request_id);
                }
                continue;
            }
            Ok(resp) => {
                response = Some(resp);
                break;
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let response = response.ok_or_else(|| "处理中，请稍后再试。".to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = tokio::select! {
            _ = wait_until_cancelled(cancel) => {
                return complete_cancelled(app, record_id, request_id);
            }
            result = response.text() => result.unwrap_or_default(),
        };
        let detail = detail.trim();
        if detail.is_empty() {
            return Err(format!("推理失败: HTTP {status}"));
        }
        return Err(format!("推理失败: HTTP {status} — {detail}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut emitted_any = false;

    loop {
        let chunk = tokio::select! {
            _ = wait_until_cancelled(cancel) => {
                return complete_cancelled(app, record_id, request_id);
            }
            result = stream.next() => result,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim().to_string();
            buffer.drain(..=newline);

            let Some(payload) = line.strip_prefix("data: ") else {
                continue;
            };
            if payload == "[DONE]" {
                if !emitted_any {
                    return Err("没有生成结果，请重试。".to_string());
                }
                emit_chunk(app, record_id, request_id, "", true)?;
                return Ok(());
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                    if !content.is_empty() {
                        emitted_any = true;
                    }
                    emit_chunk(app, record_id, request_id, content, false)?;
                }
            }
        }
    }

    if !emitted_any {
        return Err("没有生成结果，请重试。".to_string());
    }

    emit_chunk(app, record_id, request_id, "", true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn cancellation_interrupts_a_long_wait() {
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            trigger.store(true, Ordering::SeqCst);
        });

        let cancelled = tokio::time::timeout(
            Duration::from_millis(250),
            sleep_or_cancel(&cancel, Duration::from_secs(600)),
        )
        .await
        .expect("cancel-aware wait should finish promptly");

        assert!(cancelled);
    }
}
