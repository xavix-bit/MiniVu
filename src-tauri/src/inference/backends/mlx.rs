use super::SidecarBackend;
use crate::model_cache::MlxModelRef;
use crate::runtime_installer::resolve_mlx_python;
use crate::settings::InferenceBackend;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub struct MlxBackend {
    pub model: MlxModelRef,
}

pub fn mlx_sidecar_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    Ok(dir.join("mlx-sidecar.log"))
}

pub fn read_mlx_sidecar_log_tail(app: &AppHandle, max_lines: usize) -> String {
    let Ok(path) = mlx_sidecar_log_path(app) else {
        return String::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return String::new();
    };
    raw.lines()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

impl SidecarBackend for MlxBackend {
    fn kind(&self) -> InferenceBackend {
        InferenceBackend::Mlx
    }

    fn ready_timeout(&self) -> Duration {
        Duration::from_secs(900)
    }

    fn spawn(&self, app: &AppHandle, port: u16) -> Result<std::process::Child, String> {
        let python = resolve_mlx_python(app).ok_or_else(|| "MLX 未安装。".to_string())?;

        let log_path = mlx_sidecar_log_path(app)?;
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let stderr_file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
            .map_err(|e| format!("无法写入 MLX 日志: {e}"))?;

        Command::new(&python)
            .args([
                "-m",
                "mlx_vlm.server",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--model",
                &self.model.spec,
                "--trust-remote-code",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_file))
            .spawn()
            .map_err(|e| format!("启动 MLX 推理服务失败: {e}"))
    }
}
