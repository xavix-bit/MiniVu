use crate::settings::{load_settings, FloatingAssistantPosition};
use crate::window_geometry::{
    clamp_position_to_bounds, default_floating_position, expanded_floating_position,
    fit_window_size_to_bounds, launcher_floating_position, monitor_bounds_containing_position,
    LogicalScreenBounds,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition,
    WebviewWindow, Window, WindowEvent,
};

const QUICK_PANEL_LABEL: &str = "quick-panel";
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 620.0;
const PET_SIZE: f64 = 56.0;
const LAUNCHER_WIDTH: f64 = 252.0;
const LAUNCHER_HEIGHT: f64 = 64.0;
const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 800.0;
const FLOATING_INSET: f64 = 16.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainCloseTarget {
    Pet,
    Hidden,
}

fn main_close_target(onboarding_complete: bool, floating_enabled: bool) -> MainCloseTarget {
    if onboarding_complete && floating_enabled {
        MainCloseTarget::Pet
    } else {
        MainCloseTarget::Hidden
    }
}

fn quick_panel_close_target(floating_enabled: bool) -> MainCloseTarget {
    if floating_enabled {
        MainCloseTarget::Pet
    } else {
        MainCloseTarget::Hidden
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuickPanelMode {
    Expanded,
    Launcher,
    Pet,
    Hidden,
}

fn should_remember_expanded_size(mode: QuickPanelMode) -> bool {
    mode == QuickPanelMode::Expanded
}

pub fn current_quick_panel_mode(app: &AppHandle) -> QuickPanelMode {
    read_panel_state(app, |state| state.mode).unwrap_or(QuickPanelMode::Hidden)
}

#[tauri::command]
pub fn get_quick_panel_mode(app: AppHandle) -> QuickPanelMode {
    current_quick_panel_mode(&app)
}

pub struct QuickPanelState {
    pub expanded_size: LogicalSize<f64>,
    pub mode: QuickPanelMode,
    pub capture_pending: bool,
    pub anchor_position: Option<FloatingAssistantPosition>,
}

impl Default for QuickPanelState {
    fn default() -> Self {
        Self {
            expanded_size: LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT),
            mode: QuickPanelMode::Hidden,
            capture_pending: false,
            anchor_position: None,
        }
    }
}

fn read_panel_state<R>(
    app: &AppHandle,
    read: impl FnOnce(&QuickPanelState) -> R,
) -> Result<R, String> {
    let state = app.state::<Mutex<QuickPanelState>>();
    let guard = state.lock().map_err(|_| "窗口状态锁失败".to_string())?;
    Ok(read(&guard))
}

fn with_panel_state<R>(
    app: &AppHandle,
    update: impl FnOnce(&mut QuickPanelState) -> Result<R, String>,
) -> Result<R, String> {
    let state = app.state::<Mutex<QuickPanelState>>();
    let mut guard = state.lock().map_err(|_| "窗口状态锁失败".to_string())?;
    update(&mut guard)
}

#[derive(Clone, Copy)]
struct LogicalMonitorBounds {
    origin: LogicalPosition<f64>,
    size: LogicalSize<f64>,
    scale_factor: f64,
}

impl LogicalMonitorBounds {
    fn screen(self) -> LogicalScreenBounds {
        LogicalScreenBounds {
            x: self.origin.x,
            y: self.origin.y,
            width: self.size.width,
            height: self.size.height,
        }
    }
}

fn logical_monitor_bounds_from_monitor(monitor: &Monitor) -> Result<LogicalMonitorBounds, String> {
    let scale_factor = monitor.scale_factor();
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("invalid monitor scale factor".to_string());
    }

    Ok(LogicalMonitorBounds {
        origin: monitor.position().to_logical::<f64>(scale_factor),
        size: monitor.size().to_logical::<f64>(scale_factor),
        scale_factor,
    })
}

fn logical_monitor_bounds(window: &WebviewWindow) -> Result<LogicalMonitorBounds, String> {
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => monitor,
        Ok(None) | Err(_) => window
            .primary_monitor()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "monitor not found".to_string())?,
    };
    logical_monitor_bounds_from_monitor(&monitor)
}

fn logical_monitor_containing_position(
    window: &WebviewWindow,
    position: FloatingAssistantPosition,
) -> Result<Option<LogicalMonitorBounds>, String> {
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?
        .iter()
        .map(logical_monitor_bounds_from_monitor)
        .collect::<Result<Vec<_>, _>>()?;
    let screens = monitors
        .iter()
        .map(|monitor| monitor.screen())
        .collect::<Vec<_>>();
    let selected = monitor_bounds_containing_position(position, &screens);
    Ok(selected.and_then(|selected| {
        monitors
            .into_iter()
            .find(|monitor| monitor.screen() == selected)
    }))
}

