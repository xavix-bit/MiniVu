use crate::model_cache;
use crate::model_download::task::DownloadTaskGuard;
use crate::runtime_installer::emit_setup_progress;
use tauri::{AppHandle, Emitter};

pub fn emit_setup_progress_for_file(
    app: &AppHandle,
    label: &str,
    setup_status: &str,
    message: &str,
    percent: u8,
) {
    emit_setup_progress(app, label, setup_status, message, percent);
}

pub fn emit_download_progress(
    app: &AppHandle,
    task: &DownloadTaskGuard,
    label: &str,
    source_name: &str,
    downloaded: u64,
    total: Option<u64>,
    speed_mbps: Option<f64>,
    status: &str,
    message: Option<&str>,
) {
    let percent = if status == "done" {
        100
    } else if let Some(total_bytes) = total.filter(|value| *value > 0) {
        ((downloaded * 100) / total_bytes).min(100) as u8
    } else if let Some(expected) = model_cache::expected_bytes_for_label(label) {
        ((downloaded * 100) / expected).min(99) as u8
    } else {
        0
    };

    let message_owned = message.map(|value| value.to_string()).unwrap_or_else(|| {
        if status == "done" {
            "下载完成".to_string()
        } else {
            format!("正在下载… {percent}%")
        }
    });

    task.update(status, Some(label), downloaded, total, Some(source_name));

    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "file": label,
            "taskId": task.task_id(),
            "variant": task.variant(),
            "status": status,
            "downloaded": downloaded,
            "total": total,
            "percent": percent,
            "source": source_name,
            "speedMbps": speed_mbps,
            "message": message_owned,
        }),
    );

    if status == "running" || status == "done" {
        let setup_status = if status == "done" { "done" } else { "running" };
        emit_setup_progress(app, label, setup_status, &message_owned, percent);
    }
}

pub fn emit_task_progress(
    app: &AppHandle,
    task: &DownloadTaskGuard,
    label: &str,
    status: &str,
    message: &str,
    downloaded: u64,
    total: Option<u64>,
    source: Option<&str>,
) {
    task.update(status, Some(label), downloaded, total, source);
    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "taskId": task.task_id(),
            "variant": task.variant(),
            "file": label,
            "status": status,
            "message": message,
            "downloaded": downloaded,
            "total": total,
            "percent": 0,
            "source": source,
        }),
    );
}

pub fn emit_mlx_download_progress(
    app: &AppHandle,
    status: &str,
    message: &str,
    downloaded: u64,
    percent: u8,
) {
    let _ = app.emit(
        "model-download-progress",
        serde_json::json!({
            "file": "mlx",
            "status": status,
            "message": message,
            "downloaded": downloaded,
            "total": model_cache::ESTIMATED_MLX_BYTES,
            "percent": percent,
        }),
    );
}
