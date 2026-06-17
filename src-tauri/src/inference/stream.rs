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

pub async fn stream_from_sidecar(
    app: &AppHandle,
    port: u16,
    messages: &[serde_json::Value],
    cancel: &AtomicBool,
    sidecar_warm: bool,
) -> Result<(), String> {
    let body = serde_json::json!({
        "model": "minicpm-v",
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

pub async fn stream_fallback_response(
    app: &AppHandle,
    ocr_text: &str,
    prompt: &str,
    models_ready: bool,
    note: Option<String>,
) -> Result<(), String> {
    let intro = match (models_ready, note) {
        (true, Some(message)) => format!("（推理暂不可用：{message}）\n\n"),
        (true, None) => "（推理暂不可用：请稍后重试或重启应用）\n\n".to_string(),
        (false, Some(message)) => format!("（本地演示模式：{message}）\n\n"),
        (false, None) => {
            "（本地演示模式：模型或 mmproj 尚未下载，或 llama-server 不可用）\n\n".to_string()
        }
    };

    let ocr_hint = if ocr_text.trim().is_empty() {
        "图片中未识别到明显文字。".to_string()
    } else {
        format!("识别到的文字片段：{ocr_text}")
    };

    let footer = if models_ready {
        "模型文件已就绪。若刚启动应用，首次提问需等待模型载入内存（约 30–90 秒），状态栏会显示「正在加载模型…」。"
    } else {
        "这是 MiniVu 的本地演示回复。下载 MiniCPM-V 4.5 主模型与 mmproj 并安装 llama-server 后，将自动切换为真实本地推理。"
    };

    let answer = format!(
        "{intro}针对你的问题「{prompt}」，{ocr_hint}\n\n{footer}"
    );

    for word in answer.split_inclusive(char::is_whitespace) {
        emit_chunk(app, word, false)?;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    emit_chunk(app, "", true)?;
    Ok(())
}
