use crate::download_http::{build_http_client, with_download_headers};
use crate::model_cache::{managed_file_is_valid, DownloadSource, ModelCache};
use crate::model_download::progress::{emit_download_progress, emit_task_progress};
use crate::model_download::task::{cancelable, DownloadTaskGuard, DownloadTaskState, FailureSeal};
use crate::runtime_installer::emit_setup_progress;
use crate::settings::{load_settings, DownloadMirror, GgufModelVariant, MirrorId};
use futures_util::StreamExt;
use reqwest::header::{CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::AppHandle;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

const CANCELLATION_ERROR: &str = "模型下载已取消";

#[derive(Debug, thiserror::Error)]
enum DownloadError {
    #[error("{CANCELLATION_ERROR}")]
    Cancelled,
    #[error("{0}")]
    Failed(String),
}

type DownloadResult<T> = Result<T, DownloadError>;

fn no_op_promotion_hook() {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SourceMetadata {
    url: String,
    etag: Option<String>,
    last_modified: Option<String>,
}

impl SourceMetadata {
    fn from_response(url: &str, response: &Response) -> Self {
        Self {
            url: url.to_string(),
            etag: header_string(response, ETAG),
            last_modified: header_string(response, LAST_MODIFIED),
        }
    }

    fn strong_etag(&self) -> Option<&str> {
        self.etag
            .as_deref()
            .filter(|value| !value.trim_start().starts_with("W/"))
    }

    fn validator(&self) -> Option<&str> {
        self.strong_etag().or(self.last_modified.as_deref())
    }

    fn is_compatible_with(&self, current: &Self) -> bool {
        self.url == current.url
            && match (self.strong_etag(), self.last_modified.as_deref()) {
                (Some(expected), _) => current.strong_etag() == Some(expected),
                (None, Some(expected)) => current.last_modified.as_deref() == Some(expected),
                (None, None) => false,
            }
    }
}

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

fn source_plan_label(sources: &[DownloadSource]) -> String {
    sources
        .iter()
        .map(|source| source.name)
        .collect::<Vec<_>>()
        .join(" → ")
}

pub async fn download_model(
    app: AppHandle,
    state: &DownloadTaskState,
    force: Option<bool>,
    target_variant: Option<GgufModelVariant>,
) -> Result<String, String> {
    let settings = load_settings(&app)?;
    let variant = target_variant.unwrap_or(settings.gguf_model_variant);
    let task = state.begin(variant)?;
    let result = match download_model_task(&app, &task, force.unwrap_or(false), &settings).await {
        Err(DownloadError::Failed(error)) => match task.seal_failure() {
            Ok(FailureSeal::Canceled) => Err(DownloadError::Cancelled),
            Ok(FailureSeal::Failed) | Err(_) => Err(DownloadError::Failed(error)),
        },
        result => result,
    };

    if let Err(error) = &result {
        let snapshot = state.snapshot();
        let status = if matches!(error, DownloadError::Cancelled) {
            "canceled"
        } else {
            "failed"
        };
        let message = error.to_string();
        emit_task_progress(
            &app,
            &task,
            snapshot
                .as_ref()
                .and_then(|value| value.file.as_deref())
                .unwrap_or("model"),
            status,
            &message,
            snapshot.as_ref().map(|value| value.downloaded).unwrap_or(0),
            snapshot.as_ref().and_then(|value| value.total),
            snapshot.as_ref().and_then(|value| value.source.as_deref()),
        );
    }

    result.map_err(|error| error.to_string())
}

async fn download_model_task(
    app: &AppHandle,
    task: &DownloadTaskGuard,
    force: bool,
    settings: &crate::settings::AppSettings,
) -> DownloadResult<String> {
    use crate::model_cache::{
        gguf_model_spec, mmproj_sources_for, model_sources_for, EXPECTED_MMPROJ_BYTES,
    };

    let variant = task.variant();
    let spec = gguf_model_spec(variant);
    let cache = ModelCache::new(app).map_err(DownloadError::Failed)?;
    let client = build_http_client().map_err(DownloadError::Failed)?;
    let mmproj_dest = cache.default_mmproj_path();
    let model_dest = cache.default_model_path(variant);
    let model_dest_return = model_dest.clone();
    let model_sources =
        model_sources_for(variant, settings.download_mirror, settings.preferred_mirror);

    emit_task_progress(
        app,
        task,
        "mmproj",
        "waiting",
        "等待主模型完成后开始…",
        0,
        None,
        None,
    );
    emit_task_progress(
        app,
        task,
        "model",
        "running",
        &format!(
            "{} · {}",
            mirror_mode_label(settings.download_mirror, settings.preferred_mirror),
            source_plan_label(&model_sources)
        ),
        0,
        None,
        model_sources.first().map(|source| source.name),
    );
    download_file_with_fallback(
        Some(app),
        task,
        &client,
        &model_sources,
        &model_dest,
        "model",
        spec.model_bytes,
        force,
        false,
        || {},
    )
    .await?;

    emit_task_progress(
        app,
        task,
        "mmproj",
        "running",
        "主模型已完成，开始下载视觉投影器…",
        0,
        None,
        None,
    );
    emit_setup_progress(
        app,
        "mmproj",
        "running",
        "主模型已完成，开始下载视觉投影器…",
        0,
    );

    let mmproj_sources = mmproj_sources_for(settings.download_mirror, settings.preferred_mirror);
    download_file_with_fallback(
        Some(app),
        task,
        &client,
        &mmproj_sources,
        &mmproj_dest,
        "mmproj",
        EXPECTED_MMPROJ_BYTES,
        force,
        true,
        || {},
    )
    .await?;

    Ok(model_dest_return.to_string_lossy().to_string())
}

async fn download_file_with_fallback(
    app: Option<&AppHandle>,
    task: &DownloadTaskGuard,
    client: &Client,
    sources: &[DownloadSource],
    dest: &Path,
    label: &str,
    expected_bytes: u64,
    force: bool,
    terminal_artifact: bool,
    mut on_source_failed: impl FnMut(),
) -> DownloadResult<()> {
    let mut errors = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        if index > 0 {
            let mutation = task
                .begin_finalization()
                .map_err(|_| DownloadError::Cancelled)?;
            reset_partial(&dest.with_extension("part"))
                .await
                .map_err(DownloadError::Failed)?;
            let failed = errors.last().map(String::as_str).unwrap_or("上一源失败");
            if let Some(app) = app {
                emit_task_progress(
                    app,
                    task,
                    label,
                    "switching",
                    &format!("{failed}，正在切换至 {}", source.name),
                    0,
                    None,
                    Some(source.name),
                );
            }
            drop(mutation);
        }

        match download_file(
            app,
            task,
            client,
            source.url,
            dest,
            label,
            source.name,
            expected_bytes,
            force,
            terminal_artifact,
            &no_op_promotion_hook,
        )
        .await
        {
            Ok(bytes) => {
                if let Some(app) = app {
                    emit_download_progress(
                        app,
                        task,
                        label,
                        source.name,
                        bytes,
                        Some(bytes),
                        None,
                        "done",
                        Some("下载完成"),
                    );
                }
                return Ok(());
            }
            Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
            Err(DownloadError::Failed(error)) => {
                errors.push(format!("{}: {error}", source.name));
                on_source_failed();
                if index + 1 == sources.len() {
                    return match task.seal_failure() {
                        Ok(FailureSeal::Failed) => Err(DownloadError::Failed(errors.join("；"))),
                        Ok(FailureSeal::Canceled) | Err(_) => Err(DownloadError::Cancelled),
                    };
                }
            }
        }
    }
    let error = if errors.is_empty() {
        "没有可用的模型下载源".to_string()
    } else {
        errors.join("；")
    };
    match task.seal_failure() {
        Ok(FailureSeal::Failed) => Err(DownloadError::Failed(error)),
        Ok(FailureSeal::Canceled) | Err(_) => Err(DownloadError::Cancelled),
    }
}

fn source_metadata_path(part_path: &Path) -> PathBuf {
    let file_name = part_path
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    part_path.with_file_name(format!("{file_name}.source.json"))
}

async fn read_source_metadata(part_path: &Path) -> Option<SourceMetadata> {
    let raw = tokio::fs::read(source_metadata_path(part_path))
        .await
        .ok()?;
    serde_json::from_slice(&raw).ok()
}

async fn write_source_metadata(part_path: &Path, metadata: &SourceMetadata) -> Result<(), String> {
    let raw = serde_json::to_vec(metadata).map_err(|error| error.to_string())?;
    tokio::fs::write(source_metadata_path(part_path), raw)
        .await
        .map_err(|error| error.to_string())
}

async fn reset_partial(part_path: &Path) -> Result<(), String> {
    for path in [part_path.to_path_buf(), source_metadata_path(part_path)] {
        match tokio::fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("重置未完成下载失败: {error}")),
        }
    }
    Ok(())
}

