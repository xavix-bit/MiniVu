use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionRequest {
    pub directory: String,
    pub markdown: String,
    pub image_data_url: String,
    pub image_filename: String,
}

#[tauri::command]
pub fn export_session(request: ExportSessionRequest) -> Result<String, String> {
    let dir = PathBuf::from(&request.directory);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let image_path = dir.join(&request.image_filename);
    write_image_data_url(&request.image_data_url, &image_path)?;

    let markdown_path = dir.join("session.md");
    fs::write(&markdown_path, request.markdown).map_err(|e| e.to_string())?;

    Ok(markdown_path.to_string_lossy().to_string())
}

fn write_image_data_url(data_url: &str, path: &PathBuf) -> Result<(), String> {
    let payload = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    let bytes = STANDARD.decode(payload).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}
