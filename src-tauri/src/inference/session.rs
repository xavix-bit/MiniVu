use super::context::ActiveInferenceContext;
use super::GenerationFlag;
use super::{
    build_chat_messages, build_standalone_follow_up_prompt, emit_chunk, sidecar_health_ok,
    sidecar_request_model, stream_from_sidecar, trim_history, wait_for_sidecar_ready,
    HistoryMessage,
};
use crate::settings::InferenceBackend;
use crate::sidecar::{lock_sidecar, SidecarState};
use std::sync::atomic::Ordering;
use tauri::AppHandle;

pub struct AskImageRequest {
    pub image_data_url: String,
    pub ocr_text: String,
    pub prompt: String,
    pub history: Vec<HistoryMessage>,
}

fn model_not_ready_message(backend: InferenceBackend, app: &AppHandle) -> String {
    use crate::inference_backend::mlx_runtime_ready;
    match backend {
        InferenceBackend::Mlx => {
            if mlx_runtime_ready(app) {
                "模型还未下载。".to_string()
            } else {
                "MLX 未安装。".to_string()
            }
        }
        InferenceBackend::Llama => "模型还未下载。".to_string(),
    }
}

/// 确保侧车已启动并就绪，返回 (port, 是否可跳过加载等待)。
async fn ensure_sidecar_ready(
    app: &AppHandle,
    sidecar: &SidecarState,
    backend: InferenceBackend,
    cancel_flag: &GenerationFlag,
) -> Result<(u16, bool), String> {
    {
        let mut guard = lock_sidecar(sidecar);
        guard.touch();
        guard.ensure_started(app)?;
    }

    let port = lock_sidecar(sidecar).port;
    let sidecar_warm = lock_sidecar(sidecar).is_service_ready();
    let skip_load_wait = sidecar_warm && sidecar_health_ok(port, backend).await;

    if skip_load_wait {
        return Ok((port, true));
    }

    if sidecar_warm {
        lock_sidecar(sidecar).set_service_ready(false);
    }

    let sidecar_state = sidecar.clone();
    if let Err(error) =
        wait_for_sidecar_ready(app, port, backend, cancel_flag, &sidecar_state).await
    {
        if cancel_flag.load(Ordering::SeqCst) {
            emit_chunk(app, "", true)?;
            return Ok((port, false));
        }
        return Err(error);
    }

    lock_sidecar(sidecar).set_service_ready(true);
    Ok((port, sidecar_warm))
}

pub async fn run_ask_image(
    app: &AppHandle,
    sidecar: &SidecarState,
    cancel_flag: &GenerationFlag,
    request: AskImageRequest,
) -> Result<(), String> {
    let ctx = ActiveInferenceContext::load(app)?;
    if !ctx.models_ready {
        return Err(model_not_ready_message(ctx.backend, app));
    }

    let (port, sidecar_warm_for_infer) =
        match ensure_sidecar_ready(app, sidecar, ctx.backend, cancel_flag).await {
            Ok((port, warm)) => (port, warm),
            Err(error) => return Err(error),
        };

    // 取消发生在加载等待阶段时 ensure_sidecar_ready 已 emit done chunk。
    if cancel_flag.load(Ordering::SeqCst) && !sidecar_warm_for_infer {
        return Ok(());
    }

    let trimmed_history = trim_history(&request.history);
    let messages = build_chat_messages(
        &trimmed_history,
        &request.image_data_url,
        &request.ocr_text,
        &request.prompt,
    );
    let request_model = sidecar_request_model(ctx.backend, &ctx.mlx);

    let infer_result = stream_from_sidecar(
        app,
        port,
        &request_model,
        &messages,
        cancel_flag,
        sidecar_warm_for_infer,
    )
    .await;

    if let Err(error) = infer_result {
        if cancel_flag.load(Ordering::SeqCst) {
            emit_chunk(app, "", true)?;
            return Ok(());
        }

        if !request.history.is_empty() {
            let fallback_prompt = build_standalone_follow_up_prompt(
                &trimmed_history,
                &request.ocr_text,
                &request.prompt,
            );
            let fallback_messages =
                build_chat_messages(&[], &request.image_data_url, "", &fallback_prompt);
            if stream_from_sidecar(
                app,
                port,
                &request_model,
                &fallback_messages,
                cancel_flag,
                sidecar_warm_for_infer,
            )
            .await
            .is_ok()
            {
                return Ok(());
            }
        }

        let mut guard = lock_sidecar(sidecar);
        if !guard.is_running() {
            guard.set_service_ready(false);
        }
        return Err(error);
    }

    Ok(())
}
