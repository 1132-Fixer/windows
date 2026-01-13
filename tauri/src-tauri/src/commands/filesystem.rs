use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// System folders to skip when scanning C:\Users
const SYSTEM_FOLDERS: &[&str] = &["public", "default", "default user", "all users"];

/// Scan for all Zoom data paths across the system
#[tauri::command]
pub fn scan_zoom_paths() -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    let appdata = env::var("APPDATA").ok();
    let localappdata = env::var("LOCALAPPDATA").ok();
    let userprofile = env::var("USERPROFILE").ok();
    let temp = env::var("TEMP").ok();
    let programdata = env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());

    // Build candidate paths
    let mut candidates: Vec<Option<PathBuf>> = vec![
        // Main Zoom folders
        appdata.as_ref().map(|p| PathBuf::from(p).join("Zoom")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Zoom")),
        appdata.as_ref().map(|p| PathBuf::from(p).join("Zoom Meetings")),
        // Zoomus variants
        appdata.as_ref().map(|p| PathBuf::from(p).join("zoomus")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("zoomus")),
        // User documents
        userprofile.as_ref().map(|p| PathBuf::from(p).join("Documents").join("Zoom")),
        // Temp files
        temp.as_ref().map(|p| PathBuf::from(p).join("Zoom")),
        temp.as_ref().map(|p| PathBuf::from(p).join("zoomus")),
        temp.as_ref().map(|p| PathBuf::from(p).join("zoom_installer")),
        // Local low
        userprofile.as_ref().map(|p| PathBuf::from(p).join("AppData").join("LocalLow").join("Zoom")),
        // Zoom logs
        appdata.as_ref().map(|p| PathBuf::from(p).join("ZoomLogs")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("ZoomLogs")),
        // ProgramData
        Some(PathBuf::from(&programdata).join("Zoom")),
        Some(PathBuf::from(&programdata).join("ZoomVideo")),
        Some(PathBuf::from(&programdata).join("Zoom Video Communications")),
        // CptService
        Some(PathBuf::from(&programdata).join("CptService")),
        Some(PathBuf::from(&programdata).join("CptHost")),
        Some(PathBuf::from(&programdata).join("Zoom CptService")),
        // LocalAppData Programs
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Programs").join("Zoom")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Programs").join("zoom.us")),
        // Cache locations
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Zoom").join("data")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Zoom").join("cache")),
        appdata.as_ref().map(|p| PathBuf::from(p).join("Zoom").join("data")),
        // VDI folders
        appdata.as_ref().map(|p| PathBuf::from(p).join("Zoom VDI")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Zoom VDI")),
        Some(PathBuf::from(&programdata).join("Zoom VDI")),
        // Outlook plugin
        appdata.as_ref().map(|p| PathBuf::from(p).join("ZoomOutlookPlugin")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("ZoomOutlookPlugin")),
        // WebView2 cache
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Zoom").join("EBWebView")),
        // ZoomUMX
        appdata.as_ref().map(|p| PathBuf::from(p).join("ZoomUMX")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("ZoomUMX")),
        // zoom.us
        appdata.as_ref().map(|p| PathBuf::from(p).join("zoom.us")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("zoom.us")),
        // Zoom Workplace
        appdata.as_ref().map(|p| PathBuf::from(p).join("Zoom Workplace")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("Zoom Workplace")),
        Some(PathBuf::from("C:\\Program Files\\Zoom Workplace")),
        Some(PathBuf::from("C:\\Program Files (x86)\\Zoom Workplace")),
        // ZoomGifCollector
        appdata.as_ref().map(|p| PathBuf::from(p).join("ZoomGifCollector")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("ZoomGifCollector")),
        // Program Files
        Some(PathBuf::from("C:\\Program Files\\Zoom")),
        Some(PathBuf::from("C:\\Program Files (x86)\\Zoom")),
        Some(PathBuf::from("C:\\Program Files\\Zoom\\bin")),
        // Common Files
        Some(PathBuf::from("C:\\Program Files\\Common Files\\Zoom")),
        Some(PathBuf::from("C:\\Program Files (x86)\\Common Files\\Zoom")),
        Some(PathBuf::from("C:\\Program Files\\Common Files\\zoom.us")),
        Some(PathBuf::from("C:\\Program Files (x86)\\Common Files\\zoom.us")),
        // Updater folders
        localappdata.as_ref().map(|p| PathBuf::from(p).join("zoom-1132-eliminator-updater")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("zoom-updater")),
        localappdata.as_ref().map(|p| PathBuf::from(p).join("squirrel-zoom")),
    ];

    // Scan C:\Users for all user profiles
    let current_user = env::var("USERNAME").unwrap_or_default().to_lowercase();

    if let Ok(entries) = fs::read_dir("C:\\Users") {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    let folder_name = entry.file_name().to_string_lossy().to_lowercase();
                    let user_path = entry.path();

                    // Skip system folders
                    if SYSTEM_FOLDERS.contains(&folder_name.as_str()) {
                        continue;
                    }

                    // Add Zoom data locations for this user profile
                    let user_appdata_roaming = user_path.join("AppData").join("Roaming");
                    let user_appdata_local = user_path.join("AppData").join("Local");
                    let user_appdata_locallow = user_path.join("AppData").join("LocalLow");
                    let user_documents = user_path.join("Documents");
                    let user_temp = user_appdata_local.join("Temp");

                    let user_zoom_paths = vec![
                        user_appdata_roaming.join("Zoom"),
                        user_appdata_roaming.join("Zoom Meetings"),
                        user_appdata_roaming.join("zoomus"),
                        user_appdata_roaming.join("ZoomLogs"),
                        user_appdata_roaming.join("ZoomUMX"),
                        user_appdata_roaming.join("zoom.us"),
                        user_appdata_roaming.join("Zoom Workplace"),
                        user_appdata_roaming.join("ZoomOutlookPlugin"),
                        user_appdata_roaming.join("ZoomGifCollector"),
                        user_appdata_roaming.join("Zoom VDI"),
                        user_appdata_local.join("Zoom"),
                        user_appdata_local.join("zoomus"),
                        user_appdata_local.join("ZoomLogs"),
                        user_appdata_local.join("ZoomUMX"),
                        user_appdata_local.join("zoom.us"),
                        user_appdata_local.join("Zoom Workplace"),
                        user_appdata_local.join("ZoomOutlookPlugin"),
                        user_appdata_local.join("ZoomGifCollector"),
                        user_appdata_local.join("Zoom VDI"),
                        user_appdata_local.join("Programs").join("Zoom"),
                        user_appdata_local.join("Programs").join("zoom.us"),
                        user_appdata_locallow.join("Zoom"),
                        user_documents.join("Zoom"),
                        user_temp.join("Zoom"),
                        user_temp.join("zoomus"),
                        user_temp.join("zoom_installer"),
                    ];

                    for zp in user_zoom_paths {
                        if zp.exists() {
                            candidates.push(Some(zp));
                        }
                    }

                    // Check for Zoom-named profile folders
                    if folder_name.contains("zoom") && folder_name != current_user {
                        candidates.push(Some(user_path.clone()));
                    }
                    // Check for ZG* folders (old ghost user format)
                    if folder_name.starts_with("zg") {
                        candidates.push(Some(user_path));
                    }
                }
            }
        }
    }

    // Deduplicate and filter existing paths
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            let resolved = candidate.canonicalize().unwrap_or(candidate);
            let path_str = resolved.to_string_lossy().to_string();
            if !seen.contains(&path_str) {
                seen.insert(path_str.clone());
                paths.push(path_str);
            }
        }
    }

    Ok(paths)
}

