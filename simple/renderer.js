const resetBtn = document.getElementById('resetBtn');
const progressList = document.getElementById('progressList');
const statusText = document.getElementById('statusText');

// Setup progress listener
window.addEventListener('DOMContentLoaded', () => {
  window.electronAPI.onResetProgress((data) => {
    updateProgress(data);
  });
});

// Reset button click
resetBtn.addEventListener('click', async () => {
  // Check if Zoom is installed
  const isInstalled = await window.electronAPI.checkZoomInstalled();

  let confirmed;
  if (!isInstalled) {
    // Zoom not installed - ask if they want to install it
    confirmed = confirm(
      'ZOOM NOT DETECTED\n\n' +
      'Zoom is not currently installed on this PC.\n\n' +
      'Would you like to download and install Zoom?'
    );

    if (confirmed) {
      // Just install, don't reset
      resetBtn.disabled = true;
      resetBtn.textContent = 'INSTALLING...';
      updateStatus('Installing Zoom...', 'loading');
      clearProgress();
      addStep('=== INSTALLING ZOOM ===', 'header');

      try {
        const result = await window.electronAPI.installZoomOnly();
        if (result.success) {
          addStep('Zoom installed and launched!', 'done');
          updateStatus('Complete!', 'success');
        } else {
          addStep(`Error: ${result.error}`, 'error');
          updateStatus('Failed', 'error');
        }
      } catch (err) {
        addStep(`Error: ${err.message}`, 'error');
        updateStatus('Failed', 'error');
      }

      resetBtn.disabled = false;
      resetBtn.textContent = 'RESET & REINSTALL ZOOM';
      return;
    }
    return;
  }

  // Zoom is installed - proceed with reset
  confirmed = confirm(
    'RESET & REINSTALL ZOOM\n\n' +
    'This will:\n' +
    '1. Kill all Zoom processes\n' +
    '2. Completely uninstall Zoom\n' +
    '3. Delete ALL Zoom data\n' +
    '4. Clean registry, services, tasks\n' +
    '5. Download fresh Zoom installer\n' +
    '6. Reinstall and launch Zoom\n\n' +
    'Continue?'
  );

  if (!confirmed) return;

  resetBtn.disabled = true;
  resetBtn.textContent = 'RESETTING...';
  updateStatus('Starting reset...', 'loading');

  clearProgress();
  addStep('=== RESET & REINSTALL ===', 'header');
  addStep('Starting...', 'running');

  try {
    const result = await window.electronAPI.quickResetReinstall();

    if (result.success) {
      addStep('', '');
      addStep('=== SUCCESS ===', 'header');
      addStep(result.message, 'done');
      updateStatus('Zoom reset complete! Launching...', 'success');
    } else {
      addStep('', '');
      addStep('=== FAILED ===', 'header');
      addStep(`Error: ${result.error}`, 'error');
      updateStatus('Reset failed', 'error');
      resetBtn.disabled = false;
      resetBtn.textContent = 'RESET & REINSTALL ZOOM';
    }
  } catch (err) {
    addStep('', '');
    addStep('=== ERROR ===', 'header');
    addStep(`Error: ${err.message}`, 'error');
    updateStatus('Reset failed', 'error');
    resetBtn.disabled = false;
    resetBtn.textContent = 'RESET & REINSTALL ZOOM';
  }
});

function updateProgress(data) {
  clearProgress();
  addStep('=== RESET & REINSTALL ===', 'header');
  addStep('', '');

  for (const step of data.steps) {
    let icon = '';
    let className = '';

    if (step.status === 'done') {
      icon = '[OK]';
      className = 'done';
    } else if (step.status === 'running') {
      icon = '[...]';
      className = 'running';
    } else {
      icon = '[ ]';
      className = 'pending';
    }

    let text = `${icon} ${step.step}`;
    if (step.progress !== undefined && step.status === 'running') {
      text += ` (${step.progress}%)`;
    }

    addStep(text, className);
  }

  const doneSteps = data.steps.filter(s => s.status === 'done').length;
  const totalSteps = data.steps.length;
  const progress = Math.round((doneSteps / totalSteps) * 100);
  updateStatus(`Progress: ${progress}%`, 'loading');

  if (data.complete) {
    addStep('', '');
    addStep('=== COMPLETE ===', 'header');
    addStep('Zoom has been reset and reinstalled!', 'done');
    updateStatus('Complete! Launching Zoom...', 'success');
  }
}

function updateStatus(text, type) {
  statusText.textContent = text;
  statusText.className = `status-text ${type}`;
}

function clearProgress() {
  progressList.innerHTML = '';
}

function addStep(text, className) {
  const div = document.createElement('div');
  div.className = `step-item ${className}`;
  div.textContent = text;
  progressList.appendChild(div);
  progressList.scrollTop = progressList.scrollHeight;
}
