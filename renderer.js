const fileList = document.getElementById('fileList');
const createUserBtn = document.getElementById('createUserBtn');
const launchBtn = document.getElementById('launchBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('statusText');

// Check zoom user status on load
window.addEventListener('DOMContentLoaded', () => {
  checkUserStatus();
});

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
