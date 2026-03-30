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

// ===== FEEDBACK MODAL =====
const ratings = { ease: 0, resolved: 0, recommend: 0, overall: 0 };
let feedbackMode = '';

function showSection(id) {
  document.querySelectorAll('.fb-section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function openFeedback() {
  document.getElementById('fbOverlay').classList.add('show');
  showSection('fbChoose');
  feedbackMode = '';
  // Reset forms
  document.querySelectorAll('.fb-textarea').forEach(t => { t.value = ''; });
  document.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('.fb-status').forEach(s => { s.textContent = ''; s.className = 'fb-status'; });
  Object.keys(ratings).forEach(k => { ratings[k] = 0; });
  // Load system info for bug reports
  loadSysInfo();
}

function closeFeedback() {
  document.getElementById('fbOverlay').classList.remove('show');
}

async function loadSysInfo() {
  try {
    const info = await window.electronAPI.getSystemInfo();
    const el = document.getElementById('fbSysInfo');
    el.textContent = `Version: ${info.version}\nOS: ${info.os}\nAdmin: ${info.admin ? 'Yes' : 'No'}`;
  } catch (_) {
    document.getElementById('fbSysInfo').textContent = 'Could not load system info';
  }
}

// Version display
(async () => {
  try {
    const v = await window.electronAPI.getVersion();
    document.getElementById('appVersion').textContent = 'v' + v;
  } catch (_) {}
})();

// Feedback button
document.getElementById('btnFeedback').addEventListener('click', openFeedback);

// Close/cancel buttons
['fbClose', 'fbBugCancel', 'fbRatingCancel', 'fbContactCancel'].forEach(id => {
  document.getElementById(id).addEventListener('click', closeFeedback);
});

// Back buttons
['fbBugBack', 'fbRatingBack', 'fbContactBack'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => showSection('fbChoose'));
});

// Category choices
document.querySelectorAll('.fb-choice').forEach(el => {
  el.addEventListener('click', () => {
    feedbackMode = el.dataset.mode;
    if (feedbackMode === 'bug') showSection('fbBug');
    else if (feedbackMode === 'rating') showSection('fbRating');
    else if (feedbackMode === 'contact') showSection('fbContact');
  });
});

// Rating buttons
document.querySelectorAll('.fb-rating-btns').forEach(group => {
  const cat = group.dataset.cat;
  group.querySelectorAll('.fb-rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ratings[cat] = parseInt(btn.dataset.val);
      group.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Enable submit if at least one rating
      const filled = Object.values(ratings).filter(v => v > 0).length;
      document.getElementById('fbRatingSubmit').disabled = filled === 0;
    });
  });
});

// Text validation for bug/contact
['fbBugText', 'fbContactText'].forEach(id => {
  const submitId = id === 'fbBugText' ? 'fbBugSubmit' : 'fbContactSubmit';
  document.getElementById(id).addEventListener('input', (e) => {
    document.getElementById(submitId).disabled = e.target.value.trim().length < 50;
  });
});

// Submit handlers
document.getElementById('fbBugSubmit').addEventListener('click', async () => {
  const text = document.getElementById('fbBugText').value.trim();
  const sysInfo = document.getElementById('fbSysInfo').textContent;
  const body = `${text}\n\n---\n**System Info**\n${sysInfo.split('\n').map(l => '- ' + l).join('\n')}`;
  await submitFeedback('Bug Report', body, 'fbBugStatus');
});

document.getElementById('fbRatingSubmit').addEventListener('click', async () => {
  const filled = Object.entries(ratings).filter(([,v]) => v > 0);
  const avg = (filled.reduce((s,[,v]) => s + v, 0) / filled.length).toFixed(1);
  const comments = document.getElementById('fbRatingText').value.trim();
  let body = `## User Rating Survey\n\n| Category | Score |\n|----------|-------|\n`;
  body += `| Ease of Use | ${ratings.ease}/5 |\n`;
  body += `| Issue Resolved | ${ratings.resolved}/5 |\n`;
  body += `| Recommend | ${ratings.recommend}/5 |\n`;
  body += `| Overall | ${ratings.overall}/5 |\n`;
  body += `| **Average** | **${avg}/5** |\n`;
  if (comments) body += `\n### Comments\n${comments}\n`;
  body += `\n---\n_Submitted via 1132 Fixer app_\n\n<!-- RATING_DATA:${JSON.stringify({...ratings, avg: parseFloat(avg)})} -->`;
  await submitFeedback('User Rating', body, 'fbRatingStatus');
});

document.getElementById('fbContactSubmit').addEventListener('click', async () => {
  const text = document.getElementById('fbContactText').value.trim();
  await submitFeedback('Contact', text, 'fbContactStatus');
});

async function submitFeedback(type, text, statusId) {
  const statusEl = document.getElementById(statusId);
  statusEl.textContent = 'Submitting...';
  statusEl.className = 'fb-status';

  try {
    const result = await window.electronAPI.submitFeedback(type, text);
    if (result.success) {
      statusEl.textContent = 'Submitted successfully!';
      statusEl.className = 'fb-status ok';
      setTimeout(closeFeedback, 1500);
    } else {
      statusEl.textContent = result.error || 'Submission failed';
      statusEl.className = 'fb-status err';
    }
  } catch (err) {
    statusEl.textContent = 'Network error';
    statusEl.className = 'fb-status err';
  }
}
