use crate::environment::is_environment_ready;
use crate::settings::load_settings;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

const QUICK_PANEL_LABEL: &str = "quick-panel";
const MAIN_WINDOW_LABEL: &str = "main";
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 620.0;
const PET_SIZE: f64 = 56.0;
const LAUNCHER_WIDTH: f64 = 252.0;
const LAUNCHER_HEIGHT: f64 = 64.0;
const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 800.0;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuickPanelMode {
    Expanded,
    Launcher,
    Pet,
    Hidden,
}

pub fn current_quick_panel_mode(app: &AppHandle) -> QuickPanelMode {
    read_panel_state(app, |state| state.mode)
}

pub struct QuickPanelState {
    pub expanded_size: LogicalSize<f64>,
    pub mode: QuickPanelMode,
}

impl Default for QuickPanelState {
    fn default() -> Self {
        Self {
            expanded_size: LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT),
            mode: QuickPanelMode::Hidden,
        }
    }
}

fn read_panel_state<R>(app: &AppHandle, read: impl FnOnce(&QuickPanelState) -> R) -> R {
    let state = app.state::<Mutex<QuickPanelState>>();
    let guard = state.lock().expect("窗口状态锁失败");
    read(&guard)
}

fn with_panel_state<R>(
    app: &AppHandle,
    update: impl FnOnce(&mut QuickPanelState) -> Result<R, String>,
) -> Result<R, String> {
    let state = app.state::<Mutex<QuickPanelState>>();
    let mut guard = state.lock().map_err(|_| "窗口状态锁失败".to_string())?;
    update(&mut guard)
}

fn emit_panel_mode(app: &AppHandle, mode: QuickPanelMode) -> Result<(), String> {
    app.emit_to(QUICK_PANEL_LABEL, "quick-panel-mode", mode)
        .map_err(|error| error.to_string())
}

fn remember_expanded_size(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    if width > PET_SIZE + 8.0 && height > PET_SIZE + 8.0 {
        with_panel_state(app, |state| {
            state.expanded_size = LogicalSize::new(width, height);
            Ok(())
        })?;
    }
    Ok(())
}

fn present_window(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    activate_app(app)?;
    Ok(())
}

fn present_window_passive(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_always_on_top(true);
    Ok(())
}

pub fn expand_quick_panel(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    let expanded_size = read_panel_state(app, |state| state.expanded_size);

    window
        .set_size(expanded_size)
        .map_err(|error| error.to_string())?;
    let _ = window.set_resizable(true);
    let _ = window.set_always_on_top(true);
    present_window(&window, app)?;

    with_panel_state(app, |state| {
        state.mode = QuickPanelMode::Expanded;
        Ok(())
    })?;
    emit_panel_mode(app, QuickPanelMode::Expanded)
}

pub fn collapse_quick_panel_to_pet(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    remember_expanded_size(app, &window)?;
    window
        .set_size(LogicalSize::new(PET_SIZE, PET_SIZE))
        .map_err(|error| error.to_string())?;
    let _ = window.set_resizable(false);
    let _ = window.set_always_on_top(true);
    present_window_passive(&window)?;

    with_panel_state(app, |state| {
        state.mode = QuickPanelMode::Pet;
        Ok(())
    })?;
    emit_panel_mode(app, QuickPanelMode::Pet)
}

pub fn show_quick_launcher(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    let scale = window.scale_factor().unwrap_or(1.0);
    let current = window.outer_position().ok();
    let (screen_w, _) = primary_screen_size()?;
    let mut x = current
        .map(|position| position.x as f64 / scale)
        .unwrap_or(20.0);
    let y = current
        .map(|position| position.y as f64 / scale)
        .unwrap_or(20.0);
    if x + LAUNCHER_WIDTH > screen_w as f64 {
        x = (x - (LAUNCHER_WIDTH - PET_SIZE)).max(0.0);
    }

    window
        .set_size(LogicalSize::new(LAUNCHER_WIDTH, LAUNCHER_HEIGHT))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    let _ = window.set_resizable(false);
    present_window_passive(&window)?;

    with_panel_state(app, |state| {
        state.mode = QuickPanelMode::Launcher;
        Ok(())
    })?;
    emit_panel_mode(app, QuickPanelMode::Launcher)
}

