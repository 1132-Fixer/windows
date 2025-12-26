const fileList = document.getElementById('fileList');
const createUserBtn = document.getElementById('createUserBtn');
const launchBtn = document.getElementById('launchBtn');
const resetBtn = document.getElementById('resetBtn');
const fullResetBtn = document.getElementById('fullResetBtn');
const quickResetBtn = document.getElementById('quickResetBtn');
const statusText = document.getElementById('statusText');

// Check zoom user status on load
window.addEventListener('DOMContentLoaded', () => {
  checkUserStatus();
  setupResetProgressListener();
});

// Setup listener for reset progress updates
function setupResetProgressListener() {
  window.electronAPI.onResetProgress((data) => {
    updateResetProgress(data);
  });
}

// Update the UI with reset progress
function updateResetProgress(data) {
  clearFileList();
  addFileItem('=== FULL RESET & REINSTALL ===', 'header');
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
  const doneSteps = data.steps.filter(s => s.status === 'done').length;
  const totalSteps = 11;
  const progress = Math.round((doneSteps / totalSteps) * 100);
  updateStatus(`Progress: ${progress}%`, 'loading');

  if (data.complete) {
    addFileItem('', '');
    addFileItem('=== COMPLETE ===', 'header');
    addFileItem('Zoom has been reset and reinstalled!', 'success');
    updateStatus('Reset complete!', 'success');
    fullResetBtn.textContent = 'FULL RESET & REINSTALL';
    fullResetBtn.disabled = false;
  }
}

// Quick Reset & Reinstall button (current account, no user management)
quickResetBtn.addEventListener('click', async () => {
  const confirmed = confirm(
    'QUICK RESET & REINSTALL\n\n' +
    'This will:\n' +
    '1. Kill all Zoom processes\n' +
    '2. Completely uninstall Zoom\n' +
    '3. Delete ALL Zoom data (all users)\n' +
    '4. Clean registry, services, tasks\n' +
    '5. Download fresh Zoom installer\n' +
    '6. Reinstall Zoom\n\n' +
    'No Windows user accounts will be created or deleted.\n\n' +
    'Continue?'
  );

  if (!confirmed) return;

  disableAllButtons();
  quickResetBtn.textContent = 'RESETTING...';
  updateStatus('Starting quick reset...', 'loading');

  clearFileList();
  addFileItem('=== QUICK RESET & REINSTALL ===', 'header');
  addFileItem('', '');
  addFileItem('Starting...', 'loading');

  try {
    const result = await window.electronAPI.quickResetReinstall();

    if (result.success) {
      addFileItem('', '');
      addFileItem('=== SUCCESS ===', 'header');
      addFileItem(result.message, 'success');
      updateStatus('Zoom reset complete!', 'success');
    } else {
      addFileItem('', '');
      addFileItem('=== FAILED ===', 'header');
      addFileItem(`Error: ${result.error}`, 'error');
      updateStatus('Reset failed', 'error');
    }
  } catch (err) {
    addFileItem('', '');
    addFileItem('=== ERROR ===', 'header');
    addFileItem(`Error: ${err.message}`, 'error');
    updateStatus('Reset failed', 'error');
  }

  quickResetBtn.textContent = 'QUICK RESET & REINSTALL';
  enableAllButtons();
  checkUserStatus();
});

// Full Reset & Reinstall button (with user management)
fullResetBtn.addEventListener('click', async () => {
  const confirmed = confirm(
    'FULL RESET (WITH USER)\n\n' +
    'This will:\n' +
    '1. Kill all Zoom processes\n' +
    '2. Completely uninstall Zoom\n' +
    '3. Delete ALL Zoom data (all users)\n' +
    '4. Clean registry, services, tasks\n' +
    '5. Download fresh Zoom installer\n' +
    '6. Reinstall Zoom\n' +
    '7. Create/reset Zoom user account\n\n' +
    'Continue?'
  );

  if (!confirmed) return;

  disableAllButtons();
  fullResetBtn.textContent = 'RESETTING...';
  updateStatus('Starting full reset...', 'loading');

  clearFileList();
  addFileItem('=== FULL RESET (WITH USER) ===', 'header');
  addFileItem('', '');
  addFileItem('Starting...', 'loading');

  try {
    const result = await window.electronAPI.fullResetReinstall();

    if (result.success) {
      addFileItem('', '');
      addFileItem('=== SUCCESS ===', 'header');
      addFileItem(result.message, 'success');
      updateStatus('Zoom reset complete!', 'success');
    } else {
      addFileItem('', '');
      addFileItem('=== FAILED ===', 'header');
      addFileItem(`Error: ${result.error}`, 'error');
      updateStatus('Reset failed', 'error');
    }
  } catch (err) {
    addFileItem('', '');
    addFileItem('=== ERROR ===', 'header');
    addFileItem(`Error: ${err.message}`, 'error');
    updateStatus('Reset failed', 'error');
  }

  fullResetBtn.textContent = 'FULL RESET (WITH USER)';
  enableAllButtons();
  checkUserStatus();
});

