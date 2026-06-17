use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub text: String,
    pub done: bool,
}

pub fn emit_chunk(app: &AppHandle, text: &str, done: bool) -> Result<(), String> {
    app.emit(
        "model-stream",
        StreamChunk {
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

pub async fn stream_from_sidecar(
    app: &AppHandle,
    port: u16,
    model: &str,
    messages: &[serde_json::Value],
    cancel: &AtomicBool,
    sidecar_warm: bool,
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
        let attempt = client.post(&url).json(&body).send().await;
        match attempt {
            Ok(resp) if resp.status() == StatusCode::SERVICE_UNAVAILABLE => {
                tokio::time::sleep(retry_delay).await;
                continue;
            }
            Ok(resp) => {
                response = Some(resp);
                break;
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let response = response.ok_or_else(|| {
        "推理服务繁忙（模型可能仍在加载），请稍候再试".to_string()
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let detail = detail.trim();
        if detail.is_empty() {
            return Err(format!("推理失败: HTTP {status}"));
        }
        return Err(format!("推理失败: HTTP {status} — {detail}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut emitted_any = false;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            emit_chunk(app, "", true)?;
            return Ok(());
        }
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
                    return Err("模型未返回内容，请重试或缩短问题".to_string());
                }
                emit_chunk(app, "", true)?;
                return Ok(());
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                    if !content.is_empty() {
                        emitted_any = true;
                    }
                    emit_chunk(app, content, false)?;
                }
            }
        }
    }

    if !emitted_any {
        return Err("模型未返回内容，请重试或缩短问题".to_string());
    }

    emit_chunk(app, "", true)?;
    Ok(())
}
