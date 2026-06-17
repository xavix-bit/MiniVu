use crate::environment::is_environment_ready;
use crate::settings::load_settings;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

const QUICK_PANEL_LABEL: &str = "quick-panel";
const MAIN_WINDOW_LABEL: &str = "main";
const PANEL_WIDTH: f64 = 480.0;
const PANEL_HEIGHT: f64 = 680.0;
const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 800.0;

/// 将窗口带到前台：macOS 最小化后仅 `show()` 无效，必须先 `unminimize()`。
fn present_window(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        window.unminimize().map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    activate_app(app)?;
    Ok(())
}

pub fn show_quick_panel_near_cursor(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let panel_w = (size.width as f64 / scale).max(PANEL_WIDTH);
    let panel_h = (size.height as f64 / scale).max(PANEL_HEIGHT);

    // 仅在面板从隐藏状态打开时定位到光标旁，保留用户调整过的尺寸。
    if !window.is_visible().unwrap_or(false) {
        let (cursor_x, cursor_y) = cursor_position()?;
        let (screen_w, screen_h) = primary_screen_size()?;

        let mut x = cursor_x + 16;
        let mut y = cursor_y + 16;

        if x as f64 + panel_w > screen_w as f64 {
            x = (screen_w as f64 - panel_w - 16.0).max(0.0) as i32;
        }
        if y as f64 + panel_h > screen_h as f64 {
            y = (screen_h as f64 - panel_h - 16.0).max(0.0) as i32;
        }

        window
            .set_position(LogicalPosition::new(x as f64, y as f64))
            .map_err(|e| e.to_string())?;
    }

    let _ = window.set_always_on_top(true);
    present_window(&window, app)?;
    Ok(())
}

/// 应用启动、Dock 点击、托盘点击时打开主窗口。
pub fn show_entry_window(app: &AppHandle) -> Result<(), String> {
    show_main_window(app)
}

/// 全局快捷键：环境就绪时打开识图小面板，否则打开主窗口引导配置。
pub fn show_quick_panel_via_shortcut(app: &AppHandle) -> Result<(), String> {
    let settings = load_settings(app)?;
    let environment_ready = is_environment_ready(app).unwrap_or(false);

    if !settings.onboarding_complete || !environment_ready {
        show_main_window(app)
    } else {
        show_quick_panel_near_cursor(app)
    }
}

/// 从主窗口主动打开识图小面板（首页按钮等）。
pub fn show_quick_panel_from_main(app: &AppHandle) -> Result<(), String> {
    show_quick_panel_via_shortcut(app)
}

/// 点击 Dock 图标时始终打开主窗口。
pub fn reopen_from_dock(app: &AppHandle) -> Result<(), String> {
    show_main_window(app)
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let _ = hide_quick_panel_silent(app);

    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let (screen_w, screen_h) = primary_screen_size()?;
    let x = ((screen_w as f64 - MAIN_WIDTH) / 2.0).max(0.0);
    let y = ((screen_h as f64 - MAIN_HEIGHT) / 2.0).max(0.0);

    window
        .set_size(LogicalSize::new(MAIN_WIDTH, MAIN_HEIGHT))
        .map_err(|e| e.to_string())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    present_window(&window, app)
}

fn activate_app(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        app.set_activation_policy(ActivationPolicy::Regular)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn close_quick_panel(app: &AppHandle) -> Result<(), String> {
    let _ = app.emit_to(QUICK_PANEL_LABEL, "quick-panel-closing", ());
    hide_quick_panel_silent(app)
}

/// 仅隐藏识图面板，不重置前端会话（截图等场景使用）。
pub fn hide_quick_panel_silent(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) else {
        return Ok(());
    };
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 截图等流程结束后恢复识图面板。
pub fn restore_quick_panel(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;
    let _ = window.set_always_on_top(true);
    present_window(&window, app)
}

#[cfg(target_os = "macos")]
fn cursor_position() -> Result<(i32, i32), String> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "无法读取鼠标位置".to_string())?;
    let event = CGEvent::new(source).map_err(|_| "无法读取鼠标位置".to_string())?;
    let point = event.location();
    let screen_h = primary_screen_size()?.1 as f64;
    let x = point.x.round() as i32;
    let y = (screen_h - point.y).round() as i32;
    Ok((x, y))
}

#[cfg(not(target_os = "macos"))]
fn cursor_position() -> Result<(i32, i32), String> {
    Ok((200, 200))
}

#[cfg(target_os = "macos")]
fn primary_screen_size() -> Result<(i32, i32), String> {
    use core_graphics::display::CGDisplay;
    let bounds = CGDisplay::main().bounds();
    Ok((bounds.size.width.round() as i32, bounds.size.height.round() as i32))
}

#[cfg(not(target_os = "macos"))]
fn primary_screen_size() -> Result<(i32, i32), String> {
    Ok((1920, 1080))
}

#[tauri::command]
pub fn show_entry(app: AppHandle) -> Result<(), String> {
    show_entry_window(&app)
}

#[tauri::command]
pub fn show_quick_panel(app: AppHandle) -> Result<(), String> {
    show_quick_panel_from_main(&app)
}

#[tauri::command]
pub fn show_main(app: AppHandle) -> Result<(), String> {
    show_main_window(&app)
}

#[tauri::command]
pub fn close_quick_panel_command(app: AppHandle) -> Result<(), String> {
    close_quick_panel(&app)
}
