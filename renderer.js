const fileList = document.getElementById('fileList');
const fixBtn = document.getElementById('fixBtn');
const shortcutBtn = document.getElementById('shortcutBtn');
const checkEnvBtn = document.getElementById('checkEnvBtn');

let isRunning = false;

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btnExit').addEventListener('click', () => {
    window.electronAPI.quitApp();
  });

  fixBtn.addEventListener('click', runFix);
  shortcutBtn.addEventListener('click', () => createShortcut(true));
  checkEnvBtn.addEventListener('click', checkEnvironment);

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
  addFileItem('Fully resets the local user1 account and launches a clean', '');
  addFileItem('Zoom Workplace session under it. Destructive - do NOT run', '');
  addFileItem('while signed in AS user1.', '');
  addEmptyLine();
  addFileItem('  1. Log off / kill any active user1 session', '');
  addFileItem('  2. Remove leftover suffixed profile folders', '');
  addFileItem('  3. Delete the user1 account, profile, and registry entries', '');
  addFileItem('  4. Recreate user1 (password user1) as a local admin', '');
  addFileItem('  5. Launch Zoom as user1 to materialize the profile', '');
  addFileItem('  6. Deploy "Apply Zoom Settings" helper on user1 desktop', '');
  addFileItem('  7. Apply per-user dark mode + mirror Zoom device prefs', '');
  addFileItem('  8. Relaunch Zoom with the new settings', '');
  addEmptyLine();
  addFileItem('Excluded: file/media transfer and Zoom group-policy edits.', '');
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
  checkEnvBtn.disabled = true;
  setStatus('scanning', 'Running');

  clearFileList();
  addFileItem('STARTING FIX...', 'header');
  addEmptyLine();

  const result = await window.electronAPI.runFix();

  isRunning = false;
  fixBtn.disabled = false;
  shortcutBtn.disabled = false;
  checkEnvBtn.disabled = false;

  addEmptyLine();
  if (result.success) {
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      addFileItem(`FIX COMPLETE (with ${warnings.length} warning(s))`, 'header');
      warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
      setStatus('done', 'Done (warnings)');
    } else {
      addFileItem('FIX COMPLETE', 'header');
      setStatus('done', 'Done');
    }

    const wantShortcut = await window.electronAPI.showShortcutPrompt();
    if (wantShortcut) {
      await createShortcut(false);
    }
  } else {
    addFileItem(`FIX FAILED: ${friendlyError(result.error)}`, 'failed');
    if (Array.isArray(result.blockers) && result.blockers.length) {
      result.blockers.forEach(b => addFileItem(`  • [${b.code}] ${b.message}`, 'failed'));
    }
    if (Array.isArray(result.warnings) && result.warnings.length) {
      result.warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
    }
    setStatus('error', 'Failed');
  }
}

function friendlyError(code) {
  switch (code) {
    case 'not_elevated':
      return 'Process is not running as Administrator. Re-launch the app elevated (right-click → Run as administrator).';
    case 'running_as_target':
      return 'You are currently signed in as user1. Sign in as a different administrator and try again.';
    case 'preflight_failed':
      return 'Environment check found one or more blockers. Look at the highlighted lines above — each one tells you what to fix before retrying.';
    case 'missing_tool':
      return 'A required Windows tool is missing from PATH (powershell/taskkill/robocopy/icacls/takeown/net/reg). See preflight output above.';
    case 'create_user_failed':
      return 'Could not create the user1 account. Make sure the app is running as Administrator and that password policy allows the password.';
    case 'delete_user_failed':
      return 'Could not delete the existing user1 account. Make sure the app is running as Administrator.';
    case 'delete_profile_failed':
      return 'The user1 profile folder could not be removed - a file handle is still open. Reboot once and run the fix again.';
    case 'zoom_not_found':
      return 'Zoom Workplace was not found at C:\\Program Files\\Zoom\\bin\\Zoom.exe. Install the machine-wide Zoom Workplace MSI (not the per-user installer), then try again.';
    case 'launch_failed':
      return 'Zoom could not be launched as user1. Common causes: Secondary Logon service disabled, password policy mismatch, or user1 lacks permission to start C:\\Program Files\\Zoom\\bin\\Zoom.exe. Re-run as Administrator or check the log above for the exact PowerShell exception.';
    case 'seclogon_disabled':
      return 'The Secondary Logon service is disabled. It is required to launch processes under another local account. Run this from an admin shell and retry:  sc.exe config seclogon start= demand  &  sc.exe start seclogon';
    case 'profile_not_materialized':
      return 'The user1 profile did not appear in time. The account was created and Zoom was launched, but per-user prefs (dark mode, device IDs) were skipped.';
    case 'tool_probe_failed':
      return 'The PowerShell tool probe failed. PowerShell itself may be missing or restricted by AppLocker/policy. The fix cannot continue.';
    default:
      return code || 'Unknown error.';
  }
}

