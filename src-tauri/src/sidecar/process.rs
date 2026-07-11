use crate::inference::backends::{backend_for, port_for};
use crate::inference::context::{ActiveInferenceContext, SidecarIdentity};
use crate::inference_backend::sidecar_port;
use crate::settings::InferenceBackend;
use std::io;
use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const STOP_POLL_INTERVAL: Duration = Duration::from_millis(20);
const STOP_POLL_ATTEMPTS: usize = 100;

trait ProcessControl {
    fn has_exited(&mut self) -> io::Result<bool>;
    fn kill_process(&mut self) -> io::Result<()>;
}

impl ProcessControl for Child {
    fn has_exited(&mut self) -> io::Result<bool> {
        self.try_wait().map(|status| status.is_some())
    }

    fn kill_process(&mut self) -> io::Result<()> {
        self.kill()
    }
}

fn terminate_and_confirm<P: ProcessControl>(
    process: &mut P,
    poll_attempts: usize,
    mut sleep: impl FnMut(),
) -> Result<(), String> {
    match process.has_exited() {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(error) => return Err(format!("无法检查推理进程状态：{error}")),
    }

    if let Err(kill_error) = process.kill_process() {
        return match process.has_exited() {
            Ok(true) => Ok(()),
            Ok(false) => Err(format!("无法停止推理进程：{kill_error}")),
            Err(wait_error) => Err(format!(
                "无法停止推理进程：{kill_error}；无法确认进程状态：{wait_error}"
            )),
        };
    }

    for _ in 0..poll_attempts {
        match process.has_exited() {
            Ok(true) => return Ok(()),
            Ok(false) => sleep(),
            Err(error) => return Err(format!("无法确认推理进程已停止：{error}")),
        }
    }
    Err("停止推理进程超时，请稍后重试。".to_string())
}

