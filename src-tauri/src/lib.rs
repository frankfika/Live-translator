mod commands;
mod db;
mod models;
mod utils;

use std::sync::Arc;
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    // 初始化数据库（错误向上抛，由 main.rs 打印 + 退出）
    let database = Arc::new(db::connection::Database::new().map_err(|e| {
        format!("Failed to initialize database: {e}")
    })?);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(database)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ========== 系统托盘 ==========
            let show_main_item = MenuItem::with_id(
                app,
                "show_main",
                "显示主窗口",
                true,
                None::<&str>,
            )?;
            let toggle_subtitle_item = MenuItem::with_id(
                app,
                "toggle_subtitle",
                "显示/隐藏字幕",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "退出",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(
                app,
                &[&show_main_item, &toggle_subtitle_item, &quit_item],
            )?;

            let tray_app_handle = app.handle().clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("default window icon is required for tray")?,
                )
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show_main" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "toggle_subtitle" => {
                        if let Some(window) = app.get_webview_window("subtitle") {
                            toggle_subtitle_window(&window);
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // 让 tray 句柄保持在作用域内（目前未用，但保留以备后用）
            let _ = tray_app_handle;

            // ========== 全局快捷键 ==========

            // Cmd/Ctrl+Shift+S — 副屏字幕 toggle
            let app_handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut(
                    "CommandOrControl+Shift+S",
                    move |_app, _event, _shortcut| {
                        if let Some(window) = app_handle.get_webview_window("subtitle") {
                            toggle_subtitle_window(&window);
                        }
                    },
                )?;

            // Cmd/Ctrl+Shift+R — 全局录音 toggle
            let app_handle2 = app.handle().clone();
            app.global_shortcut()
                .on_shortcut(
                    "CommandOrControl+Shift+R",
                    move |_app, _event, _shortcut| {
                        let _ = app_handle2.emit("global-shortcut-record", ());
                    },
                )?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_all_settings,
            commands::transcripts::save_transcript,
            commands::transcripts::get_session_transcripts,
            commands::transcripts::export_session,
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}

/// 显示 / 隐藏副屏字幕窗。
/// 隐藏时直接 hide；显示前先定位到主屏底部（宽度 = 主屏宽，高度 = 120）。
/// 未来可扩展为：检测当前焦点窗口所在的 monitor，支持副屏定位。
fn toggle_subtitle_window(window: &WebviewWindow) {
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        Ok(false) => {
            if let Err(e) = position_subtitle_at_bottom(window) {
                eprintln!("Failed to position subtitle window: {e}");
            }
            let _ = window.show();
        }
        Err(e) => {
            eprintln!("Failed to read subtitle visibility: {e}");
        }
    }
}

/// 把副屏字幕窗定位到主屏底部，全宽，120px 高。
/// Future: 找当前焦点窗口所在的 monitor，定位到那块屏幕底部。
fn position_subtitle_at_bottom(window: &WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = window.primary_monitor()? {
        let screen_size = monitor.size();
        let subtitle_height: u32 = 120;
        let y = (screen_size.height as i32).saturating_sub(subtitle_height as i32);

        window.set_position(Position::Physical(PhysicalPosition { x: 0, y }))?;
        window.set_size(Size::Physical(PhysicalSize {
            width: screen_size.width,
            height: subtitle_height,
        }))?;
    }
    Ok(())
}
