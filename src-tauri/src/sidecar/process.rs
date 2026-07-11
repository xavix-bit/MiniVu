use crate::inference::backends::{backend_for, port_for};
use crate::inference::context::{ActiveInferenceContext, SidecarIdentity};
use crate::inference_backend::sidecar_port;
use crate::settings::InferenceBackend;
use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub struct ModelSidecar {
    pub port: u16,
    child: Option<Child>,
    last_used: Mutex<Option<Instant>>,
    active_identity: Option<SidecarIdentity>,
    generation: u64,
    ready_generation: Option<u64>,
}

impl ModelSidecar {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            child: None,
            last_used: Mutex::new(None),
            active_identity: None,
            generation: 0,
            ready_generation: None,
        }
    }

    pub fn active_identity(&self) -> Option<&SidecarIdentity> {
        self.active_identity.as_ref()
    }

    pub fn generation(&self) -> Option<u64> {
        self.active_identity.as_ref().map(|_| self.generation)
    }

    pub fn set_service_ready(&mut self, generation: u64, ready: bool) -> bool {
        if self.generation != generation || self.active_identity.is_none() {
            return false;
        }
        self.ready_generation = ready.then_some(generation);
        true
    }

    pub fn is_service_ready(&self, generation: u64) -> bool {
        self.ready_generation == Some(generation) && self.generation == generation
    }

    fn start_generation(&mut self, identity: SidecarIdentity) -> u64 {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.active_identity = Some(identity);
        self.ready_generation = None;
        self.generation
    }

    pub fn is_running(&mut self) -> bool {
        if let Some(child) = &mut self.child {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        }
    }

    pub fn is_child_alive(&mut self) -> bool {
        self.is_running()
    }

    pub fn touch(&self) {
        if let Ok(mut guard) = self.last_used.lock() {
            *guard = Some(Instant::now());
        }
    }

    pub fn should_unload(&self, warm_minutes: i32) -> bool {
        if warm_minutes < 0 {
            return false;
        }
        let warm = Duration::from_secs((warm_minutes as u64) * 60);
        self.last_used
            .lock()
            .ok()
            .and_then(|guard| guard.map(|instant| instant.elapsed() > warm))
            .unwrap_or(false)
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.active_identity = None;
        self.ready_generation = None;
    }

    pub fn stop_and_confirm(&mut self) -> Result<(), String> {
        self.stop();
        if self.is_running() {
            Err("无法停止当前推理进程，请稍后重试。".to_string())
        } else {
            Ok(())
        }
    }

    pub fn ensure_started(
        &mut self,
        app: &AppHandle,
        context: &ActiveInferenceContext,
    ) -> Result<u64, String> {
        let backend = context.backend;
        let desired_port = sidecar_port(backend);
        let desired_identity = context.sidecar_identity();

        if self.is_running() {
            if self.port == desired_port && self.active_identity() == Some(&desired_identity) {
                return Ok(self.generation);
            }
            self.stop();
        }

        self.port = desired_port;

        if is_port_in_use(desired_port) {
            terminate_listeners_on_port(desired_port)?;
            if is_port_in_use(desired_port) {
                return Err(format!(
                    "推理端口 {desired_port} 被占用，请关闭其他 MiniVu 窗口后重试。"
                ));
            }
        }

        let launcher = backend_for(backend, context.paths.clone(), context.mlx.clone());
        let child = launcher.spawn(app, self.port)?;
        self.child = Some(child);
        Ok(self.start_generation(desired_identity))
    }
}

fn is_port_in_use(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn terminate_listeners_on_port(port: u16) -> Result<(), String> {
    #[cfg(unix)]
    {
        let output = Command::new("lsof")
            .args(["-ti", &format!(":{port}")])
            .output()
            .map_err(|e| format!("无法检查端口 {port}: {e}"))?;
        if !output.status.success() {
            return Ok(());
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let pid = line.trim();
            if pid.is_empty() {
                continue;
            }
            let _ = Command::new("kill").arg(pid).status();
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    #[cfg(not(unix))]
    {
        let _ = port;
    }
    Ok(())
}

pub fn default_sidecar_port() -> u16 {
    port_for(InferenceBackend::Llama)
}

#[cfg(test)]
mod tests {
    use super::ModelSidecar;
    use crate::inference::context::{ActiveInferenceContext, SidecarIdentity};
    use std::path::PathBuf;
    use tauri::AppHandle;

    #[test]
    fn startup_requires_a_resolved_inference_context() {
        fn assert_signature(
            _: fn(&mut ModelSidecar, &AppHandle, &ActiveInferenceContext) -> Result<u64, String>,
        ) {
        }

        assert_signature(ModelSidecar::ensure_started);
    }

    #[test]
    fn llama_identity_differs_when_model_path_differs() {
        let first = SidecarIdentity::Llama {
            model: PathBuf::from("/models/q4.gguf"),
            mmproj: PathBuf::from("/models/mmproj.gguf"),
        };
        let second = SidecarIdentity::Llama {
            model: PathBuf::from("/models/q5.gguf"),
            mmproj: PathBuf::from("/models/mmproj.gguf"),
        };
        assert_ne!(first, second);
    }

    #[test]
    fn backend_is_part_of_sidecar_identity() {
        let llama = SidecarIdentity::Llama {
            model: PathBuf::from("model.gguf"),
            mmproj: PathBuf::from("mmproj.gguf"),
        };
        let mlx = SidecarIdentity::Mlx {
            spec: "model.gguf".to_string(),
        };

        assert_ne!(llama, mlx);
    }

    #[test]
    fn stale_generation_cannot_mark_new_process_ready() {
        let mut sidecar = ModelSidecar::new(18765);
        let old = sidecar.start_generation(SidecarIdentity::Mlx {
            spec: "old/model".to_string(),
        });
        let new = sidecar.start_generation(SidecarIdentity::Mlx {
            spec: "new/model".to_string(),
        });

        assert!(!sidecar.set_service_ready(old, true));
        assert!(!sidecar.is_service_ready(old));
        assert!(sidecar.set_service_ready(new, true));
        assert!(sidecar.is_service_ready(new));
    }
}
