use crate::settings::load_settings;
use crate::window::show_entry_window;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn to_tauri_shortcut(shortcut: &str) -> String {
    shortcut
        .replace("Control", "Ctrl")
        .replace("Option", "Alt")
        .replace("Command", "Cmd")
}

pub fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let _ = app.global_shortcut().unregister_all();

    let parsed = to_tauri_shortcut(shortcut)
        .parse::<Shortcut>()
        .map_err(|e| format!("快捷键格式无效: {e}"))?;

    app.global_shortcut()
        .on_shortcut(parsed, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = show_entry_window(app);
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn register_default_shortcut(app: &AppHandle) -> Result<(), String> {
    let settings = load_settings(app)?;
    register_shortcut(app, &settings.shortcut)
}
