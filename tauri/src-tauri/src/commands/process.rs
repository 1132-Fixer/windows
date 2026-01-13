use std::process::Command;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Complete list of all Zoom-related processes
const ZOOM_PROCESSES: &[&str] = &[
    // Main Zoom Workplace processes
    "Zoom.exe",
    "Zoomus.exe",
    "Zoom_launcher.exe",
    "ZoomHybridConf.exe",
    "zSafeChecker.exe",
    // Screen sharing / Companion processes
    "CptHost.exe",
    "CptService.exe",
    "CptControl.exe",
    "CptInstall.exe",
    // SDK renamed variants
    "zcscpthost.exe",
    "zCSCptService.exe",
    "zcsairhost.exe",
    // Audio/Video optimization
    "aomhost.exe",
    "aomhost64.exe",
    "airhost.exe",
    // Crash reporting
    "zCrashReport.exe",
    "zCrashReport64.exe",
    // Outlook integration
    "ZoomOutlookIMPlugin.exe",
    "ZoomOutlookMAPI.exe",
    "ZoomOutlookMAPI64.exe",
    // Document/Media processing
    "ZoomDocConverter.exe",
    "zTscoder.exe",
    // Updater/Installer
    "zUpdater.exe",
    "ZoomInstaller.exe",
    "Installer.exe",
    // Web/CEF components
    "ZoomWebHost.exe",
    "zWebview2Agent.exe",
    "zCefAgent.exe",
    "msedgewebview2.exe",
    // SDK/Messenger
    "ZoomSDKMessenger.exe",
    // Zoom Rooms processes
    "ZoomRooms.exe",
    "zrshell.exe",
    "Controller.exe",
    "DigitalSignage.exe",
    "zrairhost.exe",
    "zrcpthost.exe",
    "bcairhost.exe",
    "conmon_server.exe",
    "mDNSResponder.exe",
    "ptp.exe",
    "ZAAPI.exe",
    "zCECHelper.exe",
    "zJob.exe",
    "zPrinterAgent.exe",
    "ZR3rdHW.exe",
    "zrusplayer.exe",
    "apec3.exe",
    "notification_helper.exe",
    // VDI processes
    "ZoomVDITool.exe",
    "zWspExtension.exe",
    "ZoomVDIPluginManagement.exe",
];

/// Kill all Zoom processes
#[tauri::command]
pub async fn kill_zoom_processes(app: AppHandle) -> Result<bool, String> {
    let _ = app.emit("progress", "Stopping Zoom services...");

    // Stop services first
    let services = ["Zoom Sharing Service", "CptService", "ZoomCptService", "zCSCptService", "ZoomRooms"];
    for service in services {
        stop_service(service).await;
    }

    // Run kill sequence 3 times for thorough cleanup
    for pass in 0..3 {
        let _ = app.emit("progress", format!("Killing processes (pass {}/3)...", pass + 1));

        // Use taskkill for each process
        for proc in ZOOM_PROCESSES {
            taskkill_process(proc).await;
            taskkill_process_tree(proc).await;
        }

        // PowerShell verification - kill any process with zoom/cpt/zr/aom in name
        powershell_kill_zoom().await;

        // WMIC cleanup
        wmic_kill_zoom().await;

        // Brief delay between passes
        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
    }

    // Final verification pass
    for _ in 0..3 {
        let result = final_verification_kill().await;
        if result {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    Ok(true)
}

#[cfg(windows)]
async fn stop_service(service: &str) {
    let _ = Command::new("net")
        .args(["stop", service])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let _ = Command::new("sc")
        .args(["stop", service])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn stop_service(_service: &str) {}

#[cfg(windows)]
async fn taskkill_process(process: &str) {
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", process])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn taskkill_process(_process: &str) {}

#[cfg(windows)]
async fn taskkill_process_tree(process: &str) {
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/IM", process])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn taskkill_process_tree(_process: &str) {}

#[cfg(windows)]
async fn powershell_kill_zoom() {
    let script = r#"
        $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or
            $_.Name -like '*cpt*' -or $_.Name -like '*Cpt*' -or
            $_.Name -like 'zr*' -or $_.Name -like 'ZR*' -or
            $_.Name -like 'aom*' -or $_.Name -like 'z[A-Z]*'
        }
        if ($procs) { $procs | Stop-Process -Force -ErrorAction SilentlyContinue }
    "#;

    let _ = Command::new("powershell")
        .args(["-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn powershell_kill_zoom() {}

#[cfg(windows)]
async fn wmic_kill_zoom() {
    let _ = Command::new("wmic")
        .args([
            "process",
            "where",
            "name like '%zoom%' or name like '%Zoom%' or name like '%cpt%' or name like '%Cpt%' or name like 'zr%' or name like 'ZR%' or name like 'aom%'",
            "delete",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
async fn wmic_kill_zoom() {}

#[cfg(windows)]
async fn final_verification_kill() -> bool {
    let process_names: Vec<String> = ZOOM_PROCESSES
        .iter()
        .map(|p| format!("'{}'", p.replace(".exe", "")))
        .collect();
    let names_list = process_names.join(",");

    let script = format!(
        r#"
        $zoomProcs = @({})
        $running = Get-Process -Name $zoomProcs -ErrorAction SilentlyContinue
        if ($running) {{
            $running | Stop-Process -Force -ErrorAction SilentlyContinue
            Write-Output 'KILLED'
        }} else {{
            Write-Output 'CLEAR'
        }}
        "#,
        names_list
    );

    let output = Command::new("powershell")
        .args(["-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout.trim() == "CLEAR"
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
async fn final_verification_kill() -> bool {
    true
}
