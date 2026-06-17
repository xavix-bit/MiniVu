mod gguf;
mod mlx;
mod progress;

#[tauri::command]
pub async fn download_model(app: tauri::AppHandle, force: Option<bool>) -> Result<String, String> {
    gguf::download_model(app, force).await
}

#[tauri::command]
pub async fn download_mlx_model(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<String, String> {
    mlx::download_mlx_model(app, force).await
}
