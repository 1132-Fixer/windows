const fileList = document.getElementById('fileList');
const fixBtn = document.getElementById('fixBtn');
const shortcutBtn = document.getElementById('shortcutBtn');

let isRunning = false;

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btnExit').addEventListener('click', () => {
    window.electronAPI.quitApp();
  });

  fixBtn.addEventListener('click', runFix);
  shortcutBtn.addEventListener('click', () => createShortcut(true));

  window.electronAPI.onFixLog(({ line, kind }) => {
    const cls = kind === 'err' ? 'failed'
      : kind === 'header' ? 'header'
      : kind === 'success' ? 'success'
      : '';
    addFileItem(line, cls);
  });

  await showInstructions();
});

async function showInstructions() {
  clearFileList();
  const elevated = await window.electronAPI.isElevated();

  if (!elevated) {
    addFileItem('NOT RUNNING AS ADMINISTRATOR', 'error');
    addFileItem('→ Close this app and right-click → Run as administrator', 'error');
    addEmptyLine();
  }

  addFileItem('HOW THIS FIX WORKS', 'header');
  addEmptyLine();
  addFileItem('Creates a local Windows user (user1 / user1), adds it to', '');
  addFileItem('Administrators, and launches Zoom Workplace as that user.', '');
  addEmptyLine();
  addFileItem('  1. Create or reset user1 with password user1', '');
  addFileItem('  2. Ensure user1 is in the Administrators group', '');
  addFileItem('  3. Launch Zoom as user1 (no password prompt)', '');
  addEmptyLine();
  addFileItem('Windows may ask for permission before continuing.', '');
  addEmptyLine();
  addFileItem('You can also create a Desktop shortcut to launch Zoom as', '');
  addFileItem('user1 in the future — uses the same 1132 Fixer icon.', '');

  fixBtn.disabled = !elevated;
  shortcutBtn.disabled = !elevated;
  setStatus(elevated ? '' : 'error', elevated ? 'Ready' : 'Not Admin');
}

async function runFix() {
  if (isRunning) return;

  const confirmed = await window.electronAPI.showFixConfirm();
  if (!confirmed) return;

  isRunning = true;
  fixBtn.disabled = true;
  shortcutBtn.disabled = true;
  setStatus('scanning', 'Running');

  clearFileList();
  addFileItem('STARTING FIX...', 'header');
  addEmptyLine();

  const result = await window.electronAPI.runFix();

  isRunning = false;
  fixBtn.disabled = false;
  shortcutBtn.disabled = false;

  addEmptyLine();
  if (result.success) {
    addFileItem('FIX COMPLETE', 'header');
    setStatus('done', 'Done');

    const wantShortcut = await window.electronAPI.showShortcutPrompt();
    if (wantShortcut) {
      await createShortcut(false);
    }
  } else {
    addFileItem(`FIX FAILED: ${friendlyError(result.error)}`, 'failed');
    setStatus('error', 'Failed');
  }
}

function friendlyError(code) {
  switch (code) {
    case 'create_user_failed':
      return 'Could not create the user1 account. Make sure the app is running as Administrator.';
    case 'set_password_failed':
      return 'user1 exists but the password could not be reset. Check Windows password policy or remove user1 manually, then try again.';
    case 'add_admin_failed':
      return 'Could not add user1 to Administrators. Make sure the app is running as Administrator.';
    case 'zoom_not_found':
      return 'Zoom Workplace was not found at C:\\Program Files\\Zoom\\bin\\Zoom.exe. Install the machine-wide Zoom Workplace MSI (not the per-user installer), then try again.';
    case 'launch_failed':
      return 'Zoom could not be launched as user1. Try running this app as Administrator, or check that user1 has permission to start C:\\Program Files\\Zoom\\bin\\Zoom.exe.';
    default:
      return code || 'Unknown error.';
  }
}

async function createShortcut(showHeader) {
  if (showHeader) {
    addEmptyLine();
    addFileItem('CREATING DESKTOP SHORTCUT...', 'header');
  }
  const result = await window.electronAPI.createShortcut();
  if (result.success) {
    addFileItem(`Shortcut created: ${result.path}`, 'success');
  } else {
    addFileItem(`Shortcut failed: ${result.error}`, 'failed');
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
  document.querySelectorAll('.fb-textarea').forEach(t => { t.value = ''; });
  document.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('.fb-status').forEach(s => { s.textContent = ''; s.className = 'fb-status'; });
  Object.keys(ratings).forEach(k => { ratings[k] = 0; });
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

(async () => {
  try {
    const v = await window.electronAPI.getVersion();
    document.getElementById('appVersion').textContent = 'v' + v;
  } catch (_) {}
})();

document.getElementById('btnFeedback').addEventListener('click', openFeedback);

['fbClose', 'fbBugCancel', 'fbRatingCancel', 'fbContactCancel'].forEach(id => {
  document.getElementById(id).addEventListener('click', closeFeedback);
});

['fbBugBack', 'fbRatingBack', 'fbContactBack'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => showSection('fbChoose'));
});

document.querySelectorAll('.fb-choice').forEach(el => {
  el.addEventListener('click', () => {
    feedbackMode = el.dataset.mode;
    if (feedbackMode === 'bug') showSection('fbBug');
    else if (feedbackMode === 'rating') showSection('fbRating');
    else if (feedbackMode === 'contact') showSection('fbContact');
  });
});

document.querySelectorAll('.fb-rating-btns').forEach(group => {
  const cat = group.dataset.cat;
  group.querySelectorAll('.fb-rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ratings[cat] = parseInt(btn.dataset.val);
      group.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const filled = Object.values(ratings).filter(v => v > 0).length;
      document.getElementById('fbRatingSubmit').disabled = filled === 0;
    });
  });
});

['fbBugText', 'fbContactText'].forEach(id => {
  const submitId = id === 'fbBugText' ? 'fbBugSubmit' : 'fbContactSubmit';
  document.getElementById(id).addEventListener('input', (e) => {
    document.getElementById(submitId).disabled = e.target.value.trim().length < 50;
  });
});

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
