use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Registry keys to delete from HKCU
const REGISTRY_KEYS_HKCU: &[&str] = &[
    "Software\\Zoom",
    "Software\\ZoomUMX",
    "Software\\zoom.us",
    "Software\\Zoom Video Communications",
    "Software\\Zoom Workplace",
    "Software\\ZoomGifCollector",
    "Software\\CptService",
];

/// Registry keys to delete from HKLM
const REGISTRY_KEYS_HKLM: &[&str] = &[
    "Software\\Zoom",
    "Software\\ZoomUMX",
    "Software\\zoom.us",
    "Software\\Zoom Video Communications",
    "Software\\Zoom Workplace",
    "Software\\WOW6432Node\\Zoom",
    "Software\\WOW6432Node\\ZoomUMX",
    "Software\\WOW6432Node\\zoom.us",
    "Software\\CptService",
    "SYSTEM\\CurrentControlSet\\Services\\CptService",
    "SYSTEM\\CurrentControlSet\\Services\\ZoomCptService",
];

/// Windows credentials to delete
const CREDENTIALS: &[&str] = &[
    "zoom.us",
    "Zoom",
    "ZoomVideo",
    "ZoomUMX",
    "ZoomWorkplace",
];

/// Delete Zoom registry keys and credentials
#[tauri::command]
pub async fn delete_zoom_registry(app: AppHandle) -> Result<u32, String> {
    let mut deleted = 0;

    // Delete HKCU keys
    for key in REGISTRY_KEYS_HKCU {
        let _ = app.emit("progress", format!("Deleting HKCU\\{}...", key));
        if delete_registry_key("HKCU", key).await {
            deleted += 1;
        }
    }

    // Delete HKLM keys
    for key in REGISTRY_KEYS_HKLM {
        let _ = app.emit("progress", format!("Deleting HKLM\\{}...", key));
        if delete_registry_key("HKLM", key).await {
            deleted += 1;
        }
    }

    // Delete Run keys
    let _ = app.emit("progress", "Deleting Run entries...");
    delete_run_entry("Zoom").await;
    delete_run_entry("ZoomUMX").await;

    // Delete Uninstall entries
    let _ = app.emit("progress", "Deleting Uninstall entries...");
    delete_uninstall_entries().await;

    // Delete Windows credentials
    let _ = app.emit("progress", "Deleting Windows credentials...");
    for cred in CREDENTIALS {
        delete_credential(cred).await;
    }

    Ok(deleted)
}

#[cfg(windows)]
async fn delete_registry_key(hive: &str, key: &str) -> bool {
    let full_key = format!("{}\\{}", hive, key);
    let output = Command::new("reg")
        .args(["delete", &full_key, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    output.map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(not(windows))]
async fn delete_registry_key(_hive: &str, _key: &str) -> bool {
    false
}

#[cfg(windows)]
async fn delete_run_entry(name: &str) {
    let _ = Command::new("reg")
        .args([
            "delete",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            name,
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn delete_run_entry(_name: &str) {}

#[cfg(windows)]
async fn delete_uninstall_entries() {
    let entries = [
        "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX",
        "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom",
    ];

    for entry in entries {
        let _ = Command::new("reg")
            .args(["delete", entry, "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[cfg(not(windows))]
async fn delete_uninstall_entries() {}

#[cfg(windows)]
async fn delete_credential(name: &str) {
    let _ = Command::new("cmdkey")
        .args(["/delete", name])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn delete_credential(_name: &str) {}
