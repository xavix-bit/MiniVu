mod commands;
mod download_http;
mod environment;
mod export;
mod inference;
mod inference_backend;
mod inference_profile;
mod mirror_benchmark;
mod model_cache;
mod model_download;
mod model_sidecar;
mod ocr_macos;
mod platform_caps;
mod privacy;
mod runtime_installer;
mod screenshot;
mod settings;
mod setup;
mod shortcut;
mod sidecar;
mod tray;
mod window;

use model_sidecar::{init_generation_flag, init_sidecar_state, spawn_idle_unloader, spawn_model_warmup};
use sidecar::lock_sidecar;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(init_sidecar_state())
        .manage(init_generation_flag())
        .setup(|app| {
            tray::create_tray(app.handle())?;
            window::show_entry_window(app.handle())?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 先让主窗口渲染，再注册快捷键与可选预热，避免启动时 IPC 拥塞。
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if let Err(error) = shortcut::register_default_shortcut(&handle) {
                    eprintln!("快捷键注册失败（可在设置中修改）: {error}");
                }
                spawn_idle_unloader(handle.clone());
                spawn_model_warmup(handle);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            privacy::app_privacy_mode,
            ocr_macos::recognize_text_from_image_data_url,
            commands::load_app_settings,
            commands::save_app_settings,
            commands::get_device_info,
            export::export_session,
            export::app_data_dir,
            model_sidecar::get_model_status,
            model_sidecar::get_environment_status,
            model_sidecar::is_app_environment_ready,
            model_download::download_model,
            model_download::download_mlx_model,
            mirror_benchmark::benchmark_download_mirrors,
            model_sidecar::ask_image,
            model_sidecar::cancel_generation,
            model_sidecar::unload_model_if_idle,
            setup::setup_environment,
            runtime_installer::install_llama_runtime_command,
            runtime_installer::install_mlx_runtime_command,
            window::show_entry,
            window::show_quick_panel,
            window::show_main,
            window::close_quick_panel_command,
            screenshot::capture_screen_region,
        ])
        .build(tauri::generate_context!())
        .expect("error while running MiniVu")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                lock_sidecar(app_handle.state::<crate::sidecar::SidecarState>().inner()).stop();
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let _ = window::reopen_from_dock(app_handle);
            }
        });
}
