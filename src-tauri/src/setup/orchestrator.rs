use crate::environment::models_ready_for_backend;
use crate::inference_backend::{mlx_runtime_ready, resolve_active_backend};
use crate::runtime_installer::{
    emit_setup_progress, install_llama_runtime, install_mlx_runtime, resolve_llama_server,
};
use crate::settings::{load_settings, update_settings, InferenceBackend};
use crate::shortcut::register_shortcut;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupEnvironmentResult {
    pub runtime_ready: bool,
    pub model_ready: bool,
    pub shortcut: String,
}

fn begin_setup_snapshot<T>(
    lifecycle: &crate::model_lifecycle::ModelLifecycleState,
    load: impl FnOnce() -> Result<T, String>,
) -> Result<(crate::model_lifecycle::ModelMutationLease, T), String> {
    let lease = lifecycle.begin_mutation()?;
    let snapshot = load()?;
    Ok((lease, snapshot))
}

pub async fn setup_environment(app: AppHandle) -> Result<SetupEnvironmentResult, String> {
    use crate::commands::get_device_info;
    use crate::model_cache::ModelCache;
    use crate::model_download::{download_mlx_model_inner, DownloadTaskState};
    use crate::model_lifecycle::{install_gguf_model_with_lease, ModelLifecycleState};
    use crate::sidecar::SidecarState;

    let lifecycle = app.state::<ModelLifecycleState>();
    let (_setup_lease, settings) = begin_setup_snapshot(lifecycle.inner(), || load_settings(&app))?;

    emit_setup_progress(&app, "device", "running", "正在检测本机配置…", 0);
    let device = get_device_info();
    let device_message = format!(
        "{}（{} · {:.1} GB）",
        device.message, device.platform, device.memory_gb
    );
    emit_setup_progress(&app, "device", "done", &device_message, 100);

    let backend = settings.inference_backend;

    match backend {
        InferenceBackend::Mlx => {
            install_mlx_runtime(&app).await?;
        }
        InferenceBackend::Llama => {
            install_llama_runtime(&app).await?;
        }
    }

    let cache = ModelCache::new(&app)?;
    let paths = cache.resolve(settings.gguf_model_variant);
    let mlx = cache.resolve_mlx(Some(settings.mlx_model_id.as_str()));

    if backend == InferenceBackend::Llama && !paths.is_complete() {
        emit_setup_progress(
            &app,
            "model",
            "running",
            "正在下载主模型（顺序下载，不占并行带宽）…",
            0,
        );
        emit_setup_progress(&app, "mmproj", "waiting", "等待主模型完成后开始…", 0);
        let download_state = app.state::<DownloadTaskState>();
        let sidecar = app.state::<SidecarState>();
        install_gguf_model_with_lease(
            app.clone(),
            sidecar.inner(),
            download_state.inner(),
            settings.clone(),
            settings.gguf_model_variant,
            false,
        )
        .await?;
        emit_setup_progress(&app, "mmproj", "done", "视觉投影已下载", 100);
        emit_setup_progress(&app, "model", "done", "主模型已下载", 100);
    } else if backend == InferenceBackend::Mlx {
        if !mlx.is_ready() {
            emit_setup_progress(&app, "model", "running", "正在下载 MLX 模型权重…", 0);
            emit_setup_progress(&app, "mmproj", "waiting", "MLX 模式无需 mmproj", 0);
            download_mlx_model_inner(app.clone(), None).await?;
        } else {
            emit_setup_progress(&app, "model", "done", "MLX 模型已下载", 100);
            emit_setup_progress(&app, "mmproj", "done", "MLX 模式无需 mmproj", 100);
        }
    } else {
        emit_setup_progress(&app, "mmproj", "done", "视觉投影已下载", 100);
        emit_setup_progress(&app, "model", "done", "主模型已下载", 100);
    }

    let settings = update_settings(&app, |settings| {
        if settings.shortcut.trim().is_empty() {
            settings.shortcut = "Control+Option+Space".to_string();
        }
    })?;
    register_shortcut(&app, &settings.shortcut)?;
    emit_setup_progress(
        &app,
        "shortcut",
        "done",
        &format!("快捷键已设置为 {}", settings.shortcut),
        100,
    );

    let cache = ModelCache::new(&app)?;
    let paths = cache.resolve(settings.gguf_model_variant);
    let mlx = cache.resolve_mlx(Some(settings.mlx_model_id.as_str()));
    let active = resolve_active_backend(settings.inference_backend, &app).ok();

    emit_setup_progress(&app, "done", "done", "环境配置完成", 100);

    let runtime_ready = match settings.inference_backend {
        InferenceBackend::Mlx => mlx_runtime_ready(&app),
        InferenceBackend::Llama => resolve_llama_server(&app).is_some(),
    };

    Ok(SetupEnvironmentResult {
        runtime_ready,
        model_ready: active
            .map(|value| {
                if value == InferenceBackend::Mlx {
                    mlx_runtime_ready(&app) && mlx.is_ready()
                } else {
                    models_ready_for_backend(value, &paths, &mlx)
                }
            })
            .unwrap_or(false),
        shortcut: settings.shortcut,
    })
}

#[cfg(test)]
mod tests {
    use super::begin_setup_snapshot;
    use crate::model_lifecycle::ModelLifecycleState;
    use crate::settings::InferenceBackend;
    use std::cell::Cell;

    #[test]
    fn concurrent_setup_is_rejected_before_reading_settings_or_starting_work() {
        let lifecycle = ModelLifecycleState::default();
        let (_lease, backend) =
            begin_setup_snapshot(&lifecycle, || Ok(InferenceBackend::Llama)).unwrap();
        let work_started = Cell::new(false);

        let second = begin_setup_snapshot(&lifecycle, || {
            work_started.set(true);
            Ok(InferenceBackend::Mlx)
        });

        assert_eq!(backend, InferenceBackend::Llama);
        assert!(second.is_err());
        assert!(!work_started.get());
    }

    #[test]
    fn setup_reads_backend_after_lock_and_blocks_settings_change_until_complete() {
        let lifecycle = ModelLifecycleState::default();
        let configured_backend = Cell::new(InferenceBackend::Llama);

        {
            let _settings_lease = lifecycle.begin_mutation().unwrap();
            configured_backend.set(InferenceBackend::Mlx);
        }
        let (setup_lease, snapshot) =
            begin_setup_snapshot(&lifecycle, || Ok(configured_backend.get())).unwrap();

        assert_eq!(snapshot, InferenceBackend::Mlx);
        assert!(lifecycle.begin_mutation().is_err());
        assert_eq!(configured_backend.get(), InferenceBackend::Mlx);

        drop(setup_lease);
        let _settings_lease = lifecycle.begin_mutation().unwrap();
        configured_backend.set(InferenceBackend::Llama);
        assert_eq!(configured_backend.get(), InferenceBackend::Llama);
    }
}
