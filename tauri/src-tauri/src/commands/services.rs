use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Zoom Windows services
const ZOOM_SERVICES: &[&str] = &[
    "CptService",
    "ZoomCptService",
    "zCSCptService",
    "Zoom Sharing Service",
    "ZoomRooms",
];

/// Delete Zoom Windows services
#[tauri::command]
pub async fn delete_zoom_services(app: AppHandle) -> Result<bool, String> {
    for service in ZOOM_SERVICES {
        let _ = app.emit("progress", format!("Stopping service {}...", service));

        // Stop the service
        stop_service(service).await;

        let _ = app.emit("progress", format!("Deleting service {}...", service));

        // Delete the service
        delete_service(service).await;
    }

    Ok(true)
}

#[cfg(windows)]
async fn stop_service(service: &str) {
    // Try net stop
    let _ = Command::new("net")
        .args(["stop", service])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    // Try sc stop
    let _ = Command::new("sc")
        .args(["stop", service])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn stop_service(_service: &str) {}

#[cfg(windows)]
async fn delete_service(service: &str) {
    let _ = Command::new("sc")
        .args(["delete", service])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn delete_service(_service: &str) {}