pub fn show_quick_panel_near_cursor(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    let mode = read_panel_state(app, |state| state.mode);

    if mode == QuickPanelMode::Pet {
        expand_quick_panel(app)?;
        return Ok(());
    }

    let expanded_size = read_panel_state(app, |state| state.expanded_size);

    if !window.is_visible().unwrap_or(false) || mode == QuickPanelMode::Hidden {
        let (cursor_x, cursor_y) = cursor_position()?;
        let (screen_w, screen_h) = primary_screen_size()?;
        let panel_w = expanded_size.width;
        let panel_h = expanded_size.height;

        let mut x = cursor_x as f64 + 16.0;
        let mut y = cursor_y as f64 + 16.0;

        if x + panel_w > screen_w as f64 {
            x = (screen_w as f64 - panel_w - 16.0).max(0.0);
        }
        if y + panel_h > screen_h as f64 {
            y = (screen_h as f64 - panel_h - 16.0).max(0.0);
        }

        window
            .set_size(expanded_size)
            .map_err(|error| error.to_string())?;
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;

        with_panel_state(app, |state| {
            state.mode = QuickPanelMode::Expanded;
            Ok(())
        })?;
        emit_panel_mode(app, QuickPanelMode::Expanded)?;
    }

    let _ = window.set_always_on_top(true);
    present_window(&window, app)
}

pub fn show_entry_window(app: &AppHandle) -> Result<(), String> {
    show_main_window(app)
}

pub fn show_quick_panel_via_shortcut(app: &AppHandle) -> Result<(), String> {
    let settings = load_settings(app)?;
    let environment_ready = is_environment_ready(app).unwrap_or(false);

    if !settings.onboarding_complete || !environment_ready {
        show_main_window(app)
    } else {
        show_quick_panel_near_cursor(app)
    }
}

pub fn request_capture_via_shortcut(app: &AppHandle) -> Result<(), String> {
    let settings = load_settings(app)?;
    let environment_ready = is_environment_ready(app).unwrap_or(false);
    if !settings.onboarding_complete || !environment_ready {
        return show_main_window(app);
    }
    app.emit_to(QUICK_PANEL_LABEL, "capture-requested", ())
        .map_err(|error| error.to_string())
}

pub fn show_quick_panel_from_main(app: &AppHandle) -> Result<(), String> {
    show_quick_panel_via_shortcut(app)
}

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
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    present_window(&window, app)
}

fn activate_app(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        app.set_activation_policy(ActivationPolicy::Regular)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn close_quick_panel(app: &AppHandle) -> Result<(), String> {
    collapse_quick_panel_to_pet(app)
}

pub fn hide_quick_panel(app: &AppHandle) -> Result<(), String> {
    let _ = app.emit_to(QUICK_PANEL_LABEL, "quick-panel-closing", ());
    hide_quick_panel_silent(app)
}

pub fn hide_quick_panel_silent(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) else {
        return Ok(());
    };
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|error| error.to_string())?;
    }
    let _ = with_panel_state(app, |state| {
        state.mode = QuickPanelMode::Hidden;
        Ok(())
    });
    let _ = emit_panel_mode(app, QuickPanelMode::Hidden);
    Ok(())
}

pub fn conceal_quick_panel_for_capture(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) else {
        return Ok(());
    };
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn restore_quick_panel_mode(app: &AppHandle, mode: QuickPanelMode) -> Result<(), String> {
    match mode {
        QuickPanelMode::Expanded => expand_quick_panel(app),
        QuickPanelMode::Launcher => show_quick_launcher(app),
        QuickPanelMode::Pet => collapse_quick_panel_to_pet(app),
        QuickPanelMode::Hidden => hide_quick_panel_silent(app),
    }
}

pub fn restore_quick_panel(app: &AppHandle) -> Result<(), String> {
    expand_quick_panel(app)
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
    Ok((
        bounds.size.width.round() as i32,
        bounds.size.height.round() as i32,
    ))
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

#[tauri::command]
pub fn hide_quick_panel_command(app: AppHandle) -> Result<(), String> {
    hide_quick_panel(&app)
}

#[tauri::command]
pub fn expand_quick_panel_command(app: AppHandle) -> Result<(), String> {
    expand_quick_panel(&app)
}

#[tauri::command]
pub fn show_quick_launcher_command(app: AppHandle) -> Result<(), String> {
    show_quick_launcher(&app)
}

#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
