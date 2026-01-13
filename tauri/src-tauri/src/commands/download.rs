use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, ipc::Channel};
use serde::Serialize;

const ZOOM_INSTALLER_URL: &str = "https://zoom.us/client/latest/ZoomInstallerFull.msi";
const PSEXEC_URL: &str = "https://live.sysinternals.com/PsExec64.exe";

/// Download progress data
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percentage: u8,
}

/// Download Zoom installer with progress reporting via channel
#[tauri::command]
pub async fn download_zoom_installer(
    app: AppHandle,
    on_progress: Channel<DownloadProgress>,
) -> Result<String, String> {
    download_zoom_installer_with_progress(app, move |progress| {
        let _ = on_progress.send(progress);
    }).await
}

/// Download Zoom installer with a callback for progress
pub async fn download_zoom_installer_with_progress<F>(
    app: AppHandle,
    progress_callback: F,
) -> Result<String, String>
where
    F: Fn(DownloadProgress) + Send + 'static,
{
    let temp_dir = env::temp_dir();
    let dest_path = temp_dir.join("ZoomInstallerFull.msi");

    // Remove existing installer
    if dest_path.exists() {
        let _ = std::fs::remove_file(&dest_path);
    }

    let _ = app.emit("progress", "Starting download...");

    download_file_with_progress(ZOOM_INSTALLER_URL, &dest_path, progress_callback).await?;

    Ok(dest_path.to_string_lossy().to_string())
}

/// Download PsExec utility
pub async fn download_psexec() -> Result<String, String> {
    let temp_dir = env::temp_dir();
    let psexec_path = temp_dir.join("PsExec64.exe");

    // Return cached if exists
    if psexec_path.exists() {
        return Ok(psexec_path.to_string_lossy().to_string());
    }

    download_file_with_progress(PSEXEC_URL, &psexec_path, |_| {}).await?;

    Ok(psexec_path.to_string_lossy().to_string())
}

/// Generic file download with progress
async fn download_file_with_progress<F>(
    url: &str,
    dest_path: &PathBuf,
    progress_callback: F,
) -> Result<(), String>
where
    F: Fn(DownloadProgress),
{
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let mut file = File::create(dest_path).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        let percentage = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0) as u8
        } else {
            0
        };

        progress_callback(DownloadProgress {
            downloaded,
            total: total_size,
            percentage,
        });
    }

    Ok(())
}
