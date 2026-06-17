use crate::model_cache::{mlx_hub_model_cached, ModelCache, ESTIMATED_MLX_BYTES};
use crate::model_download::progress::emit_mlx_download_progress;
use crate::runtime_installer::{emit_setup_progress, resolve_mlx_python};
use crate::settings::load_settings;
use std::time::Duration;
use tauri::AppHandle;

pub async fn download_mlx_model(app: AppHandle, force: Option<bool>) -> Result<String, String> {
    let force = force.unwrap_or(false);
    let settings = load_settings(&app)?;
    let cache = ModelCache::new(&app)?;
    let mlx = cache.resolve_mlx(
        settings.mlx_model_path.as_deref(),
        Some(settings.mlx_model_id.as_str()),
    );

    if mlx.is_local {
        if mlx.is_ready() {
            emit_mlx_download_progress(&app, "done", "本地 MLX 权重已就绪", ESTIMATED_MLX_BYTES, 100);
            return Ok(mlx.spec);
        }
        return Err("本地 MLX 目录无效，请检查 config.json 与权重文件。".to_string());
    }

    if !force && mlx.is_ready() {
        emit_mlx_download_progress(&app, "done", "已存在，跳过下载", ESTIMATED_MLX_BYTES, 100);
        return Ok(mlx.spec.clone());
    }

    let python = resolve_mlx_python(&app)
        .ok_or_else(|| "MLX 推理环境未安装。请先在设置中安装 MLX 引擎。".to_string())?;

    let model_id = mlx.spec.clone();
    emit_mlx_download_progress(&app, "running", "正在从 HuggingFace 下载 MLX 权重…", 0, 0);
    emit_setup_progress(&app, "model", "running", "正在下载 MLX 模型权重…", 0);

    let python_for_task = python.clone();
    let model_id_for_task = model_id.clone();
    let download_task = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&python_for_task)
            .args([
                "-c",
                "from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1])",
                &model_id_for_task,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    });

    while !download_task.is_finished() {
        let bytes = crate::model_cache::mlx_hub_cache_bytes(&model_id);
        let percent = ((bytes.saturating_mul(100)) / ESTIMATED_MLX_BYTES).min(99) as u8;
        emit_mlx_download_progress(
            &app,
            "running",
            "正在下载 MLX 模型权重…",
            bytes,
            percent,
        );
        emit_setup_progress(
            &app,
            "model",
            "running",
            &format!("正在下载 MLX 模型权重… {percent}%"),
            percent,
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let status = download_task
        .await
        .map_err(|e| format!("下载任务失败: {e}"))?
        .map_err(|e| format!("无法启动 MLX 下载: {e}"))?;

    if !status.success() {
        return Err("MLX 模型下载失败，请检查网络后重试。".to_string());
    }

    if !mlx_hub_model_cached(&model_id) {
        return Err("MLX 模型下载完成但校验失败，请重试。".to_string());
    }

    emit_mlx_download_progress(&app, "done", "下载完成", ESTIMATED_MLX_BYTES, 100);
    emit_setup_progress(&app, "model", "done", "MLX 模型权重已就绪", 100);
    emit_setup_progress(&app, "mmproj", "done", "MLX 模式无需 mmproj", 100);
    Ok(model_id)
}
