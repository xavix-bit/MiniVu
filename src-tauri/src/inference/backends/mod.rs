mod llama;
mod mlx;

use crate::inference_backend::sidecar_port;
use crate::model_cache::{ModelPaths, MlxModelRef};
use crate::settings::InferenceBackend;
use std::process::Child;
use std::time::Duration;
use tauri::AppHandle;

pub trait SidecarBackend: Send {
    fn kind(&self) -> InferenceBackend;
    fn ready_timeout(&self) -> Duration;
    fn spawn(&self, app: &AppHandle, port: u16) -> Result<Child, String>;
}

pub fn backend_for(kind: InferenceBackend, paths: ModelPaths, mlx: MlxModelRef) -> Box<dyn SidecarBackend> {
    match kind {
        InferenceBackend::Llama => Box::new(llama::LlamaBackend { paths }),
        InferenceBackend::Mlx => Box::new(mlx::MlxBackend { model: mlx }),
    }
}

pub fn port_for(backend: InferenceBackend) -> u16 {
    sidecar_port(backend)
}

pub use llama::LlamaBackend;
pub use mlx::{mlx_sidecar_log_path, read_mlx_sidecar_log_tail, MlxBackend};
