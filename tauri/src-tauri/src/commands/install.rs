use std::env;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Uninstall Zoom completely
#[tauri::command]
pub async fn uninstall_zoom(app: AppHandle) -> Result<bool, String> {
    let _ = app.emit("progress", "Uninstalling Zoom...");

    // Try Zoom's own uninstaller
    let installer_paths = [
        "C:\\Program Files\\Zoom\\bin\\Installer.exe",
        "C:\\Program Files (x86)\\Zoom\\bin\\Installer.exe",
    ];

    for path in installer_paths {
        if PathBuf::from(path).exists() {
            run_uninstaller(path).await;
        }
    }

    // Try WMI uninstall
    wmi_uninstall().await;

    Ok(true)
}

#[cfg(windows)]
async fn run_uninstaller(path: &str) {
    let _ = Command::new(path)
        .arg("/uninstall")
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn run_uninstaller(_path: &str) {}

#[cfg(windows)]
async fn wmi_uninstall() {
    let _ = Command::new("wmic")
        .args([
            "product",
            "where",
            "name like '%Zoom%'",
            "call",
            "uninstall",
            "/nointeractive",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn wmi_uninstall() {}

/// Install Zoom from MSI
#[tauri::command]
pub async fn install_zoom(app: AppHandle, msi_path: String) -> Result<bool, String> {
    let _ = app.emit("progress", "Installing Zoom...");

    #[cfg(windows)]
    {
        let output = Command::new("msiexec")
            .args(["/i", &msi_path, "/qn", "/norestart", "ALLUSERS=1"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;

        let code = output.status.code();
        // 0 = success, 3010 = success with restart required
        if code == Some(0) || code == Some(3010) {
            // Clean up installer
            let _ = std::fs::remove_file(&msi_path);
            Ok(true)
        } else {
            Err(format!("Install failed with code {:?}", code))
        }
    }

    #[cfg(not(windows))]
    {
        let _ = msi_path;
        Err("MSI installation only supported on Windows".to_string())
    }
}

/// Launch Zoom
#[tauri::command]
pub fn launch_zoom() -> Result<bool, String> {
    // Try common installation paths
    let zoom_paths = [
        "C:\\Program Files\\Zoom\\bin\\Zoom.exe",
        "C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe",
    ];

    for path in zoom_paths {
        if PathBuf::from(path).exists() {
            return launch_executable(path);
        }
    }

    // Try AppData location
    if let Ok(appdata) = env::var("APPDATA") {
        let path = PathBuf::from(&appdata).join("Zoom").join("bin").join("Zoom.exe");
        if path.exists() {
            return launch_executable(&path.to_string_lossy());
        }
    }

    // Try LocalAppData location
    if let Ok(localappdata) = env::var("LOCALAPPDATA") {
        let path = PathBuf::from(&localappdata).join("Zoom").join("bin").join("Zoom.exe");
        if path.exists() {
            return launch_executable(&path.to_string_lossy());
        }
    }

    // Fall back to protocol launch
    launch_via_protocol()
}

#[cfg(windows)]
fn launch_executable(path: &str) -> Result<bool, String> {
    Command::new(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(not(windows))]
fn launch_executable(path: &str) -> Result<bool, String> {
    Command::new(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(windows)]
fn launch_via_protocol() -> Result<bool, String> {
    Command::new("cmd")
        .args(["/c", "start", "zoommtg://"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(not(windows))]
fn launch_via_protocol() -> Result<bool, String> {
    Err("Protocol launch not supported".to_string())
}

/// Find the Zoom executable path
pub fn find_zoom_executable() -> Result<String, String> {
    let zoom_paths = [
        "C:\\Program Files\\Zoom\\bin\\Zoom.exe",
        "C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe",
    ];

    for path in zoom_paths {
        if PathBuf::from(path).exists() {
            return Ok(path.to_string());
        }
    }

    // Check AppData locations
    if let Ok(appdata) = env::var("APPDATA") {
        let path = PathBuf::from(&appdata).join("Zoom").join("bin").join("Zoom.exe");
        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    if let Ok(localappdata) = env::var("LOCALAPPDATA") {
        let path = PathBuf::from(&localappdata).join("Zoom").join("bin").join("Zoom.exe");
        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    Err("Zoom executable not found".to_string())
}