async fn reset_partial_checked(task: &DownloadTaskGuard, part_path: &Path) -> DownloadResult<()> {
    let _mutation = task
        .begin_finalization()
        .map_err(|_| DownloadError::Cancelled)?;
    reset_partial(part_path)
        .await
        .map_err(DownloadError::Failed)
}

async fn prepare_part_for_source(
    task: &DownloadTaskGuard,
    part_path: &Path,
    url: &str,
    allow_resume: bool,
) -> DownloadResult<u64> {
    task.checkpoint().map_err(|_| DownloadError::Cancelled)?;
    let part_len = match tokio::fs::metadata(part_path).await {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        Ok(_) => {
            reset_partial_checked(task, part_path).await?;
            return Ok(0);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            reset_partial_checked(task, part_path).await?;
            return Ok(0);
        }
        Err(error) => return Err(DownloadError::Failed(error.to_string())),
    };

    let metadata = read_source_metadata(part_path).await;
    let can_resume = allow_resume
        && metadata
            .as_ref()
            .map(|value| value.url == url && value.validator().is_some())
            .unwrap_or(false);
    if can_resume {
        Ok(part_len)
    } else {
        reset_partial_checked(task, part_path).await?;
        Ok(0)
    }
}

fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((
        start.trim().parse().ok()?,
        end.trim().parse().ok()?,
        total.trim().parse().ok()?,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ValidatedPartialResponse {
    total: u64,
    body_bytes: u64,
}

fn validate_partial_response(
    resume_from: u64,
    content_range: Option<&str>,
    content_length: Option<u64>,
    expected_bytes: u64,
    previous: Option<&SourceMetadata>,
    current: &SourceMetadata,
) -> Result<ValidatedPartialResponse, String> {
    let (start, end, total) = content_range
        .and_then(parse_content_range)
        .ok_or_else(|| "服务器未返回有效的 Content-Range".to_string())?;
    if start != resume_from {
        return Err(format!("服务器续传起点为 {start}，预期为 {resume_from}"));
    }
    if end < start || end >= total {
        return Err(format!("服务器续传终点 {end} 与总大小 {total} 不兼容"));
    }
    if total != expected_bytes {
        return Err(format!(
            "服务器文件总大小为 {total}，预期为 {expected_bytes}"
        ));
    }
    let body_bytes = end
        .checked_sub(start)
        .and_then(|length| length.checked_add(1))
        .ok_or_else(|| "服务器续传范围长度溢出".to_string())?;
    if let Some(content_length) = content_length {
        if content_length != body_bytes {
            return Err(format!(
                "服务器续传正文长度为 {content_length}，范围要求 {body_bytes}"
            ));
        }
    }
    if !previous
        .map(|metadata| metadata.is_compatible_with(current))
        .unwrap_or(false)
    {
        return Err("下载源校验标识已变化".to_string());
    }
    Ok(ValidatedPartialResponse { total, body_bytes })
}

async fn validate_or_reset_partial(
    task: &DownloadTaskGuard,
    part_path: &Path,
    resume_from: u64,
    content_range: Option<&str>,
    content_length: Option<u64>,
    expected_bytes: u64,
    previous: Option<&SourceMetadata>,
    current: &SourceMetadata,
) -> DownloadResult<ValidatedPartialResponse> {
    match validate_partial_response(
        resume_from,
        content_range,
        content_length,
        expected_bytes,
        previous,
        current,
    ) {
        Ok(validated) => Ok(validated),
        Err(reason) => {
            reset_partial_checked(task, part_path).await?;
            Err(DownloadError::Failed(format!(
                "服务器返回了不兼容的续传范围（{reason}），已重置未完成下载"
            )))
        }
    }
}

#[cfg(unix)]
fn replace_file(candidate: &Path, dest: &Path) -> Result<(), String> {
    std::fs::rename(candidate, dest).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn replace_file(candidate: &Path, dest: &Path) -> Result<(), String> {
    if !dest.exists() {
        return std::fs::rename(candidate, dest).map_err(|error| error.to_string());
    }

    let file_name = dest
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    let backup = (0_u32..)
        .map(|attempt| {
            dest.with_file_name(format!(
                ".{file_name}.download-backup-{}-{attempt}",
                std::process::id()
            ))
        })
        .find(|path| !path.exists())
        .ok_or_else(|| "无法分配模型替换备份路径".to_string())?;

    std::fs::rename(dest, &backup).map_err(|error| format!("备份现有模型失败: {error}"))?;
    match std::fs::rename(candidate, dest) {
        Ok(()) => {
            std::fs::remove_file(backup).ok();
            Ok(())
        }
        Err(promotion_error) => match std::fs::rename(&backup, dest) {
            Ok(()) => Err(promotion_error.to_string()),
            Err(rollback_error) => Err(format!(
                "{promotion_error}；恢复现有模型失败: {rollback_error}；备份保留在 {}",
                backup.display()
            )),
        },
    }
}

fn header_string(response: &Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn finalize_part_file(
    task: &DownloadTaskGuard,
    part_path: &Path,
    dest: &Path,
    expected_bytes: u64,
    terminal_artifact: bool,
    before_promotion: &(dyn Fn() + Send + Sync),
) -> DownloadResult<u64> {
    if !managed_file_is_valid(part_path, expected_bytes) {
        let should_remove = tokio::fs::symlink_metadata(part_path)
            .await
            .map(|meta| !meta.file_type().is_file() || meta.len() >= expected_bytes)
            .unwrap_or(false);
        if should_remove {
            reset_partial_checked(task, part_path).await?;
        }
        return Err(DownloadError::Failed(
            "文件无效（需要常规文件、精确大小和 GGUF 文件头）".to_string(),
        ));
    }
    before_promotion();
    let finalization = task
        .begin_finalization()
        .map_err(|_| DownloadError::Cancelled)?;
    replace_file(part_path, dest)
        .map_err(|error| DownloadError::Failed(format!("保存文件失败: {error}")))?;
    std::fs::remove_file(source_metadata_path(part_path)).ok();
    if terminal_artifact {
        finalization.commit_terminal();
    }
    Ok(expected_bytes)
}

async fn flush_and_preserve_partial(file: &mut tokio::fs::File) -> Result<(), String> {
    file.flush().await.map_err(|error| error.to_string())
}

async fn download_file(
    app: Option<&AppHandle>,
    task: &DownloadTaskGuard,
    client: &Client,
    url: &str,
    dest: &Path,
    label: &str,
    source_name: &str,
    expected_bytes: u64,
    force: bool,
    terminal_artifact: bool,
    before_promotion: &(dyn Fn() + Send + Sync),
) -> DownloadResult<u64> {
    let part_path = dest.with_extension("part");

    task.checkpoint().map_err(|_| DownloadError::Cancelled)?;

    if force {
        reset_partial_checked(task, &part_path).await?;
    } else if dest.exists() {
        if managed_file_is_valid(dest, expected_bytes) {
            reset_partial_checked(task, &part_path).await?;
            if terminal_artifact {
                task.begin_finalization()
                    .map_err(|_| DownloadError::Cancelled)?
                    .commit_terminal();
            }
            return Ok(expected_bytes);
        }
        let mutation = task
            .begin_finalization()
            .map_err(|_| DownloadError::Cancelled)?;
        tokio::fs::remove_file(dest).await.ok();
        reset_partial(&part_path)
            .await
            .map_err(DownloadError::Failed)?;
        drop(mutation);
    }

    let allow_resume = !url.contains("modelscope.cn");
    let mut resume_from = prepare_part_for_source(task, &part_path, url, allow_resume).await?;
    let previous_metadata = read_source_metadata(&part_path).await;

    if task.is_cancelled() {
        return Err(DownloadError::Cancelled);
    }
    if resume_from == expected_bytes {
        return finalize_part_file(
            task,
            &part_path,
            dest,
            expected_bytes,
            terminal_artifact,
            before_promotion,
        )
        .await;
    }
    if resume_from > 0 {
        if let Some(app) = app {
            emit_download_progress(
                app,
                task,
                label,
                source_name,
                resume_from,
                Some(expected_bytes),
                None,
                "running",
                Some("续传下载…"),
            );
        }
    }

    let mut request = with_download_headers(client.get(url), url);
    if resume_from > 0 {
        request = request.header(RANGE, format!("bytes={resume_from}-"));
        if let Some(validator) = previous_metadata
            .as_ref()
            .and_then(SourceMetadata::validator)
        {
            request = request.header(IF_RANGE, validator);
        }
    }

    let mut cancellation = task.cancellation();
    let response = cancelable(&mut cancellation, request.send())
        .await
        .map_err(|_| DownloadError::Cancelled)?
        .map_err(|error| DownloadError::Failed(format!("连接失败: {error}")))?;
    let status = response.status();

    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        if resume_from == expected_bytes && !task.is_cancelled() {
            return finalize_part_file(
                task,
                &part_path,
                dest,
                expected_bytes,
                terminal_artifact,
                before_promotion,
            )
            .await;
        }
        reset_partial_checked(task, &part_path).await?;
        return Err(DownloadError::Failed(
            "续传偏移无效，请重试下载".to_string(),
        ));
    }
    if !status.is_success() {
        return Err(DownloadError::Failed(format!("HTTP {status}")));
    }

    let current_metadata = SourceMetadata::from_response(url, &response);
    let validated_partial = if status == StatusCode::PARTIAL_CONTENT {
        let content_range = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok());
        match validate_or_reset_partial(
            task,
            &part_path,
            resume_from,
            content_range,
            response.content_length(),
            expected_bytes,
            previous_metadata.as_ref(),
            &current_metadata,
        )
        .await
        {
            Ok(validated) => Some(validated),
            Err(error) => return Err(error),
        }
    } else {
        if resume_from > 0 {
            reset_partial_checked(task, &part_path).await?;
            resume_from = 0;
        }
        None
    };
    let total = validated_partial
        .map(|validated| validated.total)
        .or_else(|| response.content_length());

    let preparation = task
        .begin_finalization()
        .map_err(|_| DownloadError::Cancelled)?;
    write_source_metadata(&part_path, &current_metadata)
        .await
        .map_err(DownloadError::Failed)?;
    let mut file = if resume_from > 0 {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part_path)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?
    } else {
        tokio::fs::File::create(&part_path)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?
    };
    drop(preparation);

    let mut downloaded = resume_from;
    let mut stream = response.bytes_stream();
    let stream_started = Instant::now();
    let stream_base_bytes = resume_from;
    let mut last_emit = Instant::now();
    let mut last_downloaded = resume_from;
    let mut ema_speed_mbps: Option<f64> = None;

    loop {
        let chunk = match cancelable(&mut cancellation, stream.next()).await {
            Err(_) => {
                flush_and_preserve_partial(&mut file)
                    .await
                    .map_err(DownloadError::Failed)?;
                drop(file);
                return Err(DownloadError::Cancelled);
            }
            Ok(None) => break,
            Ok(Some(Err(error))) => return Err(DownloadError::Failed(error.to_string())),
            Ok(Some(Ok(chunk))) => chunk,
        };
        file.write_all(&chunk)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
        downloaded += chunk.len() as u64;

        let now = Instant::now();
        if now.duration_since(last_emit).as_millis() >= 1000 {
            let elapsed = now.duration_since(last_emit).as_secs_f64().max(0.001);
            let delta = downloaded.saturating_sub(last_downloaded);
            let window_speed = (delta as f64 / elapsed) / (1024.0 * 1024.0);
            ema_speed_mbps = Some(match ema_speed_mbps {
                None => window_speed,
                Some(previous) => 0.25 * window_speed + 0.75 * previous,
            });
            let session_elapsed = stream_started.elapsed().as_secs_f64().max(1.0);
            let session_bytes = downloaded.saturating_sub(stream_base_bytes);
            let session_speed = (session_bytes as f64 / session_elapsed) / (1024.0 * 1024.0);
            let speed_mbps = 0.7 * session_speed + 0.3 * ema_speed_mbps.unwrap_or(window_speed);
            if let Some(app) = app {
                emit_download_progress(
                    app,
                    task,
                    label,
                    source_name,
                    downloaded,
                    total,
                    Some((speed_mbps * 10.0).round() / 10.0),
                    "running",
                    None,
                );
            }
            last_emit = now;
            last_downloaded = downloaded;
        }
    }

    flush_and_preserve_partial(&mut file)
        .await
        .map_err(DownloadError::Failed)?;
    drop(file);
    if let Some(validated) = validated_partial {
        let body_bytes = downloaded.saturating_sub(resume_from);
        if body_bytes != validated.body_bytes {
            reset_partial_checked(task, &part_path).await?;
            return Err(DownloadError::Failed(format!(
                "服务器续传正文实际收到 {body_bytes} 字节，范围要求 {} 字节",
                validated.body_bytes
            )));
        }
    }
    finalize_part_file(
        task,
        &part_path,
        dest,
        expected_bytes,
        terminal_artifact,
        before_promotion,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(test_name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "minivu-download-{test_name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp directory should be created");
        path
    }

    fn test_task() -> (DownloadTaskState, DownloadTaskGuard) {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        (state, task)
    }

    fn leak(value: String) -> &'static str {
        Box::leak(value.into_boxed_str())
    }

    fn accept_loopback(listener: &TcpListener) -> TcpStream {
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "loopback server did not receive a connection before deadline"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("loopback accept failed: {error}"),
            }
        }
    }

    fn read_loopback_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0_u8; 512];
            let bytes = stream
                .read(&mut chunk)
                .expect("loopback request should arrive before deadline");
            assert!(bytes > 0, "loopback peer closed before sending a request");
            request.extend_from_slice(&chunk[..bytes]);
            assert!(
                request.len() <= 8192,
                "loopback request headers are too large"
            );
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                return request;
            }
        }
    }

    #[tokio::test]
    async fn exact_size_wrong_magic_part_is_removed_and_retry_can_promote() {
        let (_state, task) = test_task();
        let root = temp_dir("wrong-magic-part");
        let part_path = root.join("model.part");
        let dest = root.join("model.gguf");
        let expected_bytes = 64;
        let mut part = File::create(&part_path).expect("part file should be created");
        part.write_all(b"NOPE")
            .expect("wrong magic should be written");
        part.set_len(expected_bytes)
            .expect("part file should have exact expected size");
        drop(part);

        let result = finalize_part_file(
            &task,
            &part_path,
            &dest,
            expected_bytes,
            false,
            &no_op_promotion_hook,
        )
        .await;
        let invalid_part_removed = !part_path.exists();
        let invalid_dest_absent = !dest.exists();
        let retry_promoted = if invalid_part_removed {
            let mut retry_part = File::create(&part_path).expect("retry part should be created");
            retry_part
                .write_all(b"GGUF")
                .expect("valid magic should be written");
            retry_part
                .set_len(expected_bytes)
                .expect("retry part should have exact expected size");
            drop(retry_part);
            finalize_part_file(
                &task,
                &part_path,
                &dest,
                expected_bytes,
                false,
                &no_op_promotion_hook,
            )
            .await
            .is_ok()
                && managed_file_is_valid(&dest, expected_bytes)
        } else {
            false
        };
        fs::remove_dir_all(root).expect("temp directory should be removed");

        assert!(result.is_err());
        assert!(invalid_part_removed);
        assert!(invalid_dest_absent);
        assert!(retry_promoted);
    }

    #[tokio::test]
    async fn incomplete_regular_part_is_preserved_for_resume() {
        let (_state, task) = test_task();
        let root = temp_dir("incomplete-part");
        let part_path = root.join("model.part");
        let dest = root.join("model.gguf");
        let mut part = File::create(&part_path).expect("part file should be created");
        part.write_all(b"GGUF")
            .expect("valid magic should be written");
        part.set_len(32)
            .expect("part file should remain incomplete");
        drop(part);

        let result =
            finalize_part_file(&task, &part_path, &dest, 64, false, &no_op_promotion_hook).await;
        let part_preserved = part_path.exists();
        let dest_absent = !dest.exists();
        fs::remove_dir_all(root).expect("temp directory should be removed");

        assert!(result.is_err());
        assert!(part_preserved);
        assert!(dest_absent);
    }

    #[tokio::test]
    async fn different_source_resets_partial_bytes_and_metadata() {
        let (_state, task) = test_task();
        let root = temp_dir("different-source");
        let part_path = root.join("model.part");
        fs::write(&part_path, b"GGUFold-source").unwrap();
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: "https://first.example/model.gguf".to_string(),
                etag: Some("first-etag".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();

        let resume =
            prepare_part_for_source(&task, &part_path, "https://second.example/model.gguf", true)
                .await
                .unwrap();

        assert_eq!(resume, 0);
        assert!(!part_path.exists());
        assert!(!source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn matching_source_with_validator_resumes_from_partial_length() {
        let (_state, task) = test_task();
        let root = temp_dir("matching-source");
        let part_path = root.join("model.part");
        fs::write(&part_path, b"GGUFsame-source").unwrap();
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: "https://example.com/model.gguf".to_string(),
                etag: Some("stable-etag".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();

        let resume =
            prepare_part_for_source(&task, &part_path, "https://example.com/model.gguf", true)
                .await
                .unwrap();

        assert_eq!(resume, b"GGUFsame-source".len() as u64);
        assert!(part_path.exists());
        assert!(source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn weak_etag_without_last_modified_resets_partial() {
        let (_state, task) = test_task();
        let root = temp_dir("weak-etag");
        let part_path = root.join("model.part");
        fs::write(&part_path, b"GGUFsame-source").unwrap();
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: "https://example.com/model.gguf".to_string(),
                etag: Some("W/\"weak-validator\"".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();

        let resume =
            prepare_part_for_source(&task, &part_path, "https://example.com/model.gguf", true)
                .await
                .unwrap();

        assert_eq!(resume, 0);
        assert!(!part_path.exists());
        assert!(!source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_preserves_partial_and_completed_destination() {
        let root = temp_dir("cancel-preserves-files");
        let part_path = root.join("model.part");
        let dest = root.join("model.gguf");
        fs::write(&dest, b"GGUFcompleted").unwrap();
        let mut part = tokio::fs::File::create(&part_path).await.unwrap();
        part.write_all(b"GGUFincomplete").await.unwrap();

        flush_and_preserve_partial(&mut part).await.unwrap();
        drop(part);

        assert_eq!(fs::read(&part_path).unwrap(), b"GGUFincomplete");
        assert_eq!(fs::read(&dest).unwrap(), b"GGUFcompleted");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matching_validator_and_range_can_resume() {
        let previous = SourceMetadata {
            url: "https://example.com/model.gguf".to_string(),
            etag: Some("stable-etag".to_string()),
            last_modified: None,
        };
        let current = previous.clone();

        assert_eq!(
            validate_partial_response(
                14,
                Some("bytes 14-63/64"),
                Some(50),
                64,
                Some(&previous),
                &current,
            )
            .map(|validated| (validated.total, validated.body_bytes)),
            Ok((64, 50))
        );
    }

    #[test]
    fn content_range_end_before_start_is_rejected() {
        let metadata = SourceMetadata {
            url: "https://example.com/model.gguf".to_string(),
            etag: Some("\"stable-etag\"".to_string()),
            last_modified: None,
        };

        assert!(validate_partial_response(
            14,
            Some("bytes 14-12/64"),
            Some(0),
            64,
            Some(&metadata),
            &metadata,
        )
        .is_err());
    }

    #[test]
    fn content_range_total_and_body_length_must_match_expected_values() {
        let metadata = SourceMetadata {
            url: "https://example.com/model.gguf".to_string(),
            etag: Some("\"stable-etag\"".to_string()),
            last_modified: None,
        };

        assert!(validate_partial_response(
            14,
            Some("bytes 14-63/65"),
            Some(50),
            64,
            Some(&metadata),
            &metadata,
        )
        .is_err());
        assert!(validate_partial_response(
            14,
            Some("bytes 14-63/64"),
            Some(49),
            64,
            Some(&metadata),
            &metadata,
        )
        .is_err());
    }

    #[tokio::test]
    async fn wrong_content_range_start_is_rejected_and_reset() {
        let (_state, task) = test_task();
        let root = temp_dir("wrong-content-range");
        let part_path = root.join("model.part");
        fs::write(&part_path, b"GGUFincomplete").unwrap();
        let metadata = SourceMetadata {
            url: "https://example.com/model.gguf".to_string(),
            etag: Some("stable-etag".to_string()),
            last_modified: None,
        };
        write_source_metadata(&part_path, &metadata).await.unwrap();

        let result = validate_or_reset_partial(
            &task,
            &part_path,
            14,
            Some("bytes 0-63/64"),
            Some(64),
            64,
            Some(&metadata),
            &metadata,
        )
        .await;

        assert!(result.is_err());
        assert!(!part_path.exists());
        assert!(!source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn blocked_stream_cancels_promptly_preserves_part_and_skips_fallback() {
        let root = temp_dir("blocked-stream");
        let dest = root.join("model.gguf");
        let part_path = dest.with_extension("part");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = leak(format!(
            "http://{}/model.gguf",
            listener.local_addr().unwrap()
        ));
        let (body_sent, body_received) = std::sync::mpsc::channel();
        let (release_server, wait_for_release) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut stream = accept_loopback(&listener);
            let _ = read_loopback_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: test-etag\r\n\r\nGGUF")
                .unwrap();
            stream.flush().unwrap();
            body_sent.send(()).unwrap();
            let _ = wait_for_release.recv_timeout(Duration::from_secs(2));
        });

        let state = DownloadTaskState::default();
        let task = Arc::new(state.begin(GgufModelVariant::Q4KM).unwrap());
        let task_for_download = task.clone();
        let dest_for_download = dest.clone();
        let sources = vec![
            DownloadSource {
                name: "blocked",
                url,
            },
            DownloadSource {
                name: "must-not-run",
                url: "http://127.0.0.1:9/fallback.gguf",
            },
        ];
        let download = tokio::spawn(async move {
            let client = build_http_client().unwrap();
            download_file_with_fallback(
                None,
                &task_for_download,
                &client,
                &sources,
                &dest_for_download,
                "model",
                8,
                false,
                false,
                || {},
            )
            .await
        });

        tokio::task::spawn_blocking(move || {
            body_received.recv_timeout(Duration::from_secs(2)).unwrap()
        })
        .await
        .unwrap();
        for _ in 0..100 {
            if fs::metadata(&part_path).map(|meta| meta.len()).ok() == Some(4) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        state.cancel(task.task_id()).unwrap();
        let result = tokio::time::timeout(Duration::from_millis(300), download)
            .await
            .expect("blocked stream should be interrupted")
            .unwrap();
        release_server.send(()).ok();
        server.join().unwrap();

        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert_eq!(fs::read(&part_path).unwrap(), b"GGUF");
        assert!(source_metadata_path(&part_path).exists());
        assert!(!dest.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn blocked_response_cancels_promptly_and_preserves_existing_partial() {
        let root = temp_dir("blocked-response");
        let dest = root.join("model.gguf");
        let part_path = dest.with_extension("part");
        fs::write(&part_path, b"GGUFOLD").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = leak(format!(
            "http://{}/model.gguf",
            listener.local_addr().unwrap()
        ));
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: url.to_string(),
                etag: Some("stable-etag".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();
        let (request_seen, wait_for_request) = std::sync::mpsc::channel();
        let (release_server, wait_for_release) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut stream = accept_loopback(&listener);
            let _ = read_loopback_request(&mut stream);
            request_seen.send(()).unwrap();
            let _ = wait_for_release.recv_timeout(Duration::from_secs(2));
        });

        let state = DownloadTaskState::default();
        let task = Arc::new(state.begin(GgufModelVariant::Q4KM).unwrap());
        let task_for_download = task.clone();
        let dest_for_download = dest.clone();
        let sources = vec![
            DownloadSource {
                name: "blocked",
                url,
            },
            DownloadSource {
                name: "must-not-run",
                url: "http://127.0.0.1:9/fallback.gguf",
            },
        ];
        let download = tokio::spawn(async move {
            let client = build_http_client().unwrap();
            download_file_with_fallback(
                None,
                &task_for_download,
                &client,
                &sources,
                &dest_for_download,
                "model",
                8,
                false,
                false,
                || {},
            )
            .await
        });

        tokio::task::spawn_blocking(move || {
            wait_for_request
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
        })
        .await
        .unwrap();
        state.cancel(task.task_id()).unwrap();
        let result = tokio::time::timeout(Duration::from_millis(300), download)
            .await
            .expect("blocked response should be interrupted")
            .unwrap();
        release_server.send(()).ok();
        server.join().unwrap();

        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert_eq!(fs::read(&part_path).unwrap(), b"GGUFOLD");
        assert!(source_metadata_path(&part_path).exists());
        assert!(!dest.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn accepted_cancellation_after_source_failure_prevents_fallback_reset() {
        let root = temp_dir("cancel-before-fallback");
        let dest = root.join("model.gguf");
        let part_path = dest.with_extension("part");
        fs::write(&part_path, b"GGUFOLD").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = leak(format!(
            "http://{}/model.gguf",
            listener.local_addr().unwrap()
        ));
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: url.to_string(),
                etag: Some("stable-etag".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = accept_loopback(&listener);
            let _ = read_loopback_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();
        let cancel_state = state.clone();
        let sources = vec![
            DownloadSource {
                name: "failed",
                url,
            },
            DownloadSource {
                name: "must-not-run",
                url: "http://127.0.0.1:9/fallback.gguf",
            },
        ];
        let client = build_http_client().unwrap();
        let result = download_file_with_fallback(
            None,
            &task,
            &client,
            &sources,
            &dest,
            "model",
            8,
            false,
            false,
            move || cancel_state.cancel(task_id).unwrap(),
        )
        .await;
        server.join().unwrap();

        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert_eq!(fs::read(&part_path).unwrap(), b"GGUFOLD");
        assert!(source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_final_failure_seal_returns_canceled() {
        let root = temp_dir("cancel-final-failure");
        let dest = root.join("model.gguf");
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();
        let cancel_state = state.clone();
        let sources = [DownloadSource {
            name: "invalid",
            url: "://invalid",
        }];

        let result = download_file_with_fallback(
            None,
            &task,
            &build_http_client().unwrap(),
            &sources,
            &dest,
            "model",
            8,
            false,
            false,
            move || cancel_state.cancel(task_id).unwrap(),
        )
        .await;

        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert_eq!(state.snapshot().unwrap().status, "canceled");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn final_failure_seals_failed_before_returning() {
        let root = temp_dir("seal-final-failure");
        let dest = root.join("model.gguf");
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();
        let sources = [DownloadSource {
            name: "invalid",
            url: "://invalid",
        }];

        let result = download_file_with_fallback(
            None,
            &task,
            &build_http_client().unwrap(),
            &sources,
            &dest,
            "model",
            8,
            false,
            false,
            || {},
        )
        .await;

        assert!(matches!(result, Err(DownloadError::Failed(_))));
        assert_eq!(state.snapshot().unwrap().status, "failed");
        assert!(state.cancel(task_id).unwrap_err().contains("太晚"));
        drop(task);
        assert_eq!(state.snapshot().unwrap().status, "failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn force_redownload_requests_fallback_and_replaces_valid_destination() {
        let root = temp_dir("force-fallback");
        let dest = root.join("model.gguf");
        fs::write(&dest, b"GGUFOLD!").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let first_url = leak(format!("http://{address}/first.gguf"));
        let second_url = leak(format!("http://{address}/second.gguf"));
        let (requests_sent, requests_received) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut requests = Vec::new();
            while requests.len() < 2 && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let request = read_loopback_request(&mut stream);
                        requests.push(String::from_utf8_lossy(&request).to_string());
                        if requests.len() == 1 {
                            stream
                                .write_all(
                                    b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n",
                                )
                                .unwrap();
                        } else {
                            stream
                                .write_all(
                                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: new-etag\r\n\r\nGGUFNEW!",
                                )
                                .unwrap();
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("loopback accept failed: {error}"),
                }
            }
            requests_sent.send(requests).unwrap();
        });

        let (_state, task) = test_task();
        let client = build_http_client().unwrap();
        let sources = vec![
            DownloadSource {
                name: "first",
                url: first_url,
            },
            DownloadSource {
                name: "second",
                url: second_url,
            },
        ];
        let result = download_file_with_fallback(
            None,
            &task,
            &client,
            &sources,
            &dest,
            "model",
            8,
            true,
            false,
            || {},
        )
        .await;
        server.join().unwrap();
        let requests = requests_received.recv().unwrap();

        assert!(result.is_ok(), "force fallback failed: {result:?}");
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("GET /first.gguf"));
        assert!(requests[1].contains("GET /second.gguf"));
        assert_eq!(fs::read(&dest).unwrap(), b"GGUFNEW!");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn accepted_cancellation_prevents_actual_file_promotion() {
        let root = temp_dir("cancel-before-promote");
        let part_path = root.join("model.part");
        let dest = root.join("model.gguf");
        fs::write(&part_path, b"GGUFNEW!").unwrap();
        fs::write(&dest, b"GGUFOLD!").unwrap();
        let (state, task) = test_task();
        state.cancel(task.task_id()).unwrap();

        let result =
            finalize_part_file(&task, &part_path, &dest, 8, false, &no_op_promotion_hook).await;

        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert_eq!(fs::read(&part_path).unwrap(), b"GGUFNEW!");
        assert_eq!(fs::read(&dest).unwrap(), b"GGUFOLD!");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn promotion_failure_preserves_existing_valid_destination() {
        let root = temp_dir("promotion-failure");
        let part_path = root.join("model.part");
        let dest = root.join("model.gguf");
        fs::write(&part_path, b"GGUFNEW!").unwrap();
        fs::write(&dest, b"GGUFOLD!").unwrap();
        let (_state, task) = test_task();
        let part_to_remove = part_path.clone();
        let remove_candidate = move || fs::remove_file(&part_to_remove).unwrap();

        let result =
            finalize_part_file(&task, &part_path, &dest, 8, false, &remove_candidate).await;

        assert!(result.is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"GGUFOLD!");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn range_request_answered_with_200_restarts_from_zero() {
        let root = temp_dir("range-200");
        let dest = root.join("model.gguf");
        let part_path = dest.with_extension("part");
        fs::write(&part_path, b"GGUFOLD").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = leak(format!(
            "http://{}/model.gguf",
            listener.local_addr().unwrap()
        ));
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: url.to_string(),
                etag: Some("old-etag".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = accept_loopback(&listener);
            let request = read_loopback_request(&mut stream);
            let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
            assert!(request.contains("range: bytes=7-"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: new-etag\r\n\r\nGGUFNEW!",
                )
                .unwrap();
        });

        let (_state, task) = test_task();
        let client = build_http_client().unwrap();
        let result = download_file(
            None,
            &task,
            &client,
            url,
            &dest,
            "model",
            "local",
            8,
            false,
            false,
            &no_op_promotion_hook,
        )
        .await;
        server.join().unwrap();

        assert_eq!(result.unwrap(), 8);
        assert_eq!(fs::read(&dest).unwrap(), b"GGUFNEW!");
        assert!(!part_path.exists());
        assert!(!source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn valid_206_resumes_with_if_range_and_promotes_exact_file() {
        let root = temp_dir("range-206");
        let dest = root.join("model.gguf");
        let part_path = dest.with_extension("part");
        fs::write(&part_path, b"GGUF").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = leak(format!(
            "http://{}/model.gguf",
            listener.local_addr().unwrap()
        ));
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: url.to_string(),
                etag: Some("\"stable-etag\"".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = accept_loopback(&listener);
            let request = read_loopback_request(&mut stream);
            let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
            assert!(request.contains("range: bytes=4-\r\n"));
            assert!(request.contains("if-range: \"stable-etag\"\r\n"));
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 4-7/8\r\nETag: \"stable-etag\"\r\n\r\nNEW!",
                )
                .unwrap();
        });

        let (_state, task) = test_task();
        let client = build_http_client().unwrap();
        let result = download_file(
            None,
            &task,
            &client,
            url,
            &dest,
            "model",
            "local",
            8,
            false,
            false,
            &no_op_promotion_hook,
        )
        .await;
        server.join().unwrap();

        assert_eq!(result.unwrap(), 8);
        assert_eq!(fs::read(&dest).unwrap(), b"GGUFNEW!");
        assert!(!part_path.exists());
        assert!(!source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn short_chunked_206_body_is_rejected_and_partial_is_reset() {
        let root = temp_dir("range-206-short-body");
        let dest = root.join("model.gguf");
        let part_path = dest.with_extension("part");
        fs::write(&part_path, b"GGUF").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = leak(format!(
            "http://{}/model.gguf",
            listener.local_addr().unwrap()
        ));
        write_source_metadata(
            &part_path,
            &SourceMetadata {
                url: url.to_string(),
                etag: Some("\"stable-etag\"".to_string()),
                last_modified: None,
            },
        )
        .await
        .unwrap();
        let server = std::thread::spawn(move || {
            let mut stream = accept_loopback(&listener);
            let _ = read_loopback_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\nContent-Range: bytes 4-7/8\r\nETag: \"stable-etag\"\r\n\r\n3\r\nNEW\r\n0\r\n\r\n",
                )
                .unwrap();
        });

        let (_state, task) = test_task();
        let client = build_http_client().unwrap();
        let result = download_file(
            None,
            &task,
            &client,
            url,
            &dest,
            "model",
            "local",
            8,
            false,
            false,
            &no_op_promotion_hook,
        )
        .await;
        server.join().unwrap();

        assert!(result.is_err());
        assert!(!dest.exists());
        assert!(!part_path.exists());
        assert!(!source_metadata_path(&part_path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_downloader_cancel_and_finalization_have_exactly_one_winner() {
        let root = temp_dir("downloader-finalization-race");
        let dest = root.join("model.gguf");
        let part_path = dest.with_extension("part");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = leak(format!(
            "http://{}/model.gguf",
            listener.local_addr().unwrap()
        ));
        let server = std::thread::spawn(move || {
            let mut stream = accept_loopback(&listener);
            let _ = read_loopback_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: race-etag\r\n\r\nGGUFRACE",
                )
                .unwrap();
        });

        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();
        let race = Arc::new(std::sync::Barrier::new(2));
        let cancel_race = race.clone();
        let cancel_state = state.clone();
        let cancel = std::thread::spawn(move || {
            cancel_race.wait();
            cancel_state.cancel(task_id)
        });
        let promotion_race = race.clone();
        let before_promotion = move || {
            promotion_race.wait();
        };

        let client = build_http_client().unwrap();
        let download = download_file(
            None,
            &task,
            &client,
            url,
            &dest,
            "model",
            "local",
            8,
            false,
            true,
            &before_promotion,
        )
        .await;
        let cancellation = cancel.join().unwrap();
        server.join().unwrap();

        match (cancellation, download) {
            (Ok(()), Err(DownloadError::Cancelled)) => {
                assert!(!dest.exists());
                assert_eq!(fs::read(&part_path).unwrap(), b"GGUFRACE");
                assert!(source_metadata_path(&part_path).exists());
            }
            (Err(error), Ok(bytes)) => {
                assert!(error.contains("太晚"));
                assert_eq!(bytes, 8);
                assert!(managed_file_is_valid(&dest, 8));
                assert!(!part_path.exists());
            }
            (cancellation, download) => panic!(
                "expected exactly one winner, got cancellation={cancellation:?}, download={download:?}"
            ),
        }
        fs::remove_dir_all(root).unwrap();
    }
}
