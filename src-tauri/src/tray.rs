use crate::window::{show_main_window, show_quick_panel_from_main};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let quick_panel = MenuItem::with_id(app, "quick_panel", "截图提问", true, None::<&str>)?;
    let open_main = MenuItem::with_id(app, "open_main", "打开主窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MiniVu", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&quick_panel, &open_main, &settings, &separator, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id("minivu-tray").tooltip("MiniVu · 本地截图问答");
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quick_panel" => {
                let _ = show_quick_panel_from_main(app);
            }
            "open_main" | "settings" => {
                let _ = show_main_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
