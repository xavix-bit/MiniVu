use crate::download_http::{build_http_client, with_download_headers};
use crate::model_cache::{DEFAULT_MODEL_URL, MODELSCOPE_MODEL_URL};
use crate::settings::MirrorId;
use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use std::time::{Duration, Instant};

const SAMPLE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorProbeResult {
    pub mirror: String,
    pub label: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub speed_mbps: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorBenchmarkResponse {
    pub results: Vec<MirrorProbeResult>,
    pub recommended: Option<String>,
    pub tested_at_unix: u64,
}

fn mirror_meta(id: MirrorId) -> (&'static str, &'static str, &'static str) {
    match id {
        MirrorId::Modelscope => ("modelscope", "ModelScope（国内镜像）", MODELSCOPE_MODEL_URL),
        MirrorId::Huggingface => ("huggingface", "HuggingFace（海外源）", DEFAULT_MODEL_URL),
    }
}

fn is_probe_status_ok(status: reqwest::StatusCode) -> bool {
    status.is_success() || status.as_u16() == 206 || status.as_u16() == 302
}

async fn probe_mirror(client: &Client, mirror: MirrorId) -> MirrorProbeResult {
    let (mirror_id, label, url) = mirror_meta(mirror);

    let sample_start = Instant::now();
    let sample = with_download_headers(
        client
            .get(url)
            .header("Range", format!("bytes=0-{}", SAMPLE_BYTES - 1)),
        url,
    )
    .timeout(Duration::from_secs(60))
    .send()
    .await;

    let latency_ms = sample_start.elapsed().as_millis() as u64;

    match sample {
        Ok(response) if is_probe_status_ok(response.status()) => {
            let body_start = Instant::now();
            let mut downloaded: u64 = 0;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        downloaded += bytes.len() as u64;
                        if downloaded >= SAMPLE_BYTES {
                            break;
                        }
                    }
                    Err(error) => {
                        return MirrorProbeResult {
                            mirror: mirror_id.to_string(),
                            label: label.to_string(),
                            ok: false,
                            latency_ms,
                            speed_mbps: None,
                            error: Some(error.to_string()),
                        };
                    }
                }
            }

            if downloaded == 0 {
                return MirrorProbeResult {
                    mirror: mirror_id.to_string(),
                    label: label.to_string(),
                    ok: false,
                    latency_ms,
                    speed_mbps: None,
                    error: Some("样本下载为空".to_string()),
                };
            }

            let elapsed = body_start.elapsed().as_secs_f64().max(0.001);
            let speed_mbps =
                ((downloaded as f64 / elapsed) / (1024.0 * 1024.0) * 100.0).round() / 100.0;

            MirrorProbeResult {
                mirror: mirror_id.to_string(),
                label: label.to_string(),
                ok: true,
                latency_ms,
                speed_mbps: Some(speed_mbps),
                error: None,
            }
        }
        Ok(response) => MirrorProbeResult {
            mirror: mirror_id.to_string(),
            label: label.to_string(),
            ok: false,
            latency_ms,
            speed_mbps: None,
            error: Some(format!(
                "HTTP {}（ModelScope 若 403，可改选仅 HuggingFace 或关闭代理后重试）",
                response.status()
            )),
        },
        Err(error) => MirrorProbeResult {
            mirror: mirror_id.to_string(),
            label: label.to_string(),
            ok: false,
            latency_ms,
            speed_mbps: None,
            error: Some(format!(
                "{error}（若使用全局代理，可尝试为 modelscope.cn / huggingface.co 设置直连）"
            )),
        },
    }
}

fn pick_recommended(results: &[MirrorProbeResult]) -> Option<String> {
    let mut best: Option<&MirrorProbeResult> = None;
    for result in results.iter().filter(|item| item.ok) {
        best = Some(match best {
            None => result,
            Some(current) => {
                let current_speed = current.speed_mbps.unwrap_or(0.0);
                let next_speed = result.speed_mbps.unwrap_or(0.0);
                if next_speed > current_speed + 0.05 {
                    result
                } else if (next_speed - current_speed).abs() <= 0.05
                    && result.latency_ms < current.latency_ms
                {
                    result
                } else {
                    current
                }
            }
        });
    }
    best.map(|item| item.mirror.clone())
}

#[tauri::command]
pub async fn benchmark_download_mirrors() -> Result<MirrorBenchmarkResponse, String> {
    let client = build_http_client()?;

    let (modelscope, huggingface) = tokio::join!(
        probe_mirror(&client, MirrorId::Modelscope),
        probe_mirror(&client, MirrorId::Huggingface),
    );

    let results = vec![modelscope, huggingface];
    let recommended = pick_recommended(&results);
    let tested_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);

    Ok(MirrorBenchmarkResponse {
        results,
        recommended,
        tested_at_unix,
    })
}
