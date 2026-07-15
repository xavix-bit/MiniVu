pub mod lifecycle;
pub mod process;

pub use lifecycle::{on_settings_saved, spawn_idle_unloader};
pub use process::{default_sidecar_port, ModelSidecar};

use std::sync::{Arc, Mutex, MutexGuard};

pub type SidecarState = Arc<Mutex<ModelSidecar>>;

pub fn init_sidecar_state() -> SidecarState {
    Arc::new(Mutex::new(ModelSidecar::new(default_sidecar_port())))
}

/// 获取 sidecar 锁；若先前任务 panic 导致 mutex poison，自动恢复而不是向用户报错。
pub fn lock_sidecar(sidecar: &SidecarState) -> MutexGuard<'_, ModelSidecar> {
    match sidecar.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("sidecar state lock was poisoned, recovering");
            poisoned.into_inner()
        }
    }
}

pub struct SidecarActivity {
    sidecar: SidecarState,
}

impl Drop for SidecarActivity {
    fn drop(&mut self) {
        lock_sidecar(&self.sidecar).finish_activity();
    }
}

pub fn begin_sidecar_activity(sidecar: &SidecarState) -> SidecarActivity {
    lock_sidecar(sidecar).begin_activity();
    SidecarActivity {
        sidecar: sidecar.clone(),
    }
}
