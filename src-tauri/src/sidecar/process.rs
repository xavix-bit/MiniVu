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
    activity: Mutex<ActivityState>,
    service_ready: Mutex<bool>,
    active_backend: Mutex<Option<InferenceBackend>>,
}

#[derive(Default)]
struct ActivityState {
    active_jobs: usize,
    restart_pending: bool,
}

impl ModelSidecar {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            child: None,
            last_used: Mutex::new(None),
            activity: Mutex::new(ActivityState::default()),
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

    /// Enters the sidecar only when no settings-driven restart is pending.
    /// Callers retry asynchronously so the outer sidecar mutex is never held while waiting.
    pub fn try_begin_activity(&self) -> bool {
        let admitted = self
            .activity
            .lock()
            .map(|mut state| {
                if state.restart_pending {
                    return false;
                }
                state.active_jobs += 1;
                true
            })
            .unwrap_or(false);
        if !admitted {
            return false;
        }
        self.touch();
        true
    }

    pub fn finish_activity(&mut self) {
        let should_restart = self
            .activity
            .lock()
            .map(|mut state| {
                state.active_jobs = state.active_jobs.saturating_sub(1);
                if state.active_jobs == 0 && state.restart_pending {
                    state.restart_pending = false;
                    return true;
                }
                false
            })
            .unwrap_or(false);
        self.touch();
        if should_restart {
            self.stop();
        }
    }

    pub fn request_restart(&mut self) {
        let restart_now = self
            .activity
            .lock()
            .map(|mut state| {
                if state.active_jobs > 0 {
                    state.restart_pending = true;
                    false
                } else {
                    true
                }
            })
            .unwrap_or(false);
        if restart_now {
            self.stop();
        }
    }

    pub fn should_unload(&self) -> bool {
        self.should_unload_after(Duration::from_secs(10 * 60))
    }

    fn should_unload_after(&self, idle_timeout: Duration) -> bool {
        if self
            .activity
            .lock()
            .map(|state| state.active_jobs > 0 || state.restart_pending)
            .unwrap_or(true)
        {
            return false;
        }
        self.last_used
            .lock()
            .ok()
            .and_then(|guard| guard.map(|instant| instant.elapsed() >= idle_timeout))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unloads_only_after_ten_idle_minutes() {
        let sidecar = ModelSidecar::new(9000);
        *sidecar.last_used.lock().unwrap() = Some(Instant::now() - Duration::from_secs(599));
        assert!(!sidecar.should_unload());
        *sidecar.last_used.lock().unwrap() = Some(Instant::now() - Duration::from_secs(600));
        assert!(sidecar.should_unload());
    }

    #[test]
    fn active_work_never_unloads_and_resets_the_idle_clock() {
        let mut sidecar = ModelSidecar::new(9000);
        *sidecar.last_used.lock().unwrap() = Some(Instant::now() - Duration::from_secs(900));
        assert!(sidecar.try_begin_activity());
        assert!(!sidecar.should_unload());
        sidecar.finish_activity();
        assert!(!sidecar.should_unload());
    }

    #[test]
    fn settings_restart_waits_for_active_work() {
        let mut sidecar = ModelSidecar::new(9000);
        assert!(sidecar.try_begin_activity());

        sidecar.request_restart();

        let activity = sidecar.activity.lock().unwrap();
        assert_eq!(activity.active_jobs, 1);
        assert!(activity.restart_pending);
        drop(activity);
        assert!(!sidecar.try_begin_activity());

        sidecar.finish_activity();

        let activity = sidecar.activity.lock().unwrap();
        assert_eq!(activity.active_jobs, 0);
        assert!(!activity.restart_pending);
        drop(activity);
        assert!(sidecar.try_begin_activity());
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