#[allow(clippy::too_many_arguments)]
fn ensure_identity_started<P: ProcessControl>(
    child: &mut Option<P>,
    port: &mut u16,
    active_identity: &mut Option<SidecarIdentity>,
    generation: &mut u64,
    ready_generation: &mut Option<u64>,
    desired_port: u16,
    desired_identity: SidecarIdentity,
    spawn: impl FnOnce(u16) -> Result<P, String>,
    stop_poll_attempts: usize,
    sleep: impl FnMut(),
) -> Result<u64, String> {
    let running = match child.as_mut() {
        Some(process) => match process.has_exited() {
            Ok(exited) => !exited,
            Err(error) => return Err(format!("无法检查推理进程状态：{error}")),
        },
        None => false,
    };

    if running && *port == desired_port && active_identity.as_ref() == Some(&desired_identity) {
        return Ok(*generation);
    }

    if let Some(process) = child.as_mut() {
        if running {
            terminate_and_confirm(process, stop_poll_attempts, sleep)?;
        }
        *child = None;
        *active_identity = None;
        *ready_generation = None;
    }

    let process = spawn(desired_port)?;
    *port = desired_port;
    *child = Some(process);
    *generation = generation.wrapping_add(1).max(1);
    *active_identity = Some(desired_identity);
    *ready_generation = None;
    Ok(*generation)
}

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

    #[cfg(test)]
    fn start_generation(&mut self, identity: SidecarIdentity) -> u64 {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.active_identity = Some(identity);
        self.ready_generation = None;
        self.generation
    }

    pub fn is_running(&mut self) -> bool {
        let exited = match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(status) => status.is_some(),
                Err(_) => return false,
            },
            None => return false,
        };
        if exited {
            self.child = None;
            self.active_identity = None;
            self.ready_generation = None;
        }
        !exited
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
        if let Err(error) = self.stop_and_confirm() {
            eprintln!("停止推理进程失败：{error}");
        }
    }

    pub fn stop_and_confirm(&mut self) -> Result<(), String> {
        if let Some(child) = self.child.as_mut() {
            terminate_and_confirm(child, STOP_POLL_ATTEMPTS, || {
                std::thread::sleep(STOP_POLL_INTERVAL)
            })?;
        }
        self.child = None;
        self.active_identity = None;
        self.ready_generation = None;
        Ok(())
    }

    pub fn ensure_started(
        &mut self,
        app: &AppHandle,
        context: &ActiveInferenceContext,
    ) -> Result<u64, String> {
        let backend = context.backend;
        let desired_port = sidecar_port(backend);
        let desired_identity = context.sidecar_identity();

        let launcher = backend_for(backend, context.paths.clone(), context.mlx.clone());
        ensure_identity_started(
            &mut self.child,
            &mut self.port,
            &mut self.active_identity,
            &mut self.generation,
            &mut self.ready_generation,
            desired_port,
            desired_identity,
            |port| {
                if is_port_in_use(port) {
                    terminate_listeners_on_port(port)?;
                    if is_port_in_use(port) {
                        return Err(format!(
                            "推理端口 {port} 被占用，请关闭其他 MiniVu 窗口后重试。"
                        ));
                    }
                }
                launcher.spawn(app, port)
            },
            STOP_POLL_ATTEMPTS,
            || std::thread::sleep(STOP_POLL_INTERVAL),
        )
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
    use super::{ensure_identity_started, terminate_and_confirm, ModelSidecar, ProcessControl};
    use crate::inference::context::{ActiveInferenceContext, SidecarIdentity};
    use std::cell::Cell;
    use std::io;
    use std::path::PathBuf;
    use std::rc::Rc;
    use tauri::AppHandle;

    struct FakeProcess {
        exited: bool,
        exits_after_kill: bool,
        kill_error: bool,
        wait_error: bool,
        kills: Rc<Cell<usize>>,
    }

    impl FakeProcess {
        fn running(kills: Rc<Cell<usize>>) -> Self {
            Self {
                exited: false,
                exits_after_kill: true,
                kill_error: false,
                wait_error: false,
                kills,
            }
        }
    }

    impl ProcessControl for FakeProcess {
        fn has_exited(&mut self) -> io::Result<bool> {
            if self.wait_error && self.kills.get() > 0 {
                Err(io::Error::other("wait failed"))
            } else {
                Ok(self.exited)
            }
        }

        fn kill_process(&mut self) -> io::Result<()> {
            self.kills.set(self.kills.get() + 1);
            if self.kill_error {
                return Err(io::Error::other("kill failed"));
            }
            if self.exits_after_kill {
                self.exited = true;
            }
            Ok(())
        }
    }

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

    #[test]
    fn already_exited_process_needs_no_kill() {
        let kills = Rc::new(Cell::new(0));
        let mut process = FakeProcess {
            exited: true,
            exits_after_kill: true,
            kill_error: false,
            wait_error: false,
            kills: kills.clone(),
        };

        terminate_and_confirm(&mut process, 1, || {}).unwrap();

        assert_eq!(kills.get(), 0);
    }

    #[test]
    fn kill_and_wait_errors_are_reported() {
        let kills = Rc::new(Cell::new(0));
        let mut kill_failure = FakeProcess::running(kills.clone());
        kill_failure.kill_error = true;
        assert!(terminate_and_confirm(&mut kill_failure, 1, || {})
            .unwrap_err()
            .contains("kill failed"));

        let mut wait_failure = FakeProcess::running(Rc::new(Cell::new(0)));
        wait_failure.exits_after_kill = false;
        wait_failure.wait_error = true;
        assert!(terminate_and_confirm(&mut wait_failure, 1, || {})
            .unwrap_err()
            .contains("wait failed"));
    }

    #[test]
    fn shutdown_timeout_is_reported_without_assuming_exit() {
        let kills = Rc::new(Cell::new(0));
        let mut process = FakeProcess::running(kills.clone());
        process.exits_after_kill = false;

        let error = terminate_and_confirm(&mut process, 2, || {}).unwrap_err();

        assert!(error.contains("超时"));
        assert_eq!(kills.get(), 1);
        assert!(!process.exited);
    }

    #[test]
    fn different_identity_stops_old_process_and_starts_new_generation() {
        let kills = Rc::new(Cell::new(0));
        let old_identity = SidecarIdentity::Llama {
            model: PathBuf::from("q4.gguf"),
            mmproj: PathBuf::from("mmproj.gguf"),
        };
        let new_identity = SidecarIdentity::Llama {
            model: PathBuf::from("q5.gguf"),
            mmproj: PathBuf::from("mmproj.gguf"),
        };
        let mut child = Some(FakeProcess::running(kills.clone()));
        let mut port = 18765;
        let mut identity = Some(old_identity);
        let mut generation = 7;
        let mut ready_generation = Some(7);
        let spawned = Rc::new(Cell::new(0));
        let spawned_for_closure = spawned.clone();

        let next_generation = ensure_identity_started(
            &mut child,
            &mut port,
            &mut identity,
            &mut generation,
            &mut ready_generation,
            18765,
            new_identity.clone(),
            |_| {
                spawned_for_closure.set(spawned_for_closure.get() + 1);
                Ok(FakeProcess::running(Rc::new(Cell::new(0))))
            },
            1,
            || {},
        )
        .unwrap();

        assert_eq!(kills.get(), 1);
        assert_eq!(spawned.get(), 1);
        assert_eq!(next_generation, 8);
        assert_eq!(identity, Some(new_identity));
        assert_eq!(ready_generation, None);
        assert!(child.is_some());
    }

    #[test]
    fn failed_shutdown_keeps_old_identity_and_blocks_spawn() {
        let kills = Rc::new(Cell::new(0));
        let old_identity = SidecarIdentity::Mlx {
            spec: "old".to_string(),
        };
        let mut child = Some(FakeProcess {
            exited: false,
            exits_after_kill: false,
            kill_error: false,
            wait_error: false,
            kills,
        });
        let mut port = 18766;
        let mut identity = Some(old_identity.clone());
        let mut generation = 3;
        let mut ready_generation = Some(3);
        let spawned = Rc::new(Cell::new(0));
        let spawned_for_closure = spawned.clone();

        let result = ensure_identity_started(
            &mut child,
            &mut port,
            &mut identity,
            &mut generation,
            &mut ready_generation,
            18766,
            SidecarIdentity::Mlx {
                spec: "new".to_string(),
            },
            |_| {
                spawned_for_closure.set(1);
                Ok(FakeProcess::running(Rc::new(Cell::new(0))))
            },
            1,
            || {},
        );

        assert!(result.unwrap_err().contains("超时"));
        assert_eq!(spawned.get(), 0);
        assert_eq!(identity, Some(old_identity));
        assert_eq!(generation, 3);
        assert_eq!(ready_generation, Some(3));
        assert!(child.is_some());
    }
}
