use crate::inference::backends::{backend_for, port_for};
use crate::inference_backend::{resolve_active_backend, sidecar_port};
use crate::model_cache::ModelCache;
use crate::settings::{load_settings, InferenceBackend};
use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub struct ModelSidecar {
    pub port: u16,
    child: Option<Child>,
    last_used: Mutex<Option<Instant>>,
    service_ready: Mutex<bool>,
    active_backend: Mutex<Option<InferenceBackend>>,
}

impl ModelSidecar {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            child: None,
            last_used: Mutex::new(None),
            service_ready: Mutex::new(false),
            active_backend: Mutex::new(None),
        }
    }

    fn active_backend(&self) -> Option<InferenceBackend> {
        self.active_backend.lock().ok().and_then(|guard| *guard)
    }

    fn set_active_backend(&self, backend: Option<InferenceBackend>) {
        if let Ok(mut guard) = self.active_backend.lock() {
            *guard = backend;
        }
    }

    pub fn set_service_ready(&self, ready: bool) {
        if let Ok(mut guard) = self.service_ready.lock() {
            *guard = ready;
        }
    }

    pub fn is_service_ready(&self) -> bool {
        self.service_ready
            .lock()
            .map(|guard| *guard)
            .unwrap_or(false)
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
        self.set_service_ready(false);
        self.set_active_backend(None);
    }

    pub fn ensure_started(&mut self, app: &AppHandle) -> Result<(), String> {
        let settings = load_settings(app)?;
        let backend = resolve_active_backend(settings.inference_backend, app)?;
        let desired_port = sidecar_port(backend);

        if self.is_running() {
            if self.port == desired_port && self.active_backend() == Some(backend) {
                return Ok(());
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

        let cache = ModelCache::new(app)?;
        let paths = cache.resolve(settings.gguf_model_variant);
        let mlx = cache.resolve_mlx(Some(settings.mlx_model_id.as_str()));

        let launcher = backend_for(backend, paths, mlx);
        let child = launcher.spawn(app, self.port)?;
        self.child = Some(child);

        self.set_active_backend(Some(backend));
        self.set_service_ready(false);
        Ok(())
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