async function checkEnvironment() {
  if (isRunning) return;
  checkEnvBtn.disabled = true;
  setStatus('scanning', 'Checking...');
  clearFileList();
  addFileItem('ENVIRONMENT CHECK (read-only, no changes made)', 'header');
  addEmptyLine();
  try {
    const r = await window.electronAPI.preflight();
    const required = ['powershell.exe','taskkill.exe','robocopy.exe','icacls.exe','takeown.exe','net.exe','reg.exe'];
    const optional = ['quser.exe','logoff.exe'];
    addFileItem('Required Windows tools:', 'header');
    required.forEach(t => {
      const ok = r.info && r.info.tools && r.info.tools[t];
      addFileItem(`  ${ok ? 'OK  ' : 'MISS'}  ${t}`, ok ? 'success' : 'failed');
    });
    addEmptyLine();
    addFileItem('Optional Windows tools:', 'header');
    optional.forEach(t => {
      const ok = r.info && r.info.tools && r.info.tools[t];
      addFileItem(`  ${ok ? 'OK  ' : 'opt '}  ${t}${ok ? '' : ' (missing — session logoff will be skipped, taskkill still runs)'}`, '');
    });
    addEmptyLine();
    addFileItem('Other environment:', 'header');
    if (r.info) {
      addFileItem(`  Zoom path:        ${r.info.zoomPath}`, '');
      addFileItem(`  Firstrun script:  ${r.info.firstRunScript}`, '');
      addFileItem(`  Interactive user: ${r.info.interactiveUser}`, '');
      addFileItem(`  Elevated:         ${r.info.elevated ? 'YES' : 'NO'}`, r.info.elevated ? 'success' : 'failed');
      if (r.info.seclogon) {
        addFileItem(`  Secondary Logon:  ${r.info.seclogon.status} (${r.info.seclogon.startType})`, '');
      }
    }
    addEmptyLine();
    if (r.blockers && r.blockers.length) {
      addFileItem(`${r.blockers.length} BLOCKER(S) — fix these before running FIX NOW:`, 'header');
      r.blockers.forEach(b => addFileItem(`  • [${b.code}] ${b.message}`, 'failed'));
      addEmptyLine();
    }
    if (r.warnings && r.warnings.length) {
      addFileItem(`${r.warnings.length} warning(s) — FIX NOW can still proceed:`, 'header');
      r.warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
      addEmptyLine();
    }
    if (r.ok) {
      addFileItem('ENVIRONMENT OK — safe to click FIX NOW.', 'success');
      setStatus('done', 'Ready');
    } else {
      addFileItem('ENVIRONMENT NOT READY — see blockers above.', 'failed');
      setStatus('error', 'Blocked');
    }
  } catch (err) {
    addFileItem(`Preflight call failed: ${err.message}`, 'failed');
    setStatus('error', 'Error');
  } finally {
    checkEnvBtn.disabled = false;
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
