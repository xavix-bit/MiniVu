use super::{lock_sidecar, SidecarState};
use crate::inference::context::ActiveInferenceContext;
use crate::inference::wait_for_sidecar_ready;
use crate::settings::load_settings;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 设置变更后停止侧车，下次识图时按新后端/路径重新启动。
pub fn on_settings_saved(app: &AppHandle) {
    lock_sidecar(app.state::<SidecarState>().inner()).stop();
}

pub fn spawn_idle_unloader(app: AppHandle) {
    let sidecar = app.state::<SidecarState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let settings = match load_settings(&app) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let mut guard = lock_sidecar(&sidecar);
            if guard.should_unload(settings.model_warm_minutes) {
                guard.stop();
            }
        }
    });
}

async fn warmup_model_inner(app: &AppHandle, sidecar: &SidecarState) -> Result<(), String> {
    let settings = load_settings(app)?;
    if !settings.preload_model {
        return Ok(());
    }

    let ctx = ActiveInferenceContext::load(app)?;
    if !ctx.models_ready {
        return Ok(());
    }

    let port = {
        let mut guard = lock_sidecar(sidecar);
        guard.touch();
        guard.ensure_started(app)?;
        guard.port
    };

    let cancel = AtomicBool::new(false);
    let sidecar_state = sidecar.clone();
    wait_for_sidecar_ready(app, port, ctx.backend, &cancel, &sidecar_state).await?;
    lock_sidecar(sidecar).set_service_ready(true);
    Ok(())
}

pub fn spawn_model_warmup(app: AppHandle) {
    let sidecar = app.state::<SidecarState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let settings = match load_settings(&app) {
            Ok(value) => value,
            Err(_) => return,
        };
        if !settings.preload_model {
            return;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Err(error) = warmup_model_inner(&app, &sidecar).await {
            eprintln!("模型预热: {error}");
            let _ = app.emit("warmup-failed", serde_json::json!({ "message": error }));
        }
    });
}
