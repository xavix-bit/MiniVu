use super::{lock_sidecar, SidecarState};
use crate::inference::context::ActiveInferenceContext;
use crate::inference::{sidecar_health_ok, wait_for_sidecar_ready};
use crate::model_cache::ModelCache;
use crate::settings::load_settings;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) enum WarmupTrigger {
    Launch,
    UserImage,
}

pub(crate) fn should_warmup(
    trigger: WarmupTrigger,
    preload_model: bool,
    models_ready: bool,
) -> bool {
    models_ready
        && match trigger {
            WarmupTrigger::Launch => preload_model,
            WarmupTrigger::UserImage => true,
        }
}

fn should_warmup_for_launch(preload_model: bool, models_ready: bool) -> bool {
    should_warmup(WarmupTrigger::Launch, preload_model, models_ready)
}

fn should_warmup_for_user_image(preload_model: bool, models_ready: bool) -> bool {
    should_warmup(WarmupTrigger::UserImage, preload_model, models_ready)
}

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

async fn warmup_model_inner(
    app: &AppHandle,
    sidecar: &SidecarState,
    policy: fn(bool, bool) -> bool,
) -> Result<(), String> {
    let settings = load_settings(app)?;
    let cache = ModelCache::new(app)?;
    let ctx = ActiveInferenceContext::from_parts(app, &settings, &cache)?;
    if !policy(settings.preload_model, ctx.models_ready) {
        return Ok(());
    }

    let port = {
        let mut guard = lock_sidecar(sidecar);
        guard.touch();
        guard.ensure_started(app, &ctx)?;
        guard.port
    };

    if lock_sidecar(sidecar).is_service_ready() && sidecar_health_ok(port, ctx.backend).await {
        return Ok(());
    }

    let cancel = AtomicBool::new(false);
    let sidecar_state = sidecar.clone();
    wait_for_sidecar_ready(app, port, ctx.backend, &cancel, &sidecar_state).await?;
    lock_sidecar(sidecar).set_service_ready(true);
    Ok(())
}

async fn warmup_model_on_launch(app: &AppHandle, sidecar: &SidecarState) -> Result<(), String> {
    warmup_model_inner(app, sidecar, should_warmup_for_launch).await
}

pub(crate) async fn warmup_model_for_user_image(
    app: &AppHandle,
    sidecar: &SidecarState,
) -> Result<(), String> {
    warmup_model_inner(app, sidecar, should_warmup_for_user_image).await
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
        if let Err(error) = warmup_model_on_launch(&app, &sidecar).await {
            eprintln!("模型预热: {error}");
            let _ = app.emit("warmup-failed", serde_json::json!({ "message": error }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        should_warmup, should_warmup_for_launch, should_warmup_for_user_image, WarmupTrigger,
    };

    #[test]
    fn user_image_warmup_ignores_launch_preload_setting() {
        assert!(should_warmup(WarmupTrigger::UserImage, false, true));
        assert!(!should_warmup(WarmupTrigger::UserImage, false, false));
    }

    #[test]
    fn launch_warmup_respects_preload_setting() {
        assert!(!should_warmup(WarmupTrigger::Launch, false, true));
        assert!(should_warmup(WarmupTrigger::Launch, true, true));
        assert!(!should_warmup(WarmupTrigger::Launch, true, false));
    }

    #[test]
    fn warmup_entrypoints_keep_their_trigger_policies() {
        assert!(!should_warmup_for_launch(false, true));
        assert!(should_warmup_for_user_image(false, true));
    }
}
