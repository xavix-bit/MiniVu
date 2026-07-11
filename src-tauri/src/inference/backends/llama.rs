use super::SidecarBackend;
use crate::inference_profile::detect_inference_profile;
use crate::model_cache::ModelPaths;
use crate::runtime_installer::resolve_llama_server;
use crate::settings::InferenceBackend;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::AppHandle;

pub struct LlamaBackend {
    pub paths: ModelPaths,
}

impl SidecarBackend for LlamaBackend {
    fn kind(&self) -> InferenceBackend {
        InferenceBackend::Llama
    }

    fn ready_timeout(&self) -> Duration {
        Duration::from_secs(300)
    }

    fn spawn(&self, app: &AppHandle, port: u16) -> Result<std::process::Child, String> {
        let binary = resolve_llama_server(app).ok_or_else(|| "内置 Metal 未就绪。".to_string())?;

        let profile = detect_inference_profile();
        let mut command = Command::new(&binary);
        command
            .arg("--model")
            .arg(&self.paths.model)
            .arg("--mmproj")
            .arg(&self.paths.mmproj)
            .arg("--port")
            .arg(port.to_string())
            .arg("--host")
            .arg("127.0.0.1")
            .arg("-c")
            .arg(profile.ctx_size.to_string())
            .arg("-t")
            .arg(profile.threads.to_string())
            .arg("-tb")
            .arg(profile.threads.to_string());

        if profile.gpu_layers > 0 {
            command.arg("-ngl").arg(profile.gpu_layers.to_string());
        }

        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 llama-server 失败: {e}"))
    }
}
