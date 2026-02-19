use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Known Zoom scheduled tasks
const ZOOM_TASKS: &[&str] = &[
    "Zoom",
    "ZoomUpdateTaskMachine",
    "ZoomUpdateTaskUserS-*",
    "ZoomInstallUpdate",
    "ZoomGifCollector",
    "ZoomCleaner",
    "ZoomAutoUpdate",
];

/// Delete Zoom scheduled tasks
#[tauri::command]
pub async fn delete_zoom_scheduled_tasks(app: AppHandle) -> Result<bool, String> {
    let _ = app.emit("progress", "Deleting Zoom scheduled tasks...");

    // Delete known tasks
    for task in ZOOM_TASKS {
        delete_scheduled_task(task).await;
    }

    // Use PowerShell to find and delete any task containing "Zoom"
    delete_all_zoom_tasks_powershell().await;

    Ok(true)
}

#[cfg(windows)]
async fn delete_scheduled_task(task: &str) {
    let _ = Command::new("schtasks")
        .args(["/delete", "/tn", task, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn delete_scheduled_task(_task: &str) {}

#[cfg(windows)]
async fn delete_all_zoom_tasks_powershell() {
    let script = r#"
        Get-ScheduledTask -ErrorAction SilentlyContinue |
            Where-Object { $_.TaskName -like '*Zoom*' } |
            Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    "#;

    let _ = Command::new("powershell")
        .args(["-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn delete_all_zoom_tasks_powershell() {}
