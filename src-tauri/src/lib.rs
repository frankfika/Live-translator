mod audio;
mod commands;
mod db;
mod models;
mod utils;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 悬浮字幕窗（同时是音频引擎所在窗口）
const OVERLAY: &str = "main";
/// 控制面板（设置 + 历史记录），按需显示
const PANEL: &str = "panel";

#[cfg(target_os = "macos")]
const MOD_LABEL: &str = "⇧⌘";
#[cfg(not(target_os = "macos"))]
const MOD_LABEL: &str = "Ctrl+Shift+";

/// 鼠标穿透（锁定）状态。锁定后悬浮窗不接收任何点击，只能用快捷键 / 托盘解锁。
#[derive(Default)]
struct OverlayState {
    click_through: AtomicBool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let database = Arc::new(
        db::connection::Database::new()
            .map_err(|e| format!("Failed to initialize database: {e}"))?,
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let s = shortcut.into_string().to_lowercase();
                    if s.ends_with("keys") {
                        toggle_overlay(app);
                    } else if s.ends_with("keyr") {
                        let _ = app.emit("global-shortcut-record", ());
                    } else if s.ends_with("keyl") {
                        let state = app.state::<OverlayState>();
                        let next = !state.click_through.load(Ordering::SeqCst);
                        apply_click_through(app, next);
                    }
                })
                .build(),
        )
        .manage(database)
        .manage(audio::SystemAudioState::default())
        .manage(OverlayState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // macOS：做成菜单栏应用，不占 Dock，不打扰
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ========== 悬浮窗初始位置：主屏底部居中 ==========
            if let Some(overlay) = app.get_webview_window(OVERLAY) {
                let _ = place_overlay_bottom_center(&overlay);
                let _ = overlay.show();
            }

            // ========== 系统托盘 ==========
            let toggle_overlay_item = MenuItem::with_id(
                app,
                "toggle_overlay",
                format!("显示/隐藏字幕    {MOD_LABEL}S"),
                true,
                None::<&str>,
            )?;
            let record_item = MenuItem::with_id(
                app,
                "record",
                format!("开始/停止翻译    {MOD_LABEL}R"),
                true,
                None::<&str>,
            )?;
            let lock_item = CheckMenuItem::with_id(
                app,
                "lock",
                format!("锁定字幕（鼠标穿透）    {MOD_LABEL}L"),
                true,
                false,
                None::<&str>,
            )?;
            let panel_item = MenuItem::with_id(app, "panel", "设置与记录…", true, None::<&str>)?;
            let reset_pos_item =
                MenuItem::with_id(app, "reset_pos", "字幕回到屏幕底部", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &record_item,
                    &toggle_overlay_item,
                    &lock_item,
                    &sep,
                    &panel_item,
                    &reset_pos_item,
                    &sep2,
                    &quit_item,
                ],
            )?;

            let lock_item_handle = lock_item.clone();
            TrayIconBuilder::with_id("main-tray")
                .tooltip("AI 同声传译")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("default window icon is required for tray")?,
                )
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle_overlay" => toggle_overlay(app),
                    "record" => {
                        let _ = app.emit("global-shortcut-record", ());
                    }
                    "lock" => {
                        let state = app.state::<OverlayState>();
                        let next = !state.click_through.load(Ordering::SeqCst);
                        apply_click_through(app, next);
                        let _ = lock_item_handle.set_checked(next);
                    }
                    "panel" => show_panel(app, None),
                    "reset_pos" => {
                        if let Some(w) = app.get_webview_window(OVERLAY) {
                            let _ = place_overlay_bottom_center(&w);
                            let _ = w.show();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘：显示/隐藏字幕
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_overlay(tray.app_handle());
                    }
                })
                .build(app)?;

            // ========== 全局快捷键 ==========
            let gs = app.global_shortcut();
            for key in ["CommandOrControl+Shift+S", "CommandOrControl+Shift+R", "CommandOrControl+Shift+L"] {
                if let Err(e) = gs.register(key) {
                    // 被其他软件占用时不要让整个 app 起不来
                    eprintln!("Failed to register shortcut {key}: {e}");
                }
            }

            // 控制面板关闭 = 隐藏（引擎在悬浮窗里，面板随时可再打开）
            if let Some(panel) = app.get_webview_window(PANEL) {
                let p = panel.clone();
                panel.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = p.hide();
                    }
                });
            }
            // 悬浮窗关闭 = 隐藏到托盘
            if let Some(overlay) = app.get_webview_window(OVERLAY) {
                let o = overlay.clone();
                overlay.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = o.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_all_settings,
            commands::transcripts::save_transcript,
            commands::transcripts::get_session_transcripts,
            commands::transcripts::export_session,
            audio::system_audio_supported,
            audio::start_system_audio,
            audio::stop_system_audio,
            open_panel,
            show_overlay,
            hide_overlay,
            set_click_through,
            get_click_through,
            set_hide_in_screen_share,
            resize_overlay,
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}

fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
}

fn show_panel(app: &AppHandle, tab: Option<String>) {
    if let Some(w) = app.get_webview_window(PANEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(tab) = tab {
            let _ = app.emit_to(PANEL, "panel-tab", tab);
        }
    }
}

fn apply_click_through(app: &AppHandle, enabled: bool) {
    let state = app.state::<OverlayState>();
    state.click_through.store(enabled, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.set_ignore_cursor_events(enabled);
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(if enabled {
            if cfg!(target_os = "macos") {
                "AI 同声传译（字幕已锁定，⇧⌘L 解锁）"
            } else {
                "AI 同声传译（字幕已锁定，Ctrl+Shift+L 解锁）"
            }
        } else {
            "AI 同声传译"
        }));
    }
    let _ = app.emit("click-through-changed", enabled);
}

/// 悬浮窗放到当前主屏底部居中，宽度取屏幕 60%（640~1100 逻辑像素）
fn place_overlay_bottom_center(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = window
        .current_monitor()?
        .or(window.primary_monitor()?);
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let origin = monitor.position().to_logical::<f64>(scale);
        let width = (size.width * 0.6).clamp(640.0, 1100.0).min(size.width - 40.0);
        let height = window
            .outer_size()
            .map(|s| s.to_logical::<f64>(scale).height)
            .unwrap_or(160.0)
            .max(120.0);
        let x = origin.x + (size.width - width) / 2.0;
        // 留出 Dock / 任务栏的高度
        let y = origin.y + size.height - height - 72.0;
        window.set_size(Size::Logical(LogicalSize { width, height }))?;
        window.set_position(Position::Logical(LogicalPosition { x, y }))?;
    }
    Ok(())
}

#[tauri::command]
fn open_panel(app: AppHandle, tab: Option<String>) {
    show_panel(&app, tab);
}

#[tauri::command]
fn show_overlay(app: AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.show();
    }
}

#[tauri::command]
fn hide_overlay(app: AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn set_click_through(app: AppHandle, enabled: bool) {
    apply_click_through(&app, enabled);
}

#[tauri::command]
fn get_click_through(state: tauri::State<'_, OverlayState>) -> bool {
    state.click_through.load(Ordering::SeqCst)
}

/// 屏幕共享 / 录屏时隐藏悬浮窗和面板（macOS: NSWindowSharingNone；Windows: WDA_EXCLUDEFROMCAPTURE）
#[tauri::command]
fn set_hide_in_screen_share(app: AppHandle, enabled: bool) {
    for label in [OVERLAY, PANEL] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_content_protected(enabled);
        }
    }
}

/// 悬浮窗按内容调整高度（底边固定不动，往上长）
#[tauri::command]
fn resize_overlay(app: AppHandle, height: f64) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let Ok(scale) = w.scale_factor() else { return };
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
            return;
        };
        let pos = pos.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        let height = height.clamp(56.0, 600.0);
        if (size.height - height).abs() < 1.0 {
            return;
        }
        let bottom = pos.y + size.height;
        let _ = w.set_size(Size::Logical(LogicalSize {
            width: size.width,
            height,
        }));
        let _ = w.set_position(Position::Logical(LogicalPosition {
            x: pos.x,
            y: bottom - height,
        }));
    }
}
