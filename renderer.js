let foundFiles = [];
let hasDeletedFiles = false;

const fileList = document.getElementById('fileList');
const deleteBtn = document.getElementById('deleteBtn');
const refreshBtn = document.getElementById('refreshBtn');

window.addEventListener('DOMContentLoaded', () => {
  scanFiles();

  // Exit button
  document.getElementById('btnExit').addEventListener('click', () => {
    window.electronAPI.quitApp();
  });

  // Refresh button
  refreshBtn.addEventListener('click', () => scanFiles());

  // Delete button
  deleteBtn.addEventListener('click', async () => {
    if (foundFiles.length === 0) return;

    const confirmed = await window.electronAPI.showConfirmDialog(
      `Delete ${foundFiles.length} database files?\n\nThis cannot be undone!`
    );
    if (!confirmed) return;

    await deleteFiles();
  });
});

async function scanFiles() {
  clearFileList();
  addFileItem('Scanning for database files...', 'loading');
  deleteBtn.disabled = true;
  setStatus('scanning', 'Scanning');

  const result = await window.electronAPI.scanFiles();

  clearFileList();

  if (!result.success) {
    addFileItem('ERROR: NO ZOOM DATA FOLDER FOUND!', 'error');
    addFileItem('Is Zoom installed?', 'error');
    foundFiles = [];
    setStatus('', 'Ready');
    return;
  }

  for (const dir of result.directories) {
    addFileItem(`Scanning \u2192 ${dir}`, 'header');
  }
  addEmptyLine();

  if (result.files.length === 0) {
    addFileItem('NO DATABASE FILES FOUND', 'header');
    addEmptyLine();
    addFileItem('\u2192 Either already clean', '');
    addFileItem('\u2192 Or Zoom is running (close it first!)', '');
    addFileItem('\u2192 Or files are locked', '');
    foundFiles = [];
    deleteBtn.disabled = true;
    setStatus('done', 'Clean');
  } else {
    addFileItem(`FOUND ${result.files.length} DATABASE FILES`, 'header');
    addEmptyLine();

    for (const file of result.files) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      addFileItem(`${file.path}  (${sizeMB} MB)`, '');
    }

    foundFiles = result.files;
    deleteBtn.disabled = false;
    setStatus('', 'Ready');
  }
}

async function deleteFiles() {
  const filePaths = foundFiles.map(f => f.path);

  setStatus('scanning', 'Deleting');
  addEmptyLine();
  addFileItem('STARTING DELETION...', 'header');
  addEmptyLine();

  const result = await window.electronAPI.deleteFiles(filePaths);

  for (const res of result.results) {
    const className = res.success ? 'success' : 'failed';
    addFileItem(res.message, className);
  }

  addEmptyLine();
  addFileItem(`ELIMINATION COMPLETE: ${result.deletedCount} files destroyed`, 'header');

  if (result.deletedCount > 0) {
    hasDeletedFiles = true;
    foundFiles = [];
    deleteBtn.disabled = true;
    setStatus('done', 'Done');

    await window.electronAPI.showSuccess(result.deletedCount);
    await window.electronAPI.launchZoom();
  }
}

function setStatus(className, text) {
  const badge = document.getElementById('statusBadge');
  badge.className = 'status-badge' + (className ? ' ' + className : '');
  document.getElementById('statusBadgeText').textContent = text;
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

function addEmptyLine() {
  const div = document.createElement('div');
  div.className = 'file-item empty-line';
  div.innerHTML = '&nbsp;';
  fileList.appendChild(div);
}
