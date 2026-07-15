use super::{lock_sidecar, SidecarState};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 设置变更后安排重启；正在处理的任务完成前不会被中断。
pub fn on_settings_saved(app: &AppHandle) {
    lock_sidecar(app.state::<SidecarState>().inner()).request_restart();
}

pub fn spawn_idle_unloader(app: AppHandle) {
    let sidecar = app.state::<SidecarState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let mut guard = lock_sidecar(&sidecar);
            if guard.should_unload() {
                guard.stop();
            }
        }
    });
}
