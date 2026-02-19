import { tauriAPI, onResetProgress, type ResetProgress, type ResetOptions } from './api';

// DOM Elements
const fileList = document.getElementById('fileList') as HTMLDivElement;
const createUserBtn = document.getElementById('createUserBtn') as HTMLButtonElement;
const deleteUserBtn = document.getElementById('deleteUserBtn') as HTMLButtonElement;
const launchBtn = document.getElementById('launchBtn') as HTMLButtonElement;
const quickResetBtn = document.getElementById('quickResetBtn') as HTMLButtonElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;

// Option toggles
const optUninstall = document.getElementById('optUninstall') as HTMLInputElement;
const optReinstall = document.getElementById('optReinstall') as HTMLInputElement;

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  checkUserStatus();
  setupResetProgressListener();
});

// Setup listener for reset progress updates
async function setupResetProgressListener(): Promise<void> {
  await onResetProgress((data: ResetProgress) => {
    updateResetProgress(data);
  });
}

// Get current options from UI
function getOptions(): ResetOptions {
  return {
    uninstall: optUninstall.checked,
    reinstall: optReinstall.checked,
  };
}

// Update the UI with reset progress
function updateResetProgress(data: ResetProgress): void {
  clearFileList();
  addFileItem('=== FULL RESET ===', 'header');
  addFileItem('', '');

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    let icon = '';
    let className = '';

    if (step.status === 'done') {
      icon = '[OK]';
      className = 'success';
    } else if (step.status === 'running') {
      icon = '[...]';
      className = 'loading';
    } else if (step.status === 'skipped') {
      icon = '[--]';
      className = '';
    } else {
      icon = '[ ]';
      className = '';
    }

    let text = `${icon} ${step.step}`;
    if (step.progress !== undefined && step.status === 'running') {
      text += ` (${step.progress}%)`;
    }

    addFileItem(text, className);
  }

  // Calculate overall progress
  const doneSteps = data.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const totalSteps = data.steps.length;
  const progress = Math.round((doneSteps / totalSteps) * 100);
  updateStatus(`Progress: ${progress}%`, 'loading');

  if (data.complete) {
    addFileItem('', '');
    addFileItem('=== COMPLETE ===', 'header');
    addFileItem('Reset complete!', 'success');
    updateStatus('Reset complete!', 'success');
    quickResetBtn.textContent = 'FULL RESET (NO USER CHANGE)';
    quickResetBtn.disabled = false;
  }
}

// Full Reset button (with options)
quickResetBtn.addEventListener('click', async () => {
  const options = getOptions();

  let message = 'FULL RESET\n\nThis will:\n';
  message += '1. Kill all Zoom processes\n';
  if (options.uninstall) {
    message += '2. Completely uninstall Zoom\n';
  }
  message += '3. Delete ALL Zoom data (all users)\n';
  message += '4. Clean registry, services, tasks\n';
  if (options.reinstall) {
    message += '5. Download fresh Zoom installer\n';
    message += '6. Reinstall Zoom\n';
  }
  message += '\nNo Windows user accounts will be changed.\n\nContinue?';

  const confirmed = confirm(message);
  if (!confirmed) return;

  disableAllButtons();
  quickResetBtn.textContent = 'RESETTING...';
  updateStatus('Starting reset...', 'loading');

  clearFileList();
  addFileItem('=== FULL RESET ===', 'header');
  addFileItem('', '');
  addFileItem('Starting...', 'loading');

  try {
    const result = await tauriAPI.fullReset(options);

    if (result.success) {
      addFileItem('', '');
      addFileItem('=== SUCCESS ===', 'header');
      addFileItem(result.message, 'success');
      updateStatus('Reset complete!', 'success');
    } else {
      addFileItem('', '');
      addFileItem('=== FAILED ===', 'header');
      addFileItem(`Error: ${result.error}`, 'error');
      updateStatus('Reset failed', 'error');
    }
  } catch (err) {
    addFileItem('', '');
    addFileItem('=== ERROR ===', 'header');
    addFileItem(`Error: ${err}`, 'error');
    updateStatus('Reset failed', 'error');
  }

  quickResetBtn.textContent = 'FULL RESET (NO USER CHANGE)';
  enableAllButtons();
  checkUserStatus();
});

// Helper to disable all buttons during operation
function disableAllButtons(): void {
  quickResetBtn.disabled = true;
  createUserBtn.disabled = true;
  deleteUserBtn.disabled = true;
  launchBtn.disabled = true;
}

// Helper to enable buttons after operation
function enableAllButtons(): void {
  quickResetBtn.disabled = false;
  // createUserBtn, deleteUserBtn, launchBtn will be set by checkUserStatus()
}

// Check if zoom user exists
async function checkUserStatus(): Promise<void> {
  const result = await tauriAPI.checkZoomUser();

  if (result.exists) {
    createUserBtn.textContent = 'USER EXISTS';
    createUserBtn.disabled = true;
    deleteUserBtn.disabled = false;
    launchBtn.disabled = false;
  } else {
    createUserBtn.textContent = 'CREATE ZOOM USER';
    createUserBtn.disabled = false;
    deleteUserBtn.disabled = true;
    launchBtn.disabled = true;
  }
}