// Helper to disable all buttons during operation
function disableAllButtons() {
  quickResetBtn.disabled = true;
  fullResetBtn.disabled = true;
  createUserBtn.disabled = true;
  launchBtn.disabled = true;
  resetBtn.disabled = true;
}

// Helper to enable buttons after operation
function enableAllButtons() {
  quickResetBtn.disabled = false;
  fullResetBtn.disabled = false;
  // createUserBtn, launchBtn, resetBtn will be set by checkUserStatus()
}

// Check if zoom user exists
async function checkUserStatus() {
  clearFileList();
  addFileItem('Checking zoom user status...', 'loading');

  const result = await window.electronAPI.checkZoomUser();

  clearFileList();
  if (result.exists) {
    addFileItem('Zoom user exists', 'success');
    addFileItem(`  Profile: ${result.profilePath || 'Not created yet'}`, '');
    if (result.sid) {
      addFileItem(`  SID: ${result.sid}`, '');
    }
    createUserBtn.textContent = 'USER EXISTS';
    createUserBtn.disabled = true;
    launchBtn.disabled = false;
    resetBtn.disabled = false;
  } else {
    addFileItem('Zoom user does not exist', 'error');
    addFileItem('  Click "CREATE ZOOM USER" to create it', '');
    createUserBtn.textContent = 'CREATE ZOOM USER';
    createUserBtn.disabled = false;
    launchBtn.disabled = true;
    resetBtn.disabled = true;
  }
}

// Create zoom user button
createUserBtn.addEventListener('click', async () => {
  createUserBtn.disabled = true;
  createUserBtn.textContent = 'CREATING...';
  updateStatus('Creating zoom user...', 'loading');

  clearFileList();
  addFileItem('Creating Windows user "zoom"...', 'loading');

  const result = await window.electronAPI.createZoomUser();

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
    launchBtn.disabled = false;
    resetBtn.disabled = false;
  } else {
    addFileItem('Failed to create user', 'error');
    addFileItem(`  Error: ${result.error}`, 'error');
    updateStatus('Failed to create user', 'error');
    createUserBtn.textContent = 'CREATE ZOOM USER';
    createUserBtn.disabled = false;
  }
});

// Launch Zoom as zoom user
launchBtn.addEventListener('click', async () => {
  launchBtn.disabled = true;
  launchBtn.textContent = 'LAUNCHING...';
  updateStatus('Launching Zoom as zoom user...', 'loading');

  clearFileList();
  addFileItem('Launching Zoom as "zoom" user...', 'loading');

  const result = await window.electronAPI.launchZoomAsUser();

  clearFileList();
  if (result.success) {
    addFileItem('Zoom launched as zoom user', 'success');
    updateStatus('Closing app in 2 seconds...', 'success');
    // Close app after successful launch
    setTimeout(() => {
      window.electronAPI.quitApp();
    }, 2000);
  } else {
    addFileItem('Failed to launch Zoom', 'error');
    addFileItem(`  Error: ${result.error}`, 'error');
    updateStatus('Failed to launch Zoom', 'error');
    launchBtn.textContent = 'LAUNCH ZOOM AS USER';
    launchBtn.disabled = false;
  }
});

// Reset zoom user (delete profile, recreate, launch)
resetBtn.addEventListener('click', async () => {
  resetBtn.disabled = true;
  resetBtn.textContent = 'RESETTING...';
  updateStatus('Resetting zoom user profile...', 'loading');

  clearFileList();
  addFileItem('=== RESETTING ZOOM USER ===', 'header');

  const result = await window.electronAPI.resetZoomUser();

  clearFileList();
  if (result.success) {
    addFileItem('=== RESET COMPLETE ===', 'header');
    for (const step of result.steps || []) {
      addFileItem(`  ${step}`, 'success');
    }
    addFileItem('', '');
    addFileItem('Zoom launched with fresh profile!', 'success');
    updateStatus('Closing app in 2 seconds...', 'success');
    // Close app after successful reset and launch
    setTimeout(() => {
      window.electronAPI.quitApp();
    }, 2000);
  } else {
    addFileItem('=== RESET FAILED ===', 'header');
    addFileItem(`  ${result.error}`, 'error');
    updateStatus('Reset failed', 'error');
    resetBtn.textContent = 'RESET & RELAUNCH';
    resetBtn.disabled = false;
  }
});

// Helper functions
function updateStatus(text, type) {
  statusText.textContent = text;
  statusText.className = `status-text ${type}`;
}

function clearFileList() {
  fileList.innerHTML = '';
}

function addFileItem(text, className = '') {
  const div = document.createElement('div');
  div.className = `file-item ${className}`;
  div.textContent = text;
  fileList.appendChild(div);
  fileList.scrollTop = fileList.scrollHeight;
}
