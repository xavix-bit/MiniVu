use crate::platform_caps::is_apple_silicon;
use crate::settings::InferenceBackend;
use tauri::AppHandle;

pub const LLAMA_PORT: u16 = 18765;
pub const MLX_PORT: u16 = 18766;

pub fn sidecar_port(backend: InferenceBackend) -> u16 {
    match backend {
        InferenceBackend::Llama => LLAMA_PORT,
        InferenceBackend::Mlx => MLX_PORT,
    }
}

pub fn backend_label(backend: InferenceBackend) -> &'static str {
    match backend {
        InferenceBackend::Llama => "llama.cpp",
        InferenceBackend::Mlx => "MLX",
    }
}

pub fn mlx_runtime_ready(app: &AppHandle) -> bool {
    crate::runtime_installer::resolve_mlx_python(app).is_some()
}

pub fn resolve_active_backend(
    requested: InferenceBackend,
    app: &AppHandle,
) -> Result<InferenceBackend, String> {
    match requested {
        InferenceBackend::Llama => Ok(InferenceBackend::Llama),
        InferenceBackend::Mlx => {
            if !is_apple_silicon() {
                return Err("MLX 仅支持 Apple Silicon Mac。".to_string());
            }
            if !mlx_runtime_ready(app) {
                return Err("MLX 未安装。".to_string());
            }
            Ok(InferenceBackend::Mlx)
        }
    }
}
