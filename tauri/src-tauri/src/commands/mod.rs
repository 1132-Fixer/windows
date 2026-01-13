pub mod process;
pub mod filesystem;
pub mod registry;
pub mod services;
pub mod tasks;
pub mod download;
pub mod install;
pub mod user_management;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Reset options from frontend
#[derive(Debug, Clone, Deserialize)]
pub struct ResetOptions {
    pub uninstall: bool,
    pub reinstall: bool,
}

/// Progress step status
#[derive(Debug, Clone, Serialize)]
pub struct ResetStep {
    pub step: String,
    pub status: String, // "pending", "running", "done", "skipped"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
}

/// Progress update payload
#[derive(Debug, Clone, Serialize)]
pub struct ResetProgress {
    pub steps: Vec<ResetStep>,
    #[serde(rename = "currentStep")]
    pub current_step: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
}

/// Full reset orchestration command
#[tauri::command]
pub async fn full_reset(app: AppHandle, options: ResetOptions) -> Result<serde_json::Value, String> {
    let mut steps: Vec<ResetStep> = Vec::new();
    let mut step_index = 0;

    // Helper to emit progress
    let emit_progress = |app: &AppHandle, steps: &Vec<ResetStep>, current: usize, complete: Option<bool>| {
        let progress = ResetProgress {
            steps: steps.clone(),
            current_step: current,
            complete,
        };
        let _ = app.emit("reset-progress", progress);
    };

    // Step 1: Kill Zoom processes
    steps.push(ResetStep { step: "Killing Zoom processes...".into(), status: "running".into(), progress: None });
    emit_progress(&app, &steps, step_index, None);

    process::kill_zoom_processes(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    steps[step_index].status = "done".into();
    step_index += 1;

    // Step 2: Uninstall Zoom (conditional)
    if options.uninstall {
        steps.push(ResetStep { step: "Uninstalling Zoom...".into(), status: "running".into(), progress: None });
        emit_progress(&app, &steps, step_index, None);

        install::uninstall_zoom(app.clone()).await?;
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        steps[step_index].status = "done".into();
    } else {
        steps.push(ResetStep { step: "Uninstalling Zoom...".into(), status: "skipped".into(), progress: None });
    }
    step_index += 1;

    // Step 3: Delete services
    steps.push(ResetStep { step: "Removing Zoom services...".into(), status: "running".into(), progress: None });
    emit_progress(&app, &steps, step_index, None);

    services::delete_zoom_services(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    steps[step_index].status = "done".into();
    step_index += 1;

    // Step 4: Delete scheduled tasks
    steps.push(ResetStep { step: "Removing scheduled tasks...".into(), status: "running".into(), progress: None });
    emit_progress(&app, &steps, step_index, None);

    tasks::delete_zoom_scheduled_tasks(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    steps[step_index].status = "done".into();
    step_index += 1;

    // Step 5: Delete registry
    steps.push(ResetStep { step: "Cleaning registry...".into(), status: "running".into(), progress: None });
    emit_progress(&app, &steps, step_index, None);

    registry::delete_zoom_registry(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    steps[step_index].status = "done".into();
    step_index += 1;

    // Step 6: Delete all Zoom data
    steps.push(ResetStep { step: "Deleting all Zoom data...".into(), status: "running".into(), progress: None });
    emit_progress(&app, &steps, step_index, None);

    filesystem::delete_zoom_directories(app.clone()).await?;
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    steps[step_index].status = "done".into();
    step_index += 1;

    // Step 7: Clean prefetch files
    steps.push(ResetStep { step: "Cleaning prefetch files...".into(), status: "running".into(), progress: None });
    emit_progress(&app, &steps, step_index, None);

    filesystem::clean_prefetch_files().await?;
    steps[step_index].status = "done".into();
    step_index += 1;

    // Step 8: Deep clean system traces
    steps.push(ResetStep { step: "Deep cleaning system traces...".into(), status: "running".into(), progress: None });
    emit_progress(&app, &steps, step_index, None);

    filesystem::deep_clean_system_traces().await?;
    steps[step_index].status = "done".into();
    step_index += 1;

    // Steps 9-10: Download and Install (conditional)
    if options.reinstall {
        // Download
        steps.push(ResetStep { step: "Downloading Zoom installer...".into(), status: "running".into(), progress: Some(0) });
        emit_progress(&app, &steps, step_index, None);

        let download_step_idx = step_index;
        let msi_path = download::download_zoom_installer_with_progress(app.clone(), move |progress| {
            // Note: We can't easily update steps here in async context
            // Progress will be reported via separate mechanism
        }).await?;

        steps[download_step_idx].status = "done".into();
        steps[download_step_idx].progress = Some(100);
        step_index += 1;

        // Install
        steps.push(ResetStep { step: "Installing Zoom...".into(), status: "running".into(), progress: None });
        emit_progress(&app, &steps, step_index, None);

        install::install_zoom(app.clone(), msi_path).await?;
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        steps[step_index].status = "done".into();
        step_index += 1;
    } else {
        steps.push(ResetStep { step: "Downloading Zoom installer...".into(), status: "skipped".into(), progress: None });
        steps.push(ResetStep { step: "Installing Zoom...".into(), status: "skipped".into(), progress: None });
        step_index += 2;
    }

    // Final step
    steps.push(ResetStep { step: "Finalizing...".into(), status: "done".into(), progress: None });
    emit_progress(&app, &steps, step_index, Some(true));

    let message = if options.reinstall {
        "Zoom has been reset and reinstalled!"
    } else {
        "Zoom data has been reset!"
    };

    Ok(serde_json::json!({
        "success": true,
        "message": message,
        "steps": steps.iter().map(|s| s.step.clone()).collect::<Vec<_>>()
    }))
}

/// Quit the application
#[tauri::command]
pub async fn quit_app(app: AppHandle) {
    app.exit(0);
}
