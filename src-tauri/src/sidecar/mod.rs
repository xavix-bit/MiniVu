pub mod lifecycle;
pub mod process;

pub use lifecycle::{on_settings_saved, spawn_idle_unloader};
pub use process::{default_sidecar_port, ModelSidecar};

use std::sync::atomic::{AtomicBool, Ordering};
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

async fn wait_for_sidecar_activity(
    sidecar: &SidecarState,
    cancel: Option<&AtomicBool>,
) -> Option<SidecarActivity> {
    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return None;
        }
        {
            let guard = lock_sidecar(sidecar);
            if guard.try_begin_activity() {
                return Some(SidecarActivity {
                    sidecar: sidecar.clone(),
                });
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

pub async fn begin_sidecar_activity(sidecar: &SidecarState) -> SidecarActivity {
    wait_for_sidecar_activity(sidecar, None)
        .await
        .expect("non-cancellable sidecar activity wait cannot return None")
}

pub async fn begin_cancellable_sidecar_activity(
    sidecar: &SidecarState,
    cancel: &AtomicBool,
) -> Option<SidecarActivity> {
    wait_for_sidecar_activity(sidecar, Some(cancel)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_activity_can_be_cancelled_without_becoming_active() {
        let sidecar = init_sidecar_state();
        let active = begin_sidecar_activity(&sidecar).await;
        lock_sidecar(&sidecar).request_restart();

        let cancel = AtomicBool::new(true);
        assert!(begin_cancellable_sidecar_activity(&sidecar, &cancel)
            .await
            .is_none());

        drop(active);
        let next = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            begin_sidecar_activity(&sidecar),
        )
        .await;
        assert!(next.is_ok());
    }
}
