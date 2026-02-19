use std::env;
use std::path::PathBuf;
use std::process::Command;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::download::download_psexec;
use super::install::find_zoom_executable;
use super::process::kill_zoom_processes;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ZOOM_USER: &str = "Zoom";
const ZOOM_PASS: &str = "Zoom1132!";

/// User status response
#[derive(Debug, Clone, Serialize)]
pub struct UserStatus {
    pub exists: bool,
    pub sid: Option<String>,
    #[serde(rename = "profilePath")]
    pub profile_path: Option<String>,
}

/// Check if Zoom user exists
#[tauri::command]
pub async fn check_zoom_user() -> Result<UserStatus, String> {
    #[cfg(windows)]
    {
        let script = format!(
            r#"
            $user = Get-LocalUser -Name '{}' -ErrorAction SilentlyContinue
            if ($user) {{
                $sid = $user.SID.Value
                $profilePath = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -ErrorAction SilentlyContinue).ProfileImagePath
                Write-Output "EXISTS|$sid|$profilePath"
            }} else {{
                Write-Output "NOTEXIST"
            }}
            "#,
            ZOOM_USER
        );

        let output = Command::new("powershell")
            .args(["-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

        if stdout.starts_with("EXISTS|") {
            let parts: Vec<&str> = stdout.split('|').collect();
            Ok(UserStatus {
                exists: true,
                sid: parts.get(1).map(|s| s.to_string()),
                profile_path: parts.get(2).map(|s| s.to_string()),
            })
        } else {
            Ok(UserStatus {
                exists: false,
                sid: None,
                profile_path: None,
            })
        }
    }

    #[cfg(not(windows))]
    {
        Ok(UserStatus {
            exists: false,
            sid: None,
            profile_path: None,
        })
    }
}

/// Create Zoom user with junction links
#[tauri::command]
pub async fn create_zoom_user(app: AppHandle) -> Result<serde_json::Value, String> {
    let main_user = env::var("USERNAME").unwrap_or_default();
    let mut junctions = Vec::new();

    let _ = app.emit("progress", "Creating Zoom user...");

    // Step 1: Create the user
    #[cfg(windows)]
    {
        let cmd = format!(
            "net user {} {} /add && net localgroup Users {} /add",
            ZOOM_USER, ZOOM_PASS, ZOOM_USER
        );

        let output = Command::new("cmd")
            .args(["/c", &cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to create user: {}", stderr));
        }
    }

    let _ = app.emit("progress", "Initializing profile...");

    // Step 2: Initialize the user profile via PsExec
    let psexec_path = download_psexec().await?;

    #[cfg(windows)]
    {
        let _ = Command::new(&psexec_path)
            .args([
                "-accepteula",
                "-u", ZOOM_USER,
                "-p", ZOOM_PASS,
                "-w", "C:\\",
                "cmd", "/c", "echo Profile initialized",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    // Wait for profile creation
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

    let _ = app.emit("progress", "Creating folder junctions...");

    // Step 3: Find actual profile path and create junction links
    let zoom_profile = find_zoom_user_profile().await.unwrap_or_else(|| format!("C:\\Users\\{}", ZOOM_USER));

    // Create junction links for all Zoom profile folders
    let link_result = junction_link_all_zoom_profiles(&main_user).await;
    if let Some(links) = link_result {
        junctions = links;
    }

    // Set permissions
    #[cfg(windows)]
    {
        let _ = Command::new("icacls")
            .args([&zoom_profile, "/grant", "Everyone:(OI)(CI)F", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    Ok(serde_json::json!({
        "success": true,
        "junctions": junctions,
        "profilePath": zoom_profile
    }))
}

/// Delete Zoom user account
#[tauri::command]
pub async fn delete_zoom_user(app: AppHandle) -> Result<serde_json::Value, String> {
    let _ = app.emit("progress", "Killing Zoom processes...");

    // Kill any Zoom processes first
    kill_zoom_processes(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    let _ = app.emit("progress", "Deleting Zoom user...");

    // Delete the user account
    #[cfg(windows)]
    {
        let _ = Command::new("cmd")
            .args(["/c", &format!("net user {} /delete", ZOOM_USER)])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    // Find and delete profile folder
    let zoom_profile = find_zoom_user_profile().await;

    // Remove junction links first to avoid deleting main user's files
    let folders = ["Documents", "Downloads", "Desktop", "Pictures", "Videos", "Music"];

    if let Some(profile) = &zoom_profile {
        #[cfg(windows)]
        for folder in folders {
            let folder_path = format!("{}\\{}", profile, folder);
            let _ = Command::new("cmd")
                .args(["/c", "rmdir", &folder_path])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }

        // Delete profile folder
        #[cfg(windows)]
        {
            let _ = Command::new("cmd")
                .args(["/c", "rmdir", "/s", "/q", profile])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }

    // Also try standard profile path
    #[cfg(windows)]
    {
        let standard_profile = format!("C:\\Users\\{}", ZOOM_USER);
        let _ = Command::new("cmd")
            .args(["/c", "rmdir", "/s", "/q", &standard_profile])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    Ok(serde_json::json!({ "success": true }))
}

/// Launch Zoom as the Zoom user
#[tauri::command]
pub async fn launch_zoom_as_user(app: AppHandle) -> Result<serde_json::Value, String> {
    let _ = app.emit("progress", "Killing existing Zoom processes...");

    // Kill any existing Zoom processes
    kill_zoom_processes(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    // Download PsExec if needed
    let psexec_path = download_psexec().await?;

    // Find Zoom executable
    let zoom_path = find_zoom_executable()?;

    let _ = app.emit("progress", "Launching Zoom as Zoom user...");

    // Launch Zoom as the Zoom user using PsExec
    #[cfg(windows)]
    {
        Command::new(&psexec_path)
            .args([
                "-accepteula",
                "-u", ZOOM_USER,
                "-p", ZOOM_PASS,
                "-i",  // Interactive
                "-h",  // Run with elevated token
                &zoom_path,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "success": true,
        "zoomPath": zoom_path
    }))
}

/// Reset Zoom user (delete and recreate)
#[tauri::command]
pub async fn reset_zoom_user(app: AppHandle) -> Result<serde_json::Value, String> {
    let main_user = env::var("USERNAME").unwrap_or_default();
    let mut steps = Vec::new();

    // Step 1: Kill Zoom processes
    let _ = app.emit("progress", "Killing Zoom processes...");
    steps.push("Killing Zoom processes...");
    kill_zoom_processes(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    steps.push("Zoom processes terminated");

    // Step 2: Get old profile path
    let old_zoom_profile = find_zoom_user_profile().await.unwrap_or_else(|| format!("C:\\Users\\{}", ZOOM_USER));
    steps.push(&format!("Found existing profile at: {}", old_zoom_profile));

    // Step 3: Delete the user
    let _ = app.emit("progress", "Deleting Zoom user account...");
    steps.push("Deleting Zoom user account...");

    #[cfg(windows)]
    {
        let _ = Command::new("cmd")
            .args(["/c", &format!("net user {} /delete 2>nul", ZOOM_USER)])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    steps.push("User account deleted");

    // Step 4: Delete profile folder
    let _ = app.emit("progress", "Deleting user profile folder...");
    steps.push("Deleting user profile folder...");

    let folders_to_unlink = ["Documents", "Downloads", "Desktop", "Pictures", "Videos", "Music"];

    // Remove junctions first
    #[cfg(windows)]
    for folder in folders_to_unlink {
        let folder_path = format!("{}\\{}", old_zoom_profile, folder);
        let _ = Command::new("cmd")
            .args(["/c", "rmdir", &folder_path, "2>nul"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    // Delete profile folder
    #[cfg(windows)]
    {
        let _ = Command::new("cmd")
            .args(["/c", "rmdir", "/s", "/q", &old_zoom_profile, "2>nul"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    // Clean up any stale Zoom profile folders
    cleanup_stale_zoom_profiles().await;

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    steps.push("Profile folder(s) deleted");

    // Step 5: Clean registry
    let _ = app.emit("progress", "Cleaning registry...");
    steps.push("Cleaning registry...");
    cleanup_profile_registry().await;
    steps.push("Registry cleaned");

    // Step 6: Recreate user
    let _ = app.emit("progress", "Creating fresh Zoom user...");
    steps.push("Creating fresh Zoom user...");

    #[cfg(windows)]
    {
        let _ = Command::new("cmd")
            .args(["/c", &format!("net user {} {} /add && net localgroup Users {} /add", ZOOM_USER, ZOOM_PASS, ZOOM_USER)])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    steps.push("User created");

    // Step 7: Initialize profile
    let _ = app.emit("progress", "Initializing user profile...");
    steps.push("Initializing user profile...");

    let psexec_path = download_psexec().await?;

    #[cfg(windows)]
    {
        let _ = Command::new(&psexec_path)
            .args(["-accepteula", "-u", ZOOM_USER, "-p", ZOOM_PASS, "-w", "C:\\", "cmd", "/c", "echo init"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

    // Step 8: Get new profile path
    let new_zoom_profile = find_zoom_user_profile().await.unwrap_or_else(|| format!("C:\\Users\\{}", ZOOM_USER));
    steps.push(&format!("Profile initialized at: {}", new_zoom_profile));

    // Step 9: Create folder links
    let _ = app.emit("progress", "Creating folder links...");
    steps.push("Creating folder links...");
    junction_link_all_zoom_profiles(&main_user).await;
    steps.push("Folder links created");

    // Step 10: Launch Zoom
    let _ = app.emit("progress", "Launching Zoom...");
    steps.push("Launching Zoom...");

    let zoom_path = find_zoom_executable()?;

    #[cfg(windows)]
    {
        Command::new(&psexec_path)
            .args(["-accepteula", "-u", ZOOM_USER, "-p", ZOOM_PASS, "-i", "-h", &zoom_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    steps.push("Zoom launched with fresh identity");

    Ok(serde_json::json!({
        "success": true,
        "steps": steps
    }))
}

/// Find actual Zoom user profile folder
#[cfg(windows)]
async fn find_zoom_user_profile() -> Option<String> {
    let script = format!(
        r#"
        # First try registry
        $user = Get-LocalUser -Name '{}' -ErrorAction SilentlyContinue
        if ($user) {{
            $sid = $user.SID.Value
            $regPath = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -ErrorAction SilentlyContinue).ProfileImagePath
            if ($regPath -and (Test-Path $regPath)) {{
                Write-Output $regPath
                return
            }}
        }}
        # Fall back to scanning C:\Users
        $folders = Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | Where-Object {{ $_.Name -like '{}*' }} | Sort-Object LastWriteTime -Descending
        if ($folders.Count -gt 0) {{
            Write-Output $folders[0].FullName
        }} else {{
            Write-Output ""
        }}
        "#,
        ZOOM_USER, ZOOM_USER
    );

    let output = Command::new("powershell")
        .args(["-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() { None } else { Some(stdout) }
}

#[cfg(not(windows))]
async fn find_zoom_user_profile() -> Option<String> {
    None
}

/// Create junction links for all Zoom user profile folders
#[cfg(windows)]
async fn junction_link_all_zoom_profiles(main_user: &str) -> Option<Vec<String>> {
    let main_profile = format!("C:\\Users\\{}", main_user);
    let script = format!(
        r#"
        $mainProfile = '{}'
        $foldersToLink = @('Documents', 'Downloads', 'Desktop', 'Pictures', 'Videos', 'Music')
        $results = @()

        Get-ChildItem 'C:\Users' -Directory | Where-Object {{ $_.Name -like '{}*' }} | ForEach-Object {{
            $profilePath = $_.FullName
            $profileName = $_.Name
            $results += "Processing profile: $profileName at $profilePath"

            foreach ($folder in $foldersToLink) {{
                $targetPath = Join-Path $profilePath $folder
                $sourcePath = Join-Path $mainProfile $folder

                if (Test-Path $targetPath) {{
                    $item = Get-Item $targetPath -Force
                    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{
                        $results += "  SKIP $folder (already junction)"
                        continue
                    }}
                }}

                if (Test-Path $targetPath) {{
                    Remove-Item $targetPath -Recurse -Force -ErrorAction SilentlyContinue
                }}
                cmd /c mklink /J "$targetPath" "$sourcePath" 2>&1 | Out-Null
                if (Test-Path $targetPath) {{
                    $results += "  LINKED $folder -> $sourcePath"
                }} else {{
                    $results += "  FAILED $folder"
                }}
            }}
        }}

        $results -join '|'
        "#,
        main_profile, ZOOM_USER
    );

    let output = Command::new("powershell")
        .args(["-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let links: Vec<String> = stdout
        .split('|')
        .filter(|s| s.contains("LINKED"))
        .map(|s| s.trim().to_string())
        .collect();

    Some(links)
}

#[cfg(not(windows))]
async fn junction_link_all_zoom_profiles(_main_user: &str) -> Option<Vec<String>> {
    None
}

/// Clean up stale Zoom profile folders
#[cfg(windows)]
async fn cleanup_stale_zoom_profiles() {
    let script = format!(
        r#"
        Get-ChildItem 'C:\Users' -Directory | Where-Object {{ $_.Name -like '{}*' }} | ForEach-Object {{
            $folder = $_.FullName
            @('Documents','Downloads','Desktop','Pictures','Videos','Music') | ForEach-Object {{
                $jPath = Join-Path $folder $_
                if (Test-Path $jPath) {{ cmd /c rmdir "$jPath" 2>$null }}
            }}
            Remove-Item $folder -Recurse -Force -ErrorAction SilentlyContinue
        }}
        "#,
        ZOOM_USER
    );

    let _ = Command::new("powershell")
        .args(["-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn cleanup_stale_zoom_profiles() {}

/// Clean up profile list registry entries
#[cfg(windows)]
async fn cleanup_profile_registry() {
    let script = format!(
        r#"
        Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList" | ForEach-Object {{
            $path = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ProfileImagePath
            if ($path -like '*\{}' -or $path -like '*\{}.*') {{
                Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            }}
        }}
        "#,
        ZOOM_USER, ZOOM_USER
    );

    let _ = Command::new("powershell")
        .args(["-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn cleanup_profile_registry() {}
