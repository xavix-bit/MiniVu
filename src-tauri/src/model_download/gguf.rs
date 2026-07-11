use crate::download_http::{build_http_client, with_download_headers};
use crate::model_cache::ModelCache;
use crate::model_download::progress::emit_download_progress;
use crate::runtime_installer::emit_setup_progress;
use crate::settings::{load_settings, DownloadMirror, MirrorId};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use std::path::Path;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

fn mirror_mode_label(mirror: DownloadMirror, preferred: Option<MirrorId>) -> &'static str {
    match mirror {
        DownloadMirror::Modelscope => "仅 ModelScope",
        DownloadMirror::Huggingface => "仅 HuggingFace",
        DownloadMirror::Auto => match preferred {
            Some(MirrorId::Huggingface) => "自动（测速推荐 HuggingFace 优先）",
            Some(MirrorId::Modelscope) => "自动（测速推荐 ModelScope 优先）",
            None => "自动（默认 ModelScope 优先，失败时切换 HuggingFace）",
        },
    }
}

fn source_plan_label(sources: &[crate::model_cache::DownloadSource]) -> String {
    sources
        .iter()
        .map(|source| source.name)
        .collect::<Vec<_>>()
        .join(" → ")
}

pub async fn download_model(app: AppHandle, force: Option<bool>) -> Result<String, String> {
    use crate::model_cache::{
        gguf_model_spec, mmproj_sources_for, model_sources_for, EXPECTED_MMPROJ_BYTES,
    };

    let force = force.unwrap_or(false);
    let settings = load_settings(&app)?;
    let variant = settings.gguf_model_variant;
    let spec = gguf_model_spec(variant);
    let mirror = settings.download_mirror;
    let preferred = settings.preferred_mirror;
    let cache = ModelCache::new(&app)?;
    let client = build_http_client()?;

    let mmproj_dest = cache.default_mmproj_path();
    let model_dest = cache.default_model_path(variant);
    let model_dest_return = model_dest.clone();

    if !crate::model_cache::file_is_valid(&mmproj_dest, "mmproj") {
        tokio::fs::remove_file(mmproj_dest.with_extension("part"))
            .await
            .ok();
    }

    let model_sources = model_sources_for(variant, mirror, preferred);
    let mirror_label = mirror_mode_label(mirror, preferred);
    let model_plan = source_plan_label(&model_sources);

    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "file": "mmproj",
            "status": "waiting",
            "message": "等待主模型完成后开始…",
            "downloaded": 0,
            "total": null,
            "percent": 0,
        }),
    );
    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "file": "model",
            "status": "running",
            "message": format!("{mirror_label} · {model_plan}"),
            "downloaded": 0,
            "total": null,
            "percent": 0,
            "source": model_sources.first().map(|s| s.name),
        }),
    );
    download_file_with_fallback(
        &app,
        &client,
        &model_sources,
        &model_dest,
        "model",
        spec.model_bytes,
        force,
    )
    .await?;

    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "file": "mmproj",
            "status": "running",
            "message": "主模型已完成，开始下载视觉投影器…",
            "downloaded": 0,
            "total": null,
            "percent": 0,
        }),
    );
    emit_setup_progress(
        &app,
        "mmproj",
        "running",
        "主模型已完成，开始下载视觉投影器…",
        0,
    );

    let mmproj_sources = mmproj_sources_for(mirror, preferred);
    download_file_with_fallback(
        &app,
        &client,
        &mmproj_sources,
        &mmproj_dest,
        "mmproj",
        EXPECTED_MMPROJ_BYTES,
        force,
    )
    .await?;

    Ok(model_dest_return.to_string_lossy().to_string())
}

async fn download_file_with_fallback(
    app: &AppHandle,
    client: &Client,
    sources: &[crate::model_cache::DownloadSource],
    dest: &Path,
    label: &str,
    expected_bytes: u64,
    force: bool,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        if index > 0 {
            let failed = errors.last().map(String::as_str).unwrap_or("上一源失败");
            let _ = app.emit(
                "model-download-progress",
                serde_json::json!({
                    "file": label,
                    "status": "switching",
                    "message": format!("{failed}，正在切换至 {}", source.name),
                }),
            );
        }
        match download_file(
            app,
            client,
            source.url,
            dest,
            label,
            source.name,
            expected_bytes,
            force,
        )
        .await
        {
            Ok(bytes) => {
                emit_download_progress(
                    app,
                    label,
                    source.name,
                    bytes,
                    Some(bytes),
                    None,
                    "done",
                    Some("下载完成"),
                );
                return Ok(());
            }
            Err(error) => errors.push(format!("{}: {error}", source.name)),
        }
    }
    Err(errors.join("；"))
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    let (_, total) = value.split_once('/')?;
    total.trim().parse().ok()
}

async fn finalize_part_file(
    part_path: &Path,
    dest: &Path,
    expected_bytes: u64,
) -> Result<u64, String> {
    let part_bytes = tokio::fs::metadata(part_path)
        .await
        .map_err(|e| e.to_string())?
        .len();
    if !crate::model_cache::is_complete_size(expected_bytes, part_bytes) {
        let expected = crate::model_cache::format_bytes(expected_bytes);
        return Err(format!(
            "文件不完整（{} / 预期 {}）",
            crate::model_cache::format_bytes(part_bytes),
            expected
        ));
    }
    if dest.exists() {
        tokio::fs::remove_file(dest).await.ok();
    }
    tokio::fs::rename(part_path, dest)
        .await
        .map_err(|e| format!("保存文件失败: {e}"))?;
    Ok(part_bytes)
}

