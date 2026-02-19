mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            // Process management
            commands::process::kill_zoom_processes,
            // File operations
            commands::filesystem::scan_zoom_paths,
            commands::filesystem::delete_zoom_directories,
            // Registry
            commands::registry::delete_zoom_registry,
            // Services
            commands::services::delete_zoom_services,
            // Tasks
            commands::tasks::delete_zoom_scheduled_tasks,
            // Download
            commands::download::download_zoom_installer,
            // Install
            commands::install::uninstall_zoom,
            commands::install::install_zoom,
            commands::install::launch_zoom,
            // User management
            commands::user_management::check_zoom_user,
            commands::user_management::create_zoom_user,
            commands::user_management::delete_zoom_user,
            commands::user_management::launch_zoom_as_user,
            commands::user_management::reset_zoom_user,
            // Full reset orchestration
            commands::full_reset,
            // App control
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