fn clamp_position_to_monitor(
    position: FloatingAssistantPosition,
    monitor: LogicalMonitorBounds,
    window_width: f64,
    window_height: f64,
) -> FloatingAssistantPosition {
    clamp_position_to_bounds(
        position,
        monitor.screen(),
        window_width,
        window_height,
        FLOATING_INSET,
    )
}

fn default_position_for_monitor(monitor: LogicalMonitorBounds) -> FloatingAssistantPosition {
    let local = default_floating_position(
        monitor.size.width,
        monitor.size.height,
        PET_SIZE,
        FLOATING_INSET,
    );
    FloatingAssistantPosition {
        x: local.x + monitor.origin.x,
        y: local.y + monitor.origin.y,
    }
}

fn resolve_pet_anchor(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(FloatingAssistantPosition, LogicalMonitorBounds), String> {
    let in_memory = read_panel_state(app, |state| state.anchor_position)?;
    let position = match in_memory {
        Some(position) => Some(position),
        None => load_settings(app)?.floating_assistant_position,
    };
    match position {
        Some(position) => {
            let monitor = match logical_monitor_containing_position(window, position)? {
                Some(monitor) => monitor,
                None => logical_monitor_bounds(window)?,
            };
            Ok((
                clamp_position_to_monitor(position, monitor, PET_SIZE, PET_SIZE),
                monitor,
            ))
        }
        None => {
            let monitor = logical_monitor_bounds(window)?;
            Ok((default_position_for_monitor(monitor), monitor))
        }
    }
}

fn logical_position(
    position: PhysicalPosition<i32>,
    monitor: LogicalMonitorBounds,
) -> FloatingAssistantPosition {
    let position = position.to_logical::<f64>(monitor.scale_factor);
    FloatingAssistantPosition {
        x: position.x,
        y: position.y,
    }
}

fn record_pet_anchor(
    app: &AppHandle,
    window: &WebviewWindow,
    position: PhysicalPosition<i32>,
) -> Result<(), String> {
    if read_panel_state(app, |state| state.mode)? != QuickPanelMode::Pet {
        return Ok(());
    }
    let monitor = logical_monitor_bounds(window)?;
    let position = logical_position(position, monitor);
    with_panel_state(app, |state| {
        if state.mode == QuickPanelMode::Pet {
            state.anchor_position = Some(position);
        }
        Ok(())
    })
}

fn remember_pet_anchor(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if read_panel_state(app, |state| state.mode)? != QuickPanelMode::Pet {
        return Ok(());
    }
    let position = window.outer_position().map_err(|error| error.to_string())?;
    record_pet_anchor(app, window, position)
}

pub(crate) fn latest_anchor_position(
    app: &AppHandle,
) -> Result<Option<FloatingAssistantPosition>, String> {
    read_panel_state(app, |state| state.anchor_position)
}

fn emit_panel_mode(app: &AppHandle, mode: QuickPanelMode) -> Result<(), String> {
    app.emit_to(QUICK_PANEL_LABEL, "quick-panel-mode", mode)
        .map_err(|error| error.to_string())
}

fn remember_expanded_size(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if !should_remember_expanded_size(read_panel_state(app, |state| state.mode)?) {
        return Ok(());
    }
    let scale = logical_monitor_bounds(window)?.scale_factor;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    if width > PET_SIZE + 8.0 && height > PET_SIZE + 8.0 {
        with_panel_state(app, |state| {
            if should_remember_expanded_size(state.mode) {
                state.expanded_size = LogicalSize::new(width, height);
            }
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

    remember_pet_anchor(app, &window)?;
    let requested_size = read_panel_state(app, |state| state.expanded_size)?;
    let source_mode = read_panel_state(app, |state| state.mode)?;
    let (expanded_size, expanded_position) =
        if matches!(source_mode, QuickPanelMode::Pet | QuickPanelMode::Launcher) {
            let (anchor, monitor) = resolve_pet_anchor(app, &window)?;
            let (width, height) = fit_window_size_to_bounds(
                requested_size.width,
                requested_size.height,
                monitor.screen(),
                FLOATING_INSET,
            );
            (
                LogicalSize::new(width, height),
                Some(expanded_floating_position(
                    anchor,
                    monitor.screen(),
                    width,
                    height,
                    FLOATING_INSET,
                )),
            )
        } else {
            let monitor = logical_monitor_bounds(&window)?;
            let (width, height) = fit_window_size_to_bounds(
                requested_size.width,
                requested_size.height,
                monitor.screen(),
                FLOATING_INSET,
            );
            (LogicalSize::new(width, height), None)
        };
    let previous_size = window.inner_size().map_err(|error| error.to_string())?;
    let previous_position = window.outer_position().map_err(|error| error.to_string())?;
    let previous_resizable = window.is_resizable().map_err(|error| error.to_string())?;
    let previous_visible = window.is_visible().map_err(|error| error.to_string())?;
    let previous_mode = with_panel_state(app, |state| {
        let previous_mode = state.mode;
        state.mode = QuickPanelMode::Expanded;
        Ok(previous_mode)
    })?;

    let transition = (|| {
        window
            .set_size(expanded_size)
            .map_err(|error| error.to_string())?;
        if let Some(position) = expanded_position {
            window
                .set_position(LogicalPosition::new(position.x, position.y))
                .map_err(|error| error.to_string())?;
        }
        let _ = window.set_resizable(true);
        let _ = window.set_always_on_top(true);
        present_window(&window, app)
    })();
    if let Err(error) = transition {
        let _ = window.set_size(previous_size);
        let _ = window.set_position(previous_position);
        let _ = window.set_resizable(previous_resizable);
        if !previous_visible {
            let _ = window.hide();
        }
        let _ = with_panel_state(app, |state| {
            state.mode = previous_mode;
            Ok(())
        });
        return Err(error);
    }
    emit_panel_mode(app, QuickPanelMode::Expanded)
}

pub fn collapse_quick_panel_to_pet(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    remember_expanded_size(app, &window)?;
    let (anchor, _) = resolve_pet_anchor(app, &window)?;
    let previous_mode = with_panel_state(app, |state| {
        let previous_mode = state.mode;
        state.mode = QuickPanelMode::Pet;
        state.anchor_position = Some(anchor);
        Ok(previous_mode)
    })?;

    let transition = (|| {
        window
            .set_size(LogicalSize::new(PET_SIZE, PET_SIZE))
            .map_err(|error| error.to_string())?;
        window
            .set_position(LogicalPosition::new(anchor.x, anchor.y))
            .map_err(|error| error.to_string())?;
        let _ = window.set_resizable(false);
        let _ = window.set_always_on_top(true);
        present_window_passive(&window)
    })();
    if let Err(error) = transition {
        let _ = with_panel_state(app, |state| {
            state.mode = previous_mode;
            Ok(())
        });
        return Err(error);
    }
    emit_panel_mode(app, QuickPanelMode::Pet)
}

pub fn show_quick_launcher(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    remember_pet_anchor(app, &window)?;
    let (anchor, monitor) = resolve_pet_anchor(app, &window)?;
    let position = launcher_floating_position(
        anchor,
        monitor.screen(),
        LAUNCHER_WIDTH,
        LAUNCHER_HEIGHT,
        PET_SIZE,
        FLOATING_INSET,
    );
    let previous_mode = with_panel_state(app, |state| {
        let previous_mode = state.mode;
        state.mode = QuickPanelMode::Launcher;
        state.anchor_position = Some(anchor);
        Ok(previous_mode)
    })?;

    let transition = (|| {
        window
            .set_size(LogicalSize::new(LAUNCHER_WIDTH, LAUNCHER_HEIGHT))
            .map_err(|error| error.to_string())?;
        window
            .set_position(LogicalPosition::new(position.x, position.y))
            .map_err(|error| error.to_string())?;
        let _ = window.set_resizable(false);
        present_window_passive(&window)
    })();
    if let Err(error) = transition {
        let _ = with_panel_state(app, |state| {
            state.mode = previous_mode;
            Ok(())
        });
        return Err(error);
    }
    emit_panel_mode(app, QuickPanelMode::Launcher)
}

pub fn show_quick_panel_near_cursor(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .ok_or_else(|| "quick panel window not found".to_string())?;

    let mode = read_panel_state(app, |state| state.mode)?;

    if mode == QuickPanelMode::Pet {
        expand_quick_panel(app)?;
        return Ok(());
    }

    let requested_size = read_panel_state(app, |state| state.expanded_size)?;

    if !window.is_visible().unwrap_or(false) || mode == QuickPanelMode::Hidden {
        let (cursor_x, cursor_y) = cursor_position()?;
        let (screen_w, screen_h) = primary_screen_size()?;
        let (panel_w, panel_h) = fit_window_size_to_bounds(
            requested_size.width,
            requested_size.height,
            LogicalScreenBounds {
                x: 0.0,
                y: 0.0,
                width: screen_w as f64,
                height: screen_h as f64,
            },
            FLOATING_INSET,
        );
        let expanded_size = LogicalSize::new(panel_w, panel_h);

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

fn shortcut_requires_main_window(onboarding_complete: bool) -> bool {
    !onboarding_complete
}

pub fn show_quick_panel_via_shortcut(app: &AppHandle) -> Result<(), String> {
    let settings = load_settings(app)?;

    if shortcut_requires_main_window(settings.onboarding_complete) {
        show_main_window(app)
    } else {
        show_quick_panel_near_cursor(app)
    }
}

pub fn request_capture_via_shortcut(app: &AppHandle) -> Result<(), String> {
    let settings = load_settings(app)?;
    if shortcut_requires_main_window(settings.onboarding_complete) {
        return show_main_window(app);
    }
    with_panel_state(app, |state| {
        state.capture_pending = true;
        Ok(())
    })?;
    app.emit_to(QUICK_PANEL_LABEL, "capture-requested", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn take_pending_capture_request(app: AppHandle) -> Result<bool, String> {
    with_panel_state(&app, |state| {
        let pending = state.capture_pending;
        state.capture_pending = false;
        Ok(pending)
    })
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
    let settings = match load_settings(app) {
        Ok(settings) => settings,
        Err(_) => return hide_quick_panel_silent(app),
    };

    match quick_panel_close_target(settings.floating_assistant_enabled) {
        MainCloseTarget::Pet => collapse_quick_panel_to_pet(app),
        MainCloseTarget::Hidden => hide_quick_panel_silent(app),
    }
}

pub fn hide_quick_panel(app: &AppHandle) -> Result<(), String> {
    let _ = app.emit_to(QUICK_PANEL_LABEL, "quick-panel-closing", ());
    hide_quick_panel_silent(app)
}

pub fn hide_quick_panel_silent(app: &AppHandle) -> Result<(), String> {
    with_panel_state(app, |state| {
        state.mode = QuickPanelMode::Hidden;
        Ok(())
    })?;
    if let Some(window) = app.get_webview_window(QUICK_PANEL_LABEL) {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|error| error.to_string())?;
        }
    }
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

fn handle_main_window_close(window: &Window) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())?;
    let app = window.app_handle();
    let settings = match load_settings(app) {
        Ok(settings) => settings,
        Err(error) => {
            let _ = hide_quick_panel_silent(app);
            return Err(error);
        }
    };

    match main_close_target(
        settings.onboarding_complete,
        settings.floating_assistant_enabled,
    ) {
        MainCloseTarget::Pet => collapse_quick_panel_to_pet(app),
        MainCloseTarget::Hidden => hide_quick_panel_silent(app),
    }
}

pub(crate) fn handle_window_event(window: &Window, event: &WindowEvent) -> Result<(), String> {
    match event {
        WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW_LABEL => {
            api.prevent_close();
            handle_main_window_close(window)
        }
        WindowEvent::Moved(position) if window.label() == QUICK_PANEL_LABEL => {
            let panel = window
                .app_handle()
                .get_webview_window(QUICK_PANEL_LABEL)
                .ok_or_else(|| "quick panel window not found".to_string())?;
            record_pet_anchor(window.app_handle(), &panel, *position)
        }
        WindowEvent::Focused(false) if window.label() == QUICK_PANEL_LABEL => {
            let app = window.app_handle();
            if read_panel_state(app, |state| state.mode)? != QuickPanelMode::Launcher {
                return Ok(());
            }
            let panel = app
                .get_webview_window(QUICK_PANEL_LABEL)
                .ok_or_else(|| "quick panel window not found".to_string())?;
            if panel.is_visible().map_err(|error| error.to_string())? {
                close_quick_panel(app)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
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

#[cfg(test)]
mod tests {
    use super::{
        main_close_target, quick_panel_close_target, shortcut_requires_main_window,
        should_remember_expanded_size, MainCloseTarget, QuickPanelMode,
    };

    #[test]
    fn shortcut_gate_depends_only_on_onboarding_completion() {
        assert!(shortcut_requires_main_window(false));
        assert!(!shortcut_requires_main_window(true));
    }

    #[test]
    fn main_close_hands_off_only_to_an_enabled_floating_assistant() {
        assert_eq!(main_close_target(false, false), MainCloseTarget::Hidden);
        assert_eq!(main_close_target(false, true), MainCloseTarget::Hidden);
        assert_eq!(main_close_target(true, false), MainCloseTarget::Hidden);
        assert_eq!(main_close_target(true, true), MainCloseTarget::Pet);
    }

    #[test]
    fn quick_panel_close_respects_the_floating_assistant_preference() {
        assert_eq!(quick_panel_close_target(true), MainCloseTarget::Pet);
        assert_eq!(quick_panel_close_target(false), MainCloseTarget::Hidden);
    }

    #[test]
    fn remembers_expanded_size_only_from_expanded_mode() {
        assert!(should_remember_expanded_size(QuickPanelMode::Expanded));
        assert!(!should_remember_expanded_size(QuickPanelMode::Launcher));
        assert!(!should_remember_expanded_size(QuickPanelMode::Pet));
        assert!(!should_remember_expanded_size(QuickPanelMode::Hidden));
    }
}