async fn download_file(
    app: &AppHandle,
    client: &Client,
    url: &str,
    dest: &Path,
    label: &str,
    source_name: &str,
    expected_bytes: u64,
    force: bool,
) -> Result<u64, String> {
    let part_path = dest.with_extension("part");

    if force {
        tokio::fs::remove_file(dest).await.ok();
        tokio::fs::remove_file(&part_path).await.ok();
    } else if dest.exists() {
        let final_bytes = tokio::fs::metadata(dest)
            .await
            .map_err(|e| e.to_string())?
            .len();
        if crate::model_cache::is_complete_size(expected_bytes, final_bytes) {
            tokio::fs::remove_file(&part_path).await.ok();
            emit_download_progress(
                app,
                label,
                source_name,
                final_bytes,
                Some(final_bytes),
                None,
                "done",
                Some("已存在，跳过下载"),
            );
            return Ok(final_bytes);
        }
        tokio::fs::remove_file(dest).await.ok();
        tokio::fs::remove_file(&part_path).await.ok();
        emit_download_progress(
            app,
            label,
            source_name,
            0,
            Some(expected_bytes),
            None,
            "running",
            Some("检测到不完整文件，重新下载…"),
        );
    }

    let is_modelscope = url.contains("modelscope.cn");
    let mut resume_from = if part_path.exists() {
        tokio::fs::metadata(&part_path)
            .await
            .map_err(|e| e.to_string())?
            .len()
    } else {
        0
    };

    if is_modelscope && resume_from > 0 {
        if crate::model_cache::is_complete_size(expected_bytes, resume_from) {
            let final_bytes = finalize_part_file(&part_path, dest, expected_bytes).await?;
            emit_download_progress(
                app,
                label,
                source_name,
                final_bytes,
                Some(final_bytes),
                None,
                "done",
                Some("已存在，跳过下载"),
            );
            return Ok(final_bytes);
        }
        tokio::fs::remove_file(&part_path).await.ok();
        resume_from = 0;
        emit_download_progress(
            app,
            label,
            source_name,
            0,
            Some(expected_bytes),
            None,
            "running",
            Some("ModelScope 不支持断点续传，从头下载…"),
        );
    } else if resume_from > 0 {
        emit_download_progress(
            app,
            label,
            source_name,
            resume_from,
            None,
            None,
            "running",
            Some(&format!(
                "续传下载… 已下载 {}",
                crate::model_cache::format_bytes(resume_from)
            )),
        );
    }

    let mut request = with_download_headers(client.get(url), url);
    if resume_from > 0 {
        request = request.header("Range", format!("bytes={resume_from}-"));
    }

    let response = request.send().await.map_err(|e| format!("连接失败: {e}"))?;

    let status = response.status();

    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        if resume_from > 0 && crate::model_cache::is_complete_size(expected_bytes, resume_from) {
            let final_bytes = finalize_part_file(&part_path, dest, expected_bytes).await?;
            return Ok(final_bytes);
        }
        if resume_from > 0 {
            tokio::fs::remove_file(&part_path).await.ok();
            return Err("续传偏移无效，请重试下载".to_string());
        }
        return Err(format!("HTTP {}", status));
    }

    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }

    let total = if status == StatusCode::PARTIAL_CONTENT {
        response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_content_range_total)
    } else {
        response.content_length()
    };

    if status == StatusCode::OK && resume_from > 0 {
        resume_from = 0;
        tokio::fs::remove_file(&part_path).await.ok();
    }

    if let (Some(total_bytes), current) = (total, resume_from) {
        if current >= total_bytes && part_path.exists() {
            let final_bytes = finalize_part_file(&part_path, dest, expected_bytes).await?;
            return Ok(final_bytes);
        }
    }

    let mut file = if resume_from > 0 {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part_path)
            .await
            .map_err(|e| e.to_string())?
    } else {
        tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| e.to_string())?
    };

    let mut downloaded = resume_from;
    let mut stream = response.bytes_stream();
    let stream_started = Instant::now();
    let stream_base_bytes = resume_from;
    let mut last_emit = Instant::now();
    let mut last_downloaded = resume_from;
    let mut ema_speed_mbps: Option<f64> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        let now = Instant::now();
        if now.duration_since(last_emit).as_millis() >= 1000 {
            let elapsed = now.duration_since(last_emit).as_secs_f64().max(0.001);
            let delta = downloaded.saturating_sub(last_downloaded);
            let window_speed = (delta as f64 / elapsed) / (1024.0 * 1024.0);
            ema_speed_mbps = Some(match ema_speed_mbps {
                None => window_speed,
                Some(prev) => 0.25 * window_speed + 0.75 * prev,
            });
            let session_elapsed = stream_started.elapsed().as_secs_f64().max(1.0);
            let session_bytes = downloaded.saturating_sub(stream_base_bytes);
            let session_speed = (session_bytes as f64 / session_elapsed) / (1024.0 * 1024.0);
            let ema_speed = ema_speed_mbps.unwrap_or(window_speed);
            let speed_mbps = 0.7 * session_speed + 0.3 * ema_speed;
            emit_download_progress(
                app,
                label,
                source_name,
                downloaded,
                total,
                Some((speed_mbps * 10.0).round() / 10.0),
                "running",
                None,
            );
            last_emit = now;
            last_downloaded = downloaded;
        }
    }

    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let final_bytes = finalize_part_file(&part_path, dest, expected_bytes).await?;
    emit_download_progress(
        app,
        label,
        source_name,
        final_bytes,
        total.or(Some(final_bytes)),
        None,
        "running",
        None,
    );

    Ok(final_bytes)
}
