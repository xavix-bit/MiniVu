pub(crate) mod gguf;
mod mlx;
mod progress;
mod task;

pub use task::{DownloadTaskSnapshot, DownloadTaskState};

use crate::model_lifecycle::ModelLifecycleState;
use crate::settings::GgufModelVariant;
use tauri::State;

#[tauri::command]
pub async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, DownloadTaskState>,
    lifecycle: State<'_, ModelLifecycleState>,
    force: Option<bool>,
    variant: Option<GgufModelVariant>,
) -> Result<String, String> {
    let _mutation = lifecycle.begin_mutation()?;
    gguf::download_model(app, state.inner(), force, variant).await
}

#[tauri::command]
pub fn get_model_download_status(
    state: State<'_, DownloadTaskState>,
) -> Option<DownloadTaskSnapshot> {
    state.snapshot()
}

#[tauri::command]
pub fn cancel_model_download(
    state: State<'_, DownloadTaskState>,
    task_id: u64,
) -> Result<(), String> {
    state.cancel(task_id)
}

#[tauri::command]
pub async fn download_mlx_model(
    app: tauri::AppHandle,
    lifecycle: State<'_, ModelLifecycleState>,
    force: Option<bool>,
) -> Result<String, String> {
    let _mutation = lifecycle.begin_mutation()?;
    download_mlx_model_inner(app, force).await
}

pub(crate) async fn download_mlx_model_inner(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<String, String> {
    mlx::download_mlx_model(app, force).await
}