// Create zoom user button
createUserBtn.addEventListener('click', async () => {
  createUserBtn.disabled = true;
  createUserBtn.textContent = 'CREATING...';
  updateStatus('Creating zoom user...', 'loading');

  clearFileList();
  addFileItem('Creating Windows user "Zoom"...', 'loading');

  try {
    const result = await tauriAPI.createZoomUser();

    clearFileList();
    if (result.success) {
      addFileItem('User created successfully', 'success');
      if (result.junctions && result.junctions.length > 0) {
        addFileItem('', '');
        addFileItem('Junction links created:', 'header');
        for (const j of result.junctions) {
          addFileItem(`  ${j}`, 'success');
        }
      }
      updateStatus('Zoom user created! Click LAUNCH to run Zoom.', 'success');
      createUserBtn.textContent = 'USER EXISTS';
      deleteUserBtn.disabled = false;
      launchBtn.disabled = false;
    } else {
      addFileItem('Failed to create user', 'error');
      addFileItem(`  Error: ${result.error}`, 'error');
      updateStatus('Failed to create user', 'error');
      createUserBtn.textContent = 'CREATE ZOOM USER';
      createUserBtn.disabled = false;
    }
  } catch (err) {
    clearFileList();
    addFileItem('Failed to create user', 'error');
    addFileItem(`  Error: ${err}`, 'error');
    updateStatus('Failed to create user', 'error');
    createUserBtn.textContent = 'CREATE ZOOM USER';
    createUserBtn.disabled = false;
  }
});

// Delete zoom user button
deleteUserBtn.addEventListener('click', async () => {
  const confirmed = confirm(
    'DELETE ZOOM USER\n\n' +
    'This will delete the "Zoom" Windows user account and all its data.\n\n' +
    'Continue?'
  );
  if (!confirmed) return;

  deleteUserBtn.disabled = true;
  deleteUserBtn.textContent = 'DELETING...';
  updateStatus('Deleting zoom user...', 'loading');

  clearFileList();
  addFileItem('Deleting Windows user "Zoom"...', 'loading');

  try {
    const result = await tauriAPI.deleteZoomUser();

    clearFileList();
    if (result.success) {
      addFileItem('User deleted successfully', 'success');
      updateStatus('Zoom user deleted.', 'success');
      createUserBtn.textContent = 'CREATE ZOOM USER';
      createUserBtn.disabled = false;
      deleteUserBtn.textContent = 'DELETE ZOOM USER';
      deleteUserBtn.disabled = true;
      launchBtn.disabled = true;
    } else {
      addFileItem('Failed to delete user', 'error');
      addFileItem(`  Error: ${result.error}`, 'error');
      updateStatus('Failed to delete user', 'error');
      deleteUserBtn.textContent = 'DELETE ZOOM USER';
      deleteUserBtn.disabled = false;
    }
  } catch (err) {
    clearFileList();
    addFileItem('Failed to delete user', 'error');
    addFileItem(`  Error: ${err}`, 'error');
    updateStatus('Failed to delete user', 'error');
    deleteUserBtn.textContent = 'DELETE ZOOM USER';
    deleteUserBtn.disabled = false;
  }
});

// Launch Zoom as zoom user
launchBtn.addEventListener('click', async () => {
  launchBtn.disabled = true;
  launchBtn.textContent = 'LAUNCHING...';
  updateStatus('Launching Zoom as Zoom user...', 'loading');

  clearFileList();
  addFileItem('Launching Zoom as "Zoom" user...', 'loading');

  try {
    const result = await tauriAPI.launchZoomAsUser();

    clearFileList();
    if (result.success) {
      addFileItem('Zoom launched as Zoom user', 'success');
      updateStatus('Closing app in 2 seconds...', 'success');
      // Close app after successful launch
      setTimeout(() => {
        tauriAPI.quitApp();
      }, 2000);
    } else {
      addFileItem('Failed to launch Zoom', 'error');
      addFileItem(`  Error: ${result.error}`, 'error');
      updateStatus('Failed to launch Zoom', 'error');
      launchBtn.textContent = 'LAUNCH ZOOM AS USER';
      launchBtn.disabled = false;
    }
  } catch (err) {
    clearFileList();
    addFileItem('Failed to launch Zoom', 'error');
    addFileItem(`  Error: ${err}`, 'error');
    updateStatus('Failed to launch Zoom', 'error');
    launchBtn.textContent = 'LAUNCH ZOOM AS USER';
    launchBtn.disabled = false;
  }
});

// Helper functions
function updateStatus(text: string, type: string): void {
  statusText.textContent = text;
  statusText.className = `status-text ${type}`;
}

function clearFileList(): void {
  fileList.innerHTML = '';
}

function addFileItem(text: string, className: string = ''): void {
  const div = document.createElement('div');
  div.className = `file-item ${className}`;
  div.textContent = text;
  fileList.appendChild(div);
  fileList.scrollTop = fileList.scrollHeight;
}