/// Delete all Zoom directories
#[tauri::command]
pub async fn delete_zoom_directories(app: AppHandle) -> Result<u32, String> {
    let paths = scan_zoom_paths()?;
    let mut deleted = 0;

    for path in &paths {
        let _ = app.emit("progress", format!("Deleting {}...", path));

        if delete_directory(path).await {
            deleted += 1;
        }
    }

    // Also delete Program Files locations
    let extra_paths = [
        "C:\\Program Files\\Common Files\\Zoom",
        "C:\\Program Files (x86)\\Common Files\\Zoom",
        "C:\\Program Files\\Zoom",
        "C:\\Program Files (x86)\\Zoom",
    ];

    for path in extra_paths {
        if PathBuf::from(path).exists() {
            delete_directory(path).await;
        }
    }

    Ok(deleted)
}

/// Delete a directory using rmdir
#[cfg(windows)]
async fn delete_directory(path: &str) -> bool {
    let output = Command::new("cmd")
        .args(["/c", "rmdir", "/s", "/q", path])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    output.map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(not(windows))]
async fn delete_directory(path: &str) -> bool {
    fs::remove_dir_all(path).is_ok()
}

/// Clean Windows prefetch files
pub async fn clean_prefetch_files() -> Result<(), String> {
    #[cfg(windows)]
    {
        let script = r#"
            Get-ChildItem 'C:\Windows\Prefetch' -Filter '*ZOOM*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
            Get-ChildItem 'C:\Windows\Prefetch' -Filter '*CPT*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        "#;

        let _ = Command::new("powershell")
            .args(["-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    Ok(())
}

/// Deep clean system traces (firewall rules, MUI cache, DNS)
pub async fn deep_clean_system_traces() -> Result<(), String> {
    #[cfg(windows)]
    {
        let script = r#"
            # Remove firewall rules
            Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Zoom*' -or $_.DisplayName -like '*zoom*' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue

            # Clean MUI cache
            $muiKey = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache'
            if (Test-Path $muiKey) {
                Get-ItemProperty $muiKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
                    Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
                    ForEach-Object { Remove-ItemProperty -Path $muiKey -Name $_.Name -ErrorAction SilentlyContinue }
            }

            # Clean app compat flags
            $compatKey = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
            if (Test-Path $compatKey) {
                Get-ItemProperty $compatKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
                    Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
                    ForEach-Object { Remove-ItemProperty -Path $compatKey -Name $_.Name -ErrorAction SilentlyContinue }
            }

            # Flush DNS cache
            ipconfig /flushdns | Out-Null
        "#;

        let _ = Command::new("powershell")
            .args(["-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    Ok(())
}
