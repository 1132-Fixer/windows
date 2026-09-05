// ============================================================
// 1132 Fixer renderer
//
// View model (state-driven wizard, one pane at a time in one card):
//   checking -> grouped summary of the auto-run environment scan
//   result   -> ready / fix available / action required
//   fixing   -> 5-stage tracker + latest action line
//   notice   -> success / warnings / failure / shortcut states
// Per-check results and the fix receipt are shown in the Details view
// (plain English, details-view.js); the raw log is kept in memory for
// the support report and never rendered. FIX NOW confirms once, then
// runs the orchestrator; the repair, updater and shortcut logic are
// unchanged underneath.
// ============================================================

const elevateBtn      = document.getElementById('elevateBtn');
const fixBtn          = document.getElementById('fixBtn');
const launchBtn       = document.getElementById('launchBtn');
const shortcutBtn     = document.getElementById('shortcutBtn');
const rescanBtn       = document.getElementById('rescanBtn');
const closeBtn        = document.getElementById('closeBtn');
const detailsBtn      = document.getElementById('detailsBtn');
const supportBtn      = document.getElementById('supportBtn');
const buttonNote      = document.getElementById('buttonNote');
const stageTracker    = document.getElementById('stageTracker');
const copyErrBtn      = document.getElementById('copyErrBtn');
const wizChecks       = document.getElementById('wizChecks');
const wizFixAction    = document.getElementById('wizFixAction');

let isRunning = false;
let lastReceipt = null;
// Plain-English receipt rows for the Details view (details-view.js
// receiptItemView), rebuilt from every completed run.
let lastReceiptItems = null;
let lastStageLabel = '';
// The last scan's per-check status, keyed by CHECK_ORDER key. This is the
// data behind the Details view; a key the scan did not report is absent
// and renders as "Unable to verify" — never as Ready.
let lastScan = { statusByKey: {} };
const logBuffer = [];
const LOG_BUFFER_MAX = 400;

// ============================================================
// Wizard panes / action area
// ============================================================
const WIZ_PANES = {
  checking: document.getElementById('wizChecking'),
  result:   document.getElementById('wizResult'),
  fixing:   document.getElementById('wizFixing'),
  notice:   document.getElementById('wizNotice')
};

function setWizardPane(name) {
  for (const [key, el] of Object.entries(WIZ_PANES)) {
    el.classList.toggle('active', key === name);
  }
}

// Large state glyphs (result / notice panes).
const WIZ_GLYPH = {
  ok:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="16.5 9 10.5 15.2 7.5 12.2"/></svg>`,
  // A real wrench (design review P0-2): reads as "repair" in under a
  // second, never as a pin or tag.
  fix:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>`,
  err:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
};

function fillWizHeadline(glyphEl, titleEl, subEl, tone, title, sub) {
  glyphEl.innerHTML = WIZ_GLYPH[tone] || WIZ_GLYPH.warn;
  glyphEl.setAttribute('data-tone', tone);
  titleEl.textContent = title;
  subEl.textContent = sub || '';
  subEl.hidden = !sub;
}

function showResultPane(tone, title, sub) {
  fillWizHeadline(
    document.getElementById('wizResultGlyph'),
    document.getElementById('wizResultTitle'),
    document.getElementById('wizResultSub'),
    tone, title, sub);
  setWizardPane('result');
}

function showNoticePane(tone, title, sub) {
  fillWizHeadline(
    document.getElementById('wizNoticeGlyph'),
    document.getElementById('wizNoticeTitle'),
    document.getElementById('wizNoticeSub'),
    tone, title, sub);
  setWizardPane('notice');
}

// ONE dominant CTA per state. Everything defaults to hidden; each wizard
// state opts in to exactly the actions it allows. The *Quiet flags demote
// a button to a secondary chip so two primaries never compete.
function setActions({ fix = false, fixDisabled = false, fixQuiet = false, fixLabel = 'Fix now',
                      shortcut = false, shortcutQuiet = false, shortcutLabel = 'Create desktop shortcut',
                      shortcutOption = false, elevate = false, launch = false,
                      rescan = false, rescanLabel = 'Check again', close = false, details = false, support = false,
                      copyErr = false, note = '' } = {}) {
  elevateBtn.hidden = !elevate;
  if (elevate) elevateBtn.textContent = WIZARD.ADMIN_PRIMARY;
  fixBtn.hidden = !fix;
  fixBtn.disabled = !!fixDisabled;
  fixBtn.classList.toggle('btn-primary', !fixQuiet);
  fixBtn.classList.toggle('btn-quiet', !!fixQuiet);
  if (fixBtn.textContent !== 'Starting after check…') fixBtn.textContent = fixLabel;
  launchBtn.hidden = !launch;
  if (launch) {
    launchBtn.textContent = 'Open Zoom';
    launchBtn.setAttribute('aria-label', 'Open Zoom');
  }
  shortcutBtn.hidden = !shortcut;
  shortcutBtn.classList.toggle('btn-primary', !shortcutQuiet);
  shortcutBtn.classList.toggle('btn-quiet', !!shortcutQuiet);
  document.getElementById('shortcutBtnLabel').textContent = shortcutLabel;
  document.getElementById('shortcutOpt').hidden = !shortcutOption;
  rescanBtn.hidden = !rescan;
  if (rescan) rescanBtn.textContent = rescanLabel;
  if (closeBtn) closeBtn.hidden = !close;
  detailsBtn.hidden = !details;
  supportBtn.hidden = !support;
  copyErrBtn.hidden = !copyErr;
  buttonNote.textContent = note;
  buttonNote.hidden = !note;
  // The "Fix now is disabled by:" note exists to explain a VISIBLE disabled
  // button. When the state hides the button entirely, the result pane's own
  // copy names the blockers — the extra red line would say it twice.
  if (!fix) {
    const note66 = document.getElementById('fixDisabledNote');
    note66.hidden = true;
    note66.textContent = '';
  }
}

// Grouped summary checks (checking pane) — WIZARD_GROUPS comes from
// messages.js, derived from CHECK_ORDER so it can never drift from the
// real checklist. statusByGroup maps group name -> normalized status.
function renderWizChecks(statusByGroup) {
  wizChecks.innerHTML = '';
  for (const g of WIZARD_GROUPS) {
    const status = normalizeCheckStatus(statusByGroup ? statusByGroup[g.group] : 'pending');
    const row = document.createElement('div');
    row.className = 'wiz-check';
    row.setAttribute('data-status', status);
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${g.label}: ${badgeForCheckStatus(status)}`);
    row.innerHTML = `${iconForStatus(status, 'chk-icon')}<span>${escapeHtml(g.label)}</span>`;
    wizChecks.appendChild(row);
  }
}

// Worst-of ranking for a group roll-up — same discipline as the summary
// badge: a group is only as good as its worst row.
const GROUP_STATUS_RANK = ['blocked', 'unknown', 'repairable', 'warning', 'pending', 'ready'];
function worstStatus(statuses) {
  for (const s of GROUP_STATUS_RANK) {
    if (statuses.indexOf(s) !== -1) return s;
  }
  return 'unknown';
}

// Summary badge. `tone` is one of the .status-badge CSS classes; the icon
// comes from ui-state.js so an unrecognised tone renders '?' and never the
// check mark. (This used to be a ternary chain whose final `: '✓'` gave a
// green tick to every tone it did not enumerate.)
function setStatus(tone, text) {
  const badge = document.getElementById('statusBadge');
  badge.hidden = false; // re-shown after the repairing state hid it
  // Assistive-technology live region only: it stays visually hidden in
  // every tone (the wizard body is the visible status voice).
  badge.className = 'visually-hidden status-badge' + (tone ? ' ' + tone : '');
  badge.setAttribute('data-tone', tone || 'unknown');
  document.getElementById('statusBadgeIcon').textContent = summaryIcon(tone);
  document.getElementById('statusBadgeText').textContent = text;
}

const STAGE_ORDER = ['prep', 'verify', 'consent', 'launch', 'receipt'];
const STAGE_LABEL = {
  prep: 'Preparing the repair', verify: 'Setting up the fresh Zoom environment',
  consent: 'Camera & microphone access', launch: 'Launch Zoom', receipt: 'Verify repair'
};
// Consumer-language detail for the ACTIVE step (design critique 2026-08-23:
// no engineering copy like account names in the primary UI — the raw log
// stays behind View details).
const STAGE_DETAIL = {
  prep: 'Getting things ready…',
  verify: 'Setting up the fresh Zoom environment…',
  consent: 'Configuring camera & microphone access…',
  launch: 'Starting Zoom…',
  receipt: 'Checking the repair…'
};

// Paint the friendly detail line under the active step (and announce it
// through the visually-hidden live region).
function paintStageDetail() {
  const active = stageTracker.querySelector('.stage-pill[data-state="active"]');
  stageTracker.querySelectorAll('.stage-detail').forEach(el => { el.textContent = ''; });
  if (active) {
    const text = STAGE_DETAIL[active.getAttribute('data-stage')] || '';
    active.querySelector('.stage-detail').textContent = text;
    wizFixAction.textContent = text;
  }
}

// Map a fix-log [N/8] step number onto our 5-stage UI.
function stageForStep(n) {
  if (n <= 1) return 'prep';
  if (n <= 4) return 'verify';
  if (n <= 7) return 'consent';
  if (n === 8) return 'launch';
  return null;
}

function setStageTracker(active) {
  stageTracker.classList.toggle('active', active);
}

function setStageState(stage, state) {
  const el = stageTracker.querySelector(`.stage-pill[data-stage="${stage}"]`);
  if (el) el.setAttribute('data-state', state);
  updateFixProgress();
}

// Thin repair progress bar (§19) — derived from the stage states, so it
// can never disagree with the task rows above it.
function updateFixProgress() {
  let done = 0;
  let active = 0;
  for (const s of STAGE_ORDER) {
    const st = stageTracker.querySelector(`.stage-pill[data-stage="${s}"]`)?.getAttribute('data-state');
    if (st === 'done' || st === 'warn' || st === 'fail') done++;
    else if (st === 'active') active = 0.5;
  }
  const step = Math.max(1, Math.min(STAGE_ORDER.length, done + (active ? 1 : 0) || 1));
  const activeEl = stageTracker.querySelector('.stage-pill[data-state="active"] .stage-pill-label');
  document.getElementById('wizStepLine').textContent =
    `Step ${step} of ${STAGE_ORDER.length}` + (activeEl ? ` · ${activeEl.textContent}` : '');
  paintStageDetail();
}

function resetStages() {
  STAGE_ORDER.forEach(s => setStageState(s, 'pending'));
  lastStageLabel = '';
}

function advanceStageTo(stage) {
  if (!stage) return;
  let reached = false;
  for (const s of STAGE_ORDER) {
    if (s === stage) {
      setStageState(s, 'active');
      reached = true;
      lastStageLabel = STAGE_LABEL[s];
    } else if (!reached) {
      setStageState(s, 'done');
    }
  }
}

function finalizeStages(outcome) {
  // outcome: 'ok' | 'warn' | 'fail'
  const stateForLeading = outcome === 'fail' ? 'fail' : (outcome === 'warn' ? 'warn' : 'done');
  for (const s of STAGE_ORDER) {
    const cur = stageTracker.querySelector(`.stage-pill[data-stage="${s}"]`)?.getAttribute('data-state');
    if (cur === 'active' || cur === 'pending') {
      if (s === 'receipt') setStageState(s, outcome === 'fail' ? 'fail' : (outcome === 'warn' ? 'warn' : 'done'));
      else setStageState(s, cur === 'active' ? stateForLeading : 'pending');
    }
  }
  // Mark receipt stage explicitly to outcome.
  setStageState('receipt', outcome === 'fail' ? 'fail' : (outcome === 'warn' ? 'warn' : 'done'));
  lastStageLabel = STAGE_LABEL.receipt;
}

// ============================================================
// Log — a ring buffer for the Support Report and Copy error details.
// Lines arrive from main in bursts (robocopy, icacls, PS).
// ============================================================
function clearFileList() {
  logBuffer.length = 0;
}

// Nothing here touches the DOM: raw output is never rendered on a primary
// surface. The buffer feeds the Support Report and Copy error details.
function addFileItem(text, className = '') {
  void className;
  logBuffer.push(text);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();

  // Stage advancement — parse "[N/8] ..." header lines. The same line,
  // minus its step prefix, becomes the wizard's current-action text so the
  // primary flow narrates progress without exposing the raw log.
  const m = /^\[(\d)\/8\]\s*(.*)/.exec(text);
  if (m) {
    const stage = stageForStep(parseInt(m[1], 10));
    if (stage) advanceStageTo(stage);
  }
}

function addEmptyLine() {
  addFileItem(' ');
}

// Advanced details — one collapsed chip; the panel (checklist + receipt +
// log) scrolls internally so the window never grows a scrollbar.
// ONE details control (design review P0-1): "View details" in the
// secondary action row is the single toggle for the diagnostics panel
// (checklist + receipt + log); it flips to "Hide details" while open.
// The panel scrolls internally so the window never does.
// ============================================================
// Details view — opens in place over any state. The wizard and the
// action area are hidden as containers; every control keeps its own
// flags, so Back restores the previous screen exactly (readiness
// result, checkbox, completed checks). Content comes from
// details-view.js: plain English only, four status words, nothing that
// scrolls. Categories open one at a time in the same region.
// ============================================================
const detailsView         = document.getElementById('detailsView');
const detailsSummaryEl    = document.getElementById('detailsSummary');
const detailsSummaryIcon  = document.getElementById('detailsSummaryIcon');
const detailsSummaryHead  = document.getElementById('detailsSummaryHeadline');
const detailsSummaryCount = document.getElementById('detailsSummaryCounts');
const detailsOverview     = document.getElementById('detailsOverview');
const detailsCategoryEl   = document.getElementById('detailsCategory');
const detailsOverviewBtn  = document.getElementById('detailsOverviewBtn');
const detailsCategoryTitle = document.getElementById('detailsCategoryTitle');
const detailsChecks       = document.getElementById('detailsChecks');
const backBtn             = document.getElementById('backBtn');
const wizardCard          = document.getElementById('wizardCard');
const actionArea          = document.querySelector('.action-area');
let detailsOpenCategoryId = null;

// Lucide-style status marks (2px stroke, 24 grid). Colour comes from the
// row's data-tone; the status word beside it carries the meaning.
const DETAILS_ICON_SVG = {
  ready:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
  attention:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  unverified: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  checking:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`
};
const DETAILS_CHEVRON_SVG = `<svg class="details-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

function detailsIcon(tone, klass) {
  return `<span class="${klass}">${DETAILS_ICON_SVG[tone] || DETAILS_ICON_SVG.unverified}</span>`;
}

// Last-line guard: the model is written in plain English, and this keeps
// a raw scan message from ever reaching the screen by accident.
function plain(text) {
  return isPlainEnglish(text) ? String(text || '') : '';
}

function buildDetailsCategories() {
  const model = buildDetailsModel(lastScan.statusByKey, CHECK_ORDER);
  const categories = model.categories.slice();
  if (Array.isArray(lastReceiptItems) && lastReceiptItems.length) {
    const checks = lastReceiptItems;
    const tones = checks.map(c => c.tone);
    const tone = tones.indexOf('attention') !== -1 ? 'attention' : tones.indexOf('unverified') !== -1 ? 'unverified' : 'ready';
    const passed = checks.filter(c => c.tone === 'ready').length;
    const attention = checks.filter(c => c.tone === 'attention').length;
    const unverified = checks.filter(c => c.tone === 'unverified').length;
    categories.push({
      group: 'Repair results', id: 'repair-results', label: 'Repair results', checks, tone,
      word: tone === 'ready' ? 'Ready' : tone === 'attention' ? 'Needs attention' : 'Unable to verify',
      passed, total: checks.length,
      summary: attention ? `${attention} ${attention === 1 ? 'item needs' : 'items need'} attention`
        : unverified ? `${unverified} ${unverified === 1 ? 'check' : 'checks'} could not be verified`
        : `${passed} of ${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`
    });
  }
  return { model, categories };
}

function renderDetailsOverview() {
  const { model, categories } = buildDetailsCategories();
  detailsSummaryEl.setAttribute('data-tone', model.overall.tone);
  detailsSummaryIcon.innerHTML = DETAILS_ICON_SVG[model.overall.tone] || DETAILS_ICON_SVG.unverified;
  detailsSummaryHead.textContent = plain(model.overall.headline);
  detailsSummaryCount.textContent = plain(model.overall.counts);
  detailsOverview.innerHTML = '';
  for (const cat of categories) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'details-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-tone', cat.tone);
    row.setAttribute('data-category', cat.id);
    row.setAttribute('aria-label', `${cat.label}: ${cat.summary}. Open ${cat.label}`);
    row.innerHTML = `${detailsIcon(cat.tone, 'details-icon')}
      <span class="details-row-name">${escapeHtml(cat.label)}</span>
      <span class="details-row-status">${escapeHtml(plain(cat.summary))}</span>
      ${DETAILS_CHEVRON_SVG}`;
    row.addEventListener('click', () => showDetailsCategory(cat.id));
    detailsOverview.appendChild(row);
  }
  return categories;
}

function showDetailsOverview({ focus = true } = {}) {
  const wasOpen = detailsOpenCategoryId;
  detailsOpenCategoryId = null;
  renderDetailsOverview();
  detailsCategoryEl.hidden = true;
  detailsSummaryEl.hidden = false;
  detailsOverview.hidden = false;
  if (!focus) return;
  const target = wasOpen ? detailsOverview.querySelector(`[data-category="${wasOpen}"]`) : null;
  if (target) target.focus();
  else if (backBtn) backBtn.focus();
}

function showDetailsCategory(id, { focus = true } = {}) {
  const { categories } = buildDetailsCategories();
  const cat = categories.find(c => c.id === id);
  if (!cat) { showDetailsOverview({ focus }); return; }
  detailsOpenCategoryId = id;
  detailsCategoryTitle.textContent = cat.label;
  detailsChecks.innerHTML = '';
  for (const c of cat.checks) {
    const row = document.createElement('div');
    row.className = 'details-check';
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-tone', c.tone);
    row.setAttribute('data-key', c.key);
    const explain = plain(c.explain);
    row.setAttribute('aria-label', `${c.label}: ${c.word}.${explain ? ' ' + explain : ''}`);
    row.innerHTML = `${detailsIcon(c.tone, 'details-icon')}
      <span class="details-check-name">${escapeHtml(c.label)}</span>
      <span class="details-check-word">${escapeHtml(c.word)}</span>
      <span class="details-check-explain">${escapeHtml(explain)}</span>`;
    detailsChecks.appendChild(row);
  }
  detailsSummaryEl.hidden = true;
  detailsOverview.hidden = true;
  detailsCategoryEl.hidden = false;
  detailsOverviewBtn.hidden = false;
  if (focus) detailsOverviewBtn.focus();
}

function detailsOpen() {
  return document.body.dataset.view === 'details';
}

function openDetails() {
  if (detailsOpen()) return;
  document.body.dataset.view = 'details';
  wizardCard.hidden = true;
  actionArea.hidden = true;
  detailsView.hidden = false;
  backBtn.hidden = false;
  detailsBtn.setAttribute('aria-expanded', 'true');
  showDetailsOverview({ focus: false });
  backBtn.focus();
}

function closeDetails() {
  if (!detailsOpen()) return;
  delete document.body.dataset.view;
  detailsView.hidden = true;
  backBtn.hidden = true;
  wizardCard.hidden = false;
  actionArea.hidden = false;
  detailsOpenCategoryId = null;
  detailsBtn.setAttribute('aria-expanded', 'false');
  if (!detailsBtn.hidden) detailsBtn.focus();
}

// Re-paint an open Details view when the data behind it changes (a quiet
// re-scan, or a fix finishing while the user is reading).
function refreshDetailsIfOpen() {
  if (!detailsOpen()) return;
  if (detailsOpenCategoryId) showDetailsCategory(detailsOpenCategoryId, { focus: false });
  else showDetailsOverview({ focus: false });
}

// ============================================================
// Status icon SVGs — shared between checklist + receipt.
// Inline strings so the renderer ships nothing extra.
// ============================================================
// Row badge words live in ui-state.js (CHECK_STATUS_BADGE) so the
// status -> word -> icon mapping is one table, covered by
// tools/ui-state-smoke.js, and has an explicit 'unknown' entry.

function svgCheck(klass)  { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`; }
function svgWrench(klass) { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-7-7 8-8 .7 1.3z"/><line x1="9" y1="15" x2="4.5" y2="19.5"/></svg>`; }
function svgWarn(klass)   { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>`; }
function svgBlock(klass)  { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`; }
function svgDot(klass)    { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`; }

// status -> SVG. The status is normalised first (ui-state.js), so a state
// this version does not know renders the WARNING glyph and the "Unknown"
// badge word rather than borrowing the success tick.
const CHECK_ICON_SVG = {
  check:  svgCheck,
  wrench: svgWrench,
  warn:   svgWarn,
  block:  svgBlock,
  dot:    svgDot
};

function iconForStatus(status, klass) {
  const draw = CHECK_ICON_SVG[iconKeyForCheckStatus(status)] || svgWarn;
  return draw(klass);
}

// ============================================================
// Environment checklist — runs automatically, no clicks required.
// CHECK_ORDER (keys, labels, §9 group headers) lives in messages.js
// so the mapping is covered by tools/messages-smoke.js.
// ============================================================

let scanInProgress = false;
let lastScanAt = 0;
let canRunFix = false;

// Fix-button gating transparency (#66): a disabled "Fix now" never says WHY
// on its own, so name the blocking checklist row(s) in one line under the
// checklist and mirror it in the button's tooltip. Pure display over data
// the scan already returns.
const fixDisabledNote = document.getElementById('fixDisabledNote');

// Preflight blockers that already surface as a blocked checklist card —
// listing both the card label and the blocker message would say the same
// thing twice. Everything NOT in this set (running_as_target, missing_tool,
// tool-probe failure) has no card of its own and is named by its message
// (already user-facing copy) so the disabled note never goes silent.
const CARD_COVERED_BLOCKER_CODES = new Set([
  'not_elevated', 'zoom_not_found', 'seclogon_disabled', 'seclogon_start_failed'
]);

// canRunFix is passed explicitly so a DISABLED button with an empty reason
// list still says something. Previously an empty list hid the note outright,
// leaving a dead button with no explanation anywhere on screen or in the
// accessibility tree — a silent no-op.
//
// A disabled button is not focusable, so `title` alone never reaches a
// screen-reader user. The note carries role="status" in index.html and is
// wired to the button with aria-describedby.
function updateFixDisabledNote(blockedLabels, canRunFix) {
  const text = fixDisabledNoteText(blockedLabels, canRunFix);
  if (!text) {
    fixDisabledNote.hidden = true;
    fixDisabledNote.textContent = '';
    fixBtn.title = '';
    fixBtn.removeAttribute('aria-describedby');
    return;
  }
  fixDisabledNote.textContent = text;
  fixDisabledNote.hidden = false;
  fixBtn.title = text;
  fixBtn.setAttribute('aria-describedby', 'fixDisabledNote');
}

// quiet: refresh the data + badges WITHOUT flipping the wizard back to the
// "Checking your setup…" pane — used by the throttled focus-rescan so the
// screen does not churn every time the window regains focus.
async function runEnvironmentScan(opts = {}) {
  const quiet = !!opts.quiet;
  if (scanInProgress || isRunning) return;
  scanInProgress = true;
  lastScanAt = Date.now();
  if (!quiet) {
    setStatus('scanning', 'Checking…');
    renderWizChecks(null); // all groups pending
    setWizardPane('checking');
    setActions({});
    // Every check reads as Checking until the scan reports it.
    const pendingByKey = {};
    for (const c of CHECK_ORDER) pendingByKey[c.key] = 'pending';
    lastScan = { statusByKey: pendingByKey };
    refreshDetailsIfOpen();
  }

  try {
    const result = await window.electronAPI.preflightScan();
    const cards = (result && result.cards && typeof result.cards === 'object') ? result.cards : {};
    // Every CHECK_ORDER row is recorded, every time. A card the scan did not
    // return is recorded UNKNOWN — it used to be `continue`, which silently
    // shortened the list, so a check that never ran was indistinguishable
    // from a check that passed.
    const renderedStatuses = [];
    const statusByKey = {};
    for (const c of CHECK_ORDER) {
      const card = cards[c.key];
      const status  = card ? normalizeCheckStatus(card.status) : 'unknown';
      renderedStatuses.push(status);
      statusByKey[c.key] = status;
    }
    lastScan = { statusByKey };
    refreshDetailsIfOpen();
    canRunFix = !!(result && result.canRunFix);
    // Summary is computed from what is ACTUALLY on screen, never from the
    // roll-up label alone. `overall === 'repairable'` (what a detected TEMP
    // helper profile produces) previously fell through to the green
    // "Ready" badge; an unknown row now also refuses to roll up green.
    const summary = summarizeChecks(renderedStatuses, result && result.overall, canRunFix);
    setStatus(summary.tone, summary.text);
    const blockedLabels = CHECK_ORDER
      .map(c => cards[c.key])
      .filter(card => card && normalizeCheckStatus(card.status) === 'blocked')
      .map(card => card.label);
    // Blockers without a checklist card — name them by message.
    const nonCardBlockers = ((result && Array.isArray(result.blockers)) ? result.blockers : [])
      .filter(b => b && !CARD_COVERED_BLOCKER_CODES.has(b.code))
      .map(b => b.message || b.code);
    updateFixDisabledNote(blockedLabels.concat(nonCardBlockers), canRunFix);
    updateZoomRecovery(cards.zoom, result && result.info && result.info.zoomInstall);

    // Wizard: paint the grouped checks with their final states, then
    // transition to the result pane.
    const statusByGroup = {};
    for (const g of WIZARD_GROUPS) {
      statusByGroup[g.group] = worstStatus(g.keys.map(k => statusByKey[k]));
    }
    renderWizChecks(statusByGroup);
    const repairableLabels = CHECK_ORDER
      .filter(c => statusByKey[c.key] === 'repairable')
      .map(c => (cards[c.key] && cards[c.key].label) || c.label);
    await presentScanResult({
      statuses: renderedStatuses,
      repairableLabels,
      blockedLabels: blockedLabels.concat(nonCardBlockers),
      quiet
    });
  } catch (err) {
    // The scan itself failed: every check is unverified, not failed.
    lastScan = { statusByKey: {} };
    refreshDetailsIfOpen();
    canRunFix = false;
    setStatus('error', 'Something went wrong');
    updateFixDisabledNote(['Environment scan'], false);
    updateZoomRecovery(null, null); // scan state unknown — hide the card
    showNoticePane('err', WIZARD.UNABLE_TITLE, WIZARD.UNABLE_SUB);
    addFileItem(scanFailureMessage(err), 'failed');
    setActions({ rescan: true, rescanLabel: WIZARD.TRY_AGAIN, details: true });
  } finally {
    scanInProgress = false;
  }
}

// Scan result -> wizard result pane + the one CTA that state allows.
// Ranking mirrors the summary badge: blocked > unknown > repairable >
// warning > ready — the pane can never look better than the badge.
async function presentScanResult({ statuses, repairableLabels, blockedLabels, quiet }) {
  // A short beat so the finished check marks are visible before the pane
  // transitions (skipped for quiet refreshes).
  if (!quiet) await new Promise(r => setTimeout(r, 650));

  if (statuses.indexOf('blocked') !== -1 || !canRunFix) {
    showResultPane('warn', WIZARD.BLOCKED_TITLE, wizardBlockedSub(blockedLabels));
    // The Zoom recovery card (when Zoom is the blocker) renders inside this
    // pane with its own guided actions; one clear next step, plus details.
    setActions({ rescan: true, details: true });
  } else {
    // A clean preflight only means the repair can be attempted. It is not
    // proof that error 1132 is absent. Always offer Fix now — never Open Zoom
    // and never "Everything looks good" — until the repair has actually run.
    showResultPane('ok', WIZARD.READY_TITLE, WIZARD.READY_SUB);
    setActions({ fix: true, shortcutOption: true, details: true });
    if (pendingFixAfterScan) {
      pendingFixAfterScan = false;
      showFixConfirm();
    }
  }
}

// Re-scan when the user comes back to the window (e.g. after installing
// Zoom or fixing a blocker) — throttled, quiet (no pane churn), and only
// while the app is idle on a scan-driven pane.
window.addEventListener('focus', () => {
  if (isRunning || scanInProgress) return;
  // Never before the first scan: while the elevation gate is parked on its
  // "Administrator rights needed" pane, a focus-rescan would replace that
  // tailored guidance with the generic blocked pane.
  if (!lastScanAt) return;
  if (WIZ_PANES.fixing.classList.contains('active') || WIZ_PANES.notice.classList.contains('active')) return;
  if (Date.now() - lastScanAt < 10000) return;
  runEnvironmentScan({ quiet: true });
});

// ============================================================
// Zoom Workplace guided recovery card.
//
// Wizard mapping (the app has no wizard): the specified "blocked screen"
// is the Zoom checklist card zone — this card renders below the checklist
// while the machine-wide Zoom requirement is BLOCKED. "Next disabled until
// the requirement passes" = the existing canRunFix gate on Fix now (kept,
// untouched). "Cancel setup" = the cancel row's copy + the existing Exit
// affordance (quitApp) — closing changes nothing on the computer.
//
// Truthfulness: detection is read-only; nothing on the
// computer changes unless the user launches an installer they chose and
// approved in the Windows prompt. The only automatic behavior described —
// re-check when the installer finishes — is exactly what the
// onZoomInstallerDone handler below implements.
//
// All copy comes from the ZOOM_RECOVERY catalog (messages.js, byte-pinned
// by tools/messages-smoke.js); #zrStatus is the ONE live region carrying
// every card state / validation announcement, so full state strings are
// both visible and announced without duplicate regions.
// ============================================================
const zoomRecoveryEl = document.getElementById('zoomRecovery');
const zrStatusEl     = document.getElementById('zrStatus');
const zrTechEl       = document.getElementById('zrTech');
const zrDownloadBtn  = document.getElementById('zrDownloadBtn');
const zrRecheckBtn   = document.getElementById('zrRecheckBtn');
const zrChooseBtn    = document.getElementById('zrChooseBtn');
const zrCancelBtn    = document.getElementById('zrCancelBtn');
const zrCancelNoteEl = document.getElementById('zrCancelNote');

// Fill the card from the catalog so the DOM ships the byte-verbatim
// directive strings the smoke pins.
document.getElementById('zrFlagLabel').textContent     = ZOOM_RECOVERY.FLAG_LABEL;
document.getElementById('zrTitle').textContent         = ZOOM_RECOVERY.TITLE;
document.getElementById('zrDesc').textContent          = ZOOM_RECOVERY.DESCRIPTION;
document.getElementById('zrHelperQ').textContent       = ZOOM_RECOVERY.HELPER_LABEL;
document.getElementById('zrHelperA').textContent       = ZOOM_RECOVERY.HELPER_TEXT;
document.getElementById('zrWhySummary').textContent    = ZOOM_RECOVERY.WHY_LABEL;
document.getElementById('zrWhyText').textContent       = ZOOM_RECOVERY.WHY_TEXT;
document.getElementById('zrTechSummary').textContent   = ZOOM_RECOVERY.TECH_LABEL;
zrCancelNoteEl.textContent                             = ZOOM_RECOVERY.CANCEL_NOTE;
document.getElementById('zrDownloadLabel').textContent = ZOOM_RECOVERY.ACTIONS.download;
zrDownloadBtn.setAttribute('aria-label', ZOOM_RECOVERY.DOWNLOAD_ARIA);
zrRecheckBtn.textContent = ZOOM_RECOVERY.ACTIONS.recheck;
zrChooseBtn.textContent  = ZOOM_RECOVERY.ACTIONS.choose;
zrCancelBtn.textContent  = ZOOM_RECOVERY.ACTIONS.cancel;

// True while a user-driven re-check (Check again button or installer-exit
// auto re-check) is in flight — its scan result picks the re-check state
// strings (still-not-found / success) instead of staying silent.
let zrRecheckPending = false;

function zrSetState(text) {
  zrStatusEl.textContent = text || '';
  zrStatusEl.hidden = !text;
}

// Toggle the "installer is running" presentation. While msiexec runs, the
// "Cancel setup" affordance and the "leaves this computer exactly as it is"
// note are both false, so the label and note swap to honest copy until the
// installer exits (onZoomInstallerDone restores them).
function zrSetInstalling(on) {
  zrCancelNoteEl.textContent = on ? ZOOM_RECOVERY.CANCEL_NOTE_INSTALLING : ZOOM_RECOVERY.CANCEL_NOTE;
  zrCancelBtn.textContent    = on ? ZOOM_RECOVERY.ACTIONS.close_installing : ZOOM_RECOVERY.ACTIONS.cancel;
}

// Called with the zoom checklist card + resolveZoomInstall() data after
// every environment scan (and with nulls when the scan itself failed).
function updateZoomRecovery(zoomCard, install) {
  const blocked = !!zoomCard && zoomCard.status === 'blocked';
  if (!blocked) {
    if (zrRecheckPending && !zoomRecoveryEl.hidden && zoomCard) {
      // Requirement passes after a user-driven re-check: card flips to
      // pass — success string announced; the ready checklist row above
      // takes over. The next ordinary scan hides the card entirely.
      zoomRecoveryEl.dataset.state = 'pass';
      zrSetState(ZOOM_RECOVERY.STATES.success);
    } else {
      zoomRecoveryEl.hidden = true;
      zoomRecoveryEl.dataset.state = '';
      zrSetState('');
    }
    zrRecheckPending = false;
    return;
  }
  const wasQuiet = zoomRecoveryEl.hidden || zoomRecoveryEl.dataset.state === 'pass';
  zoomRecoveryEl.dataset.state = 'blocked';
  zoomRecoveryEl.hidden = false;
  zrTechEl.textContent = zoomRecoveryTechDetails(install);
  const perUserOnly = !!(install && install.perUserPath && !install.path);
  if (perUserOnly) {
    zrSetState(ZOOM_RECOVERY.STATES.wrong_version);
  } else if (zrRecheckPending) {
    zrSetState(ZOOM_RECOVERY.STATES.still_not_found);
  } else if (wasQuiet) {
    // First render: title + description carry the message; state strings
    // are reserved for user-driven events ("still cannot find" would be
    // untrue before the user re-checked anything).
    zrSetState('');
  }
  zrRecheckPending = false;
}

zrDownloadBtn.addEventListener('click', async () => {
  zrSetState(ZOOM_RECOVERY.STATES.downloading);
  let opened = false;
  try {
    const r = await window.electronAPI.zoomOpenDownload();
    opened = !!(r && r.success);
  } catch (_) { /* offline path below */ }
  zrSetState(opened ? ZOOM_RECOVERY.STATES.waiting : ZOOM_RECOVERY.STATES.offline);
});

// Re-runs the SAME detection the scan already uses (resolveZoomInstall via
// preflight) — no wizard restart, no parallel detection path.
function zrStartRecheck() {
  // Same guards as runEnvironmentScan — a no-op scan must never leave a
  // stale "Checking…" state on screen.
  if (isRunning || scanInProgress) return;
  zrRecheckPending = true;
  zrSetState(ZOOM_RECOVERY.STATES.checking);
  runEnvironmentScan();
}
zrRecheckBtn.addEventListener('click', zrStartRecheck);

let zrChooseBusy = false;
zrChooseBtn.addEventListener('click', async () => {
  if (zrChooseBusy) return;
  zrChooseBusy = true;
  zrChooseBtn.disabled = true;
  try {
    const r = await window.electronAPI.zoomChooseInstaller();
    if (r && r.ok) {
      // Explain the Windows admin-approval prompt BEFORE msiexec starts.
      zrSetState(ZOOM_RECOVERY.UAC_NOTE);
      const run = await window.electronAPI.zoomRunInstaller();
      if (run && run.started) {
        // msiexec is running: closing 1132 Fixer no longer cancels anything.
        zrSetInstalling(true);
      } else if (run && run.message) {
        // Re-check refused the file (it changed after validation) — nothing ran.
        zrSetState(run.message);
      } else {
        // { started: false } with NO message — the approved descriptor was
        // already consumed, or the spawn threw. Nothing launched. Without
        // this branch the pre-launch UAC notice stayed on screen promising
        // a Windows prompt and an automatic re-check, neither of which
        // happened: a launch that never ran, rendered as one in progress.
        zrSetState(INSTALLER_NOT_STARTED);
      }
    } else if (r && !r.canceled) {
      // Explained refusal naming the exact failed check — nothing was run.
      zrSetState(r.message || zoomInstallerRefusal(null));
    }
    // Picker canceled: no state change — nothing happened, nothing claimed.
  } catch (err) {
    zrSetState(zoomInstallerRefusal(null, err && err.message));
  } finally {
    zrChooseBusy = false;
    zrChooseBtn.disabled = false;
  }
});

zrCancelBtn.addEventListener('click', () => window.electronAPI.quitApp());

// ============================================================
// Fix Receipt — styled cards
// ============================================================
// Builds the "Repair results" rows for the Details view. Nothing is
// rendered here; the view reads lastReceiptItems when it opens.
function renderFixReceipt(receipt, warnings) {
  void warnings;
  if (!receipt) {
    // A run that reports success but returns no receipt has proven none of
    // the four things the receipt exists to prove. Every item reads as
    // "Unable to verify" — the missing evidence must never read as
    // "nothing to report".
    lastReceipt = null;
    lastReceiptItems = ['camera', 'microphone', 'hku', 'frameServer']
      .map(key => receiptItemView(key, 'warn', 'The fix did not report a result for this item. Run the fix again, or send a support report.'));
    refreshDetailsIfOpen();
    return;
  }
  lastReceipt = receipt;
  const cam = receiptStatusFor(receipt.camera);
  const mic = receiptStatusFor(receipt.microphone);
  const hku = describeHku(receipt.hkuPath);
  const fs  = describeFrameServer(receipt.frameServer);
  // 'info' on the profile-settings item means the permissions were written
  // (live session or a temporary load) — a completed step, not an unknown.
  const hkuStatus = hku.icon === 'info' ? 'ok' : hku.icon;
  lastReceiptItems = [
    receiptItemView('camera',      cam.status, receiptPlainText(cam.status, 'camera')),
    receiptItemView('microphone',  mic.status, receiptPlainText(mic.status, 'microphone')),
    receiptItemView('hku',         hkuStatus,  hkuStatus === 'ok' ? '' : 'The permission settings for the helper account could not be fully applied. Run the fix again if Zoom cannot use the camera or microphone.'),
    receiptItemView('frameServer', fs.icon,    fs.icon === 'ok' ? ''
      : fs.icon === 'fail' ? 'The camera service is not available on this PC, so cameras may not work in Zoom.'
      : 'The camera service could not be confirmed. Cameras may not work in Zoom.')
  ];
  refreshDetailsIfOpen();
}

// Plain-English explanation for a camera/microphone receipt outcome. The
// catalog text (messages.js) is written for the support report.
function receiptPlainText(status, device) {
  if (status === 'ok') return '';
  if (status === 'fail') return `A Windows policy blocks ${device} access. If this PC is managed by an organization, ask them to allow it.`;
  return `The ${device} permission could not be confirmed. Check it in Windows Settings under Privacy if Zoom cannot use the ${device}.`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// Focus trap — modals.
// Cycles Tab / Shift+Tab inside the overlay, restores focus to the
// element that opened the modal on close. Handles 0 / 1 focusable
// element without throwing (Tab becomes a no-op rather than an error).
// ============================================================
const FOCUSABLE_SEL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SEL)).filter(el => {
    // Skip elements that aren't actually rendered (display:none ancestors).
    return el.offsetParent !== null || el === document.activeElement;
  });
}

function installFocusTrap(overlay) {
  if (!overlay) return () => {};
  const opener = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;

  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const items = getFocusable(overlay);
    if (items.length === 0) { e.preventDefault(); return; }
    if (items.length === 1) { e.preventDefault(); items[0].focus(); return; }
    const first = items[0];
    const last  = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !overlay.contains(active)) { e.preventDefault(); first.focus(); }
    }
  };
  overlay.addEventListener('keydown', handler);

  // Focus the first focusable on open, deferred so layout settles.
  setTimeout(() => {
    const items = getFocusable(overlay);
    if (items.length) items[0].focus();
  }, 0);

  return function release() {
    overlay.removeEventListener('keydown', handler);
    // Restore focus to the opener so keyboard users land back where they
    // were. Guard against the opener having been removed from the DOM.
    if (opener && document.contains(opener) && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (_) { /* opener no longer focusable */ }
    }
  };
}

// ============================================================
// FIX NOW — confirmation, then the complete run-fix orchestrator.
// Never routes to launch-zoom-helper. A successful preflight is not
// a reason to skip the helper-account reset.
// ============================================================
let pendingFixAfterScan = false;
const fixConfirmOverlay = document.getElementById('fixConfirmOverlay');
const fixConfirmContinue = document.getElementById('fixConfirmContinue');
const fixConfirmCancel = document.getElementById('fixConfirmCancel');

function hideFixConfirm() {
  if (!fixConfirmOverlay) return;
  fixConfirmOverlay.hidden = true;
}

function showFixConfirm() {
  if (!fixConfirmOverlay) {
    runFix();
    return;
  }
  const title = document.getElementById('fixConfirmTitle');
  const body = document.getElementById('fixConfirmBody');
  if (title) title.textContent = WIZARD.CONFIRM_TITLE;
  if (body) body.textContent = WIZARD.CONFIRM_BODY;
  if (fixConfirmContinue) fixConfirmContinue.textContent = WIZARD.CONFIRM_CONTINUE;
  if (fixConfirmCancel) fixConfirmCancel.textContent = WIZARD.CONFIRM_CANCEL;
  fixConfirmOverlay.hidden = false;
  if (fixConfirmContinue) fixConfirmContinue.focus();
}

if (fixConfirmContinue) {
  fixConfirmContinue.addEventListener('click', () => {
    hideFixConfirm();
    runFix();
  });
}
if (fixConfirmCancel) {
  fixConfirmCancel.addEventListener('click', hideFixConfirm);
}
if (fixConfirmOverlay) {
  fixConfirmOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideFixConfirm();
      if (fixBtn && !fixBtn.hidden) fixBtn.focus();
    }
  });
}

function onFixButtonClick() {
  if (isRunning) return;
  if (scanInProgress) {
    pendingFixAfterScan = true;
    fixBtn.textContent = 'Starting after check…';
    return;
  }
  if (!canRunFix) return;
  showFixConfirm();
}

// ============================================================
// Run Fix flow
// ============================================================
async function runFix() {
  if (isRunning) return;

  // The desktop-shortcut option rides the repair transaction — read it
  // before the actions area is repainted for the running state.
  const wantShortcut = document.getElementById('shortcutOptInput').checked;

  isRunning = true;
  // No CTA during automatic work, and ONE status voice: the wizard body
  // itself. The header badge hides until an outcome lands (setStatus
  // re-shows it).
  setActions({});
  document.getElementById('statusBadge').hidden = true;

  // Wizard: fixing pane — stage tracker + latest action. The raw log keeps
  // recording underneath in Advanced details, collapsed.
  setWizardPane('fixing');
  resetStages();
  advanceStageTo('prep');
  lastReceiptItems = null;
  refreshDetailsIfOpen();
  clearFileList();
  addFileItem('STARTING FIX...', 'header');
  addEmptyLine();

  try {
    const result = await window.electronAPI.runFix();

    addEmptyLine();
    if (result && result.success) {
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const steps = Array.isArray(result.steps) ? result.steps : [];
      // Verdict + header live in run-verdict.js (loaded before this script,
      // shared with main.js). Legacy results without steps keep the old
      // warning-count headline unchanged.
      const verdict = computeRunVerdict(steps, warnings, []);
      const partial = !!result.partial || verdict.partial;
      if (partial) {
        addFileItem(VERDICT_HEADERS.attention, 'header');
        finalizeStages('warn');
        setStatus('warn', 'Needs attention');
      } else if (warnings.length) {
        addFileItem(verdict.header, 'header');
        finalizeStages('warn');
        setStatus('warn', 'Fixed (warnings)');
      } else {
        addFileItem(verdict.header, 'header');
        finalizeStages('ok');
        setStatus('done', 'Fixed');
      }
      renderFixReceipt(result.receipt, warnings);

      const failedSteps = steps.filter(s => s && s.outcome === 'fail');
      if (warnings.length || failedSteps.length) {
        addEmptyLine();
        addFileItem('WARNINGS', 'header');
        failedSteps.forEach(s => addFileItem(`  • ${s.label}: ${s.detail}`, 'failed'));
        warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
      }

      // Desktop shortcut: part of the same transaction when the option is
      // checked (default). Idempotent — the managed shortcut is replaced
      // in place and legacy names are cleaned, never duplicated.
      //
      // Isolated from the verdict above. This block lives INSIDE the same
      // try as the fix itself, so a throw here used to be caught by the
      // outer handler and repaint a fix that had already SUCCEEDED as
      // "FIX FAILED". The shortcut is a separate operation with a separate
      // outcome, and it reports itself.
      addEmptyLine();
      let shortcutNote = '';
      let shortcutFailed = false;
      let shortcutSkipped = false;
      try {
        const status = await window.electronAPI.shortcutExists();
        if (status && status.exists && status.valid) {
          addFileItem(`Desktop shortcut already present: ${status.path}`, 'success');
          shortcutNote = 'Desktop shortcut is ready: Zoom — User1';
        } else if (!wantShortcut) {
          shortcutSkipped = true;
          addFileItem('Desktop shortcut skipped (option unchecked).', 'header');
          shortcutNote = 'Desktop shortcut not created — you can create it from this screen.';
        } else {
          if (status && status.exists && status.stale) {
            addFileItem('An existing desktop shortcut no longer points at this app — replacing it.', 'failed');
          }
          const sc = await createShortcut(true);
          if (sc.ok) shortcutNote = 'Desktop shortcut created: Zoom — User1';
          else shortcutFailed = true;
        }
      } catch (err) {
        // Unknown shortcut state: say so, and do not imply the shortcut is
        // there. The fix verdict above is untouched.
        shortcutFailed = true;
        addFileItem(
          'Could not check whether the desktop shortcut exists, so it was not created. ' +
          'The fix itself is unaffected — use the "Create desktop shortcut" button to try again.' +
          (err && err.message ? ` Detail for support: ${err.message}` : ''),
          'failed'
        );
      }

      // Wizard outcome pane — a real terminal screen: Launch as User1 is
      // the next step; details and support are one quiet click away.
      const outcomeActions = {
        launch: !shortcutFailed,
        shortcut: shortcutFailed || shortcutSkipped,
        shortcutQuiet: shortcutSkipped && !shortcutFailed,
        details: true,
        note: shortcutNote
      };
      if (partial) {
        showNoticePane('warn', WIZARD.PARTIAL_TITLE, WIZARD.PARTIAL_SUB);
      } else if (warnings.length) {
        showNoticePane('ok', WIZARD.SUCCESS_TITLE, WIZARD.WARNINGS_SUB);
      } else {
        showNoticePane('ok', WIZARD.SUCCESS_TITLE, WIZARD.SUCCESS_SUB);
      }
      setActions(outcomeActions);
    } else {
      const res = result || {};
      addFileItem(`FIX FAILED: ${friendlyError(res.error)}`, 'failed');
      if (Array.isArray(res.blockers) && res.blockers.length) {
        res.blockers.forEach(b => addFileItem(`  • [${b.code}] ${b.message}`, 'failed'));
      }
      if (Array.isArray(res.warnings) && res.warnings.length) {
        res.warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
      }
      finalizeStages('fail');
      setStatus('error', 'Something went wrong');
      showNoticePane('err', WIZARD.FAIL_TITLE, friendlyError(res.error));
      setActions({ fix: true, fixLabel: 'Try again', details: true, support: true, copyErr: true });
    }
  } catch (err) {
    // The fix IPC (or a renderer helper it calls) threw. Surface it instead
    // of dying as a silent unhandled rejection.
    addEmptyLine();
    addFileItem(`FIX FAILED: ${unexpectedFixFailure(err)}`, 'failed');
    finalizeStages('fail');
    setStatus('error', 'Something went wrong');
    showNoticePane('err', WIZARD.FAIL_TITLE, unexpectedFixFailure(err));
    setActions({ fix: true, fixLabel: 'Try again', details: true, support: true, copyErr: true });
  } finally {
    // Always release the run lock — the outcome branches above own the
    // action-area state.
    isRunning = false;
  }
}

// friendlyError() and the rest of the user-facing copy live in messages.js
// (loaded before this script; require()-able by tools/messages-smoke.js).

// ============================================================
// Copy error details — failure-only chip next to the log toggle.
// Reuses the support-report IPC so the copied text is the SANITIZED bundle
// (SIDs, username, home path, hostname redacted). If the report cannot be
// built, falls back to the raw visible log lines — text already on screen.
// ============================================================
const COPY_ERR_LABEL = 'Copy error details';
copyErrBtn.addEventListener('click', async () => {
  copyErrBtn.disabled = true;
  let text = '';
  try {
    const result = await window.electronAPI.supportReport({
      receipt: lastReceipt,
      logTail: logBuffer.join('\n'),
      stage:   lastStageLabel
    });
    text = (result && result.markdown) || '';
  } catch (_) { /* fall through to the visible log lines */ }
  if (!text) text = logBuffer.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    copyErrBtn.textContent = 'Copied — paste into your support message';
  } catch (_) {
    copyErrBtn.textContent = 'Auto-copy blocked — use Feedback & Report instead';
  }
  setTimeout(() => {
    copyErrBtn.textContent = COPY_ERR_LABEL;
    copyErrBtn.disabled = false;
  }, 2600);
});

// ============================================================
// Shortcut helper — direct create, no prompt.
// ============================================================
// Never throws: the two callers (the post-fix step and the toolbar button)
// must not have their own outcome rewritten by a shortcut failure. It used
// to have no try/catch at all, so an IPC rejection from the toolbar button
// produced an unhandled rejection and NOTHING on screen — the user clicked
// and the app said neither "done" nor "failed".
// Returns { ok, path?, error? } — ok true only when the shortcut was
// actually created. The raw error goes to the log (Advanced details); the
// callers translate the outcome into wizard copy.
async function createShortcut(showHeader) {
  if (showHeader) {
    addFileItem('CREATING ZOOM HELPER SHORTCUT...', 'header');
  }
  let result;
  try {
    result = await window.electronAPI.createShortcut();
  } catch (err) {
    addFileItem(shortcutFailureMessage(err && err.message), 'failed');
    return { ok: false, error: err && err.message };
  }
  // A missing/void result is not a success. `result.success` on undefined
  // used to throw here and get swallowed by the caller.
  if (!result || !result.success) {
    addFileItem(shortcutFailureMessage(result && result.error), 'failed');
    return { ok: false, error: (result && result.error) || '' };
  }
  addFileItem(`Shortcut created: ${result.path}`, 'success');

  // An old shortcut we could not delete is the exact problem the rename
  // cleanup exists to prevent, so it is never swallowed by the success line:
  // the user is told which file to remove, in plain words.
  const failed = result.legacyRemovalFailed || [];
  if (failed.length) {
    addFileItem(
      `Could not remove ${failed.length === 1 ? 'the older shortcut' : `${failed.length} older shortcuts`} — delete ${failed.length === 1 ? 'it' : 'them'} by hand so you do not have two:`,
      'failed'
    );
    for (const f of failed) addFileItem(`    ${f.path}`, 'failed');
  } else if ((result.legacyRemoved || []).length) {
    addFileItem(`Older shortcut removed: ${result.legacyRemoved.join(', ')}`, 'success');
  }
  return { ok: true, path: result.path };
}

// ============================================================
// Update banner — mirrors main-process 'update-status' events.
// Main owns the real timers; this is display + two buttons.
// ============================================================
const updateBanner  = document.getElementById('updateBanner');
const ubMsg         = document.getElementById('ubMsg');
const ubRestart     = document.getElementById('ubRestart');
const ubDownload    = document.getElementById('ubDownload');
const ubLater       = document.getElementById('ubLater');
const ubProgress    = document.getElementById('ubProgress');
const ubProgressFill= document.getElementById('ubProgressFill');

let ubTickTimer = null;
let ubHideTimer = null;

function ubClearTimers() {
  if (ubTickTimer) { clearInterval(ubTickTimer); ubTickTimer = null; }
  if (ubHideTimer) { clearTimeout(ubHideTimer); ubHideTimer = null; }
}

function ubShow({ msg, restartBtn = false, downloadBtn = false, laterBtn = false, progress = null }) {
  updateBanner.classList.add('visible');
  ubMsg.textContent = msg;
  ubRestart.style.display = restartBtn ? '' : 'none';
  ubDownload.style.display = downloadBtn ? '' : 'none';
  ubLater.style.display = laterBtn ? '' : 'none';
  if (progress === null) {
    ubProgress.style.display = 'none';
  } else {
    ubProgress.style.display = '';
    ubProgressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

function ubHide() {
  updateBanner.classList.remove('visible');
}

// State -> banner view lives in ui-state.js (updateBannerView), covered by
// tools/ui-state-smoke.js. Two behaviours changed there:
//
//  - a payload with no state, or a state this version does not recognise,
//    used to hit `default: ubHide()` and render as an EMPTY banner. An
//    empty update banner reads as "you are up to date"; an update state we
//    could not determine is not that. It now says so, with a Later button
//    so it is still dismissable.
//  - the 'error' banner auto-hid itself after 6 seconds, so a failed
//    update check erased its own evidence and left the app looking
//    current. It now stays until the user dismisses it.
function handleUpdateStatus(data) {
  ubClearTimers();
  const view = updateBannerView(data);
  if (!view.show) { ubHide(); return; }
  if (view.countdown) {
    let remaining = view.seconds;
    const render = () => ubShow({
      msg: view.msg.replace('{s}', String(remaining)),
      restartBtn: !!view.restartBtn,
      laterBtn: !!view.laterBtn
    });
    render();
    ubTickTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { ubClearTimers(); return; }
      render();
    }, 1000);
    return;
  }
  ubShow({
    msg: view.msg,
    restartBtn: !!view.restartBtn,
    downloadBtn: !!view.downloadBtn,
    laterBtn: !!view.laterBtn,
    progress: typeof view.progress === 'number' ? view.progress : null
  });
}

ubRestart.addEventListener('click', () => {
  ubClearTimers();
  ubShow({ msg: 'Installing update — the app will restart itself…' });
  window.electronAPI.installUpdateNow();
});
ubDownload.addEventListener('click', () => {
  window.electronAPI.openDownloadPage();
  ubShow({ msg: 'Download page opened in your browser — grab the newest version there.' });
  ubHideTimer = setTimeout(ubHide, 8000);
});
ubLater.addEventListener('click', () => {
  ubClearTimers();
  // Hide immediately; a downloaded NSIS update re-shows itself as 'deferred'
  // via the main process, and the portable notice returns on the next 4h check.
  ubHide();
  window.electronAPI.deferUpdate();
});

// ============================================================
// Bootstrap
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  const api = window.electronAPI;
  if (!api || typeof api.startupStatus !== 'function') {
    showUnableToComplete('preload');
    return;
  }
  // Exit is owned by the compact shell (it confirms while a fix runs).
  fixBtn.addEventListener('click', onFixButtonClick);
  // Explicit manual rescan (§9) — same guarded entry point as the
  // focus-rescan; runEnvironmentScan() no-ops while a scan or fix runs.
  rescanBtn.addEventListener('click', () => {
    if (rescanBtn.textContent === WIZARD.TRY_AGAIN) runStartupSequence();
    else runEnvironmentScan();
  });
  if (closeBtn) closeBtn.addEventListener('click', () => api.quitApp());
  // "View details" opens the Details view in place; Back (header) and
  // Escape return to the exact prior screen.
  detailsBtn.addEventListener('click', openDetails);
  backBtn.addEventListener('click', closeDetails);
  detailsOverviewBtn.addEventListener('click', () => showDetailsOverview());
  document.getElementById('footerSupportBtn').addEventListener('click', () => openSupportReport());
  document.getElementById('aboutBtn').addEventListener('click', showAbout);
  shortcutBtn.addEventListener('click', async () => {
    // Direct create — no confirmation round-trip. The raw result logs to
    // Advanced details; the wizard shows the friendly outcome.
    if (isRunning) return;
    shortcutBtn.disabled = true;
    const sc = await createShortcut(true);
    shortcutBtn.disabled = false;
    if (sc.ok) {
      showNoticePane('ok', WIZARD.SHORTCUT_DONE_TITLE, WIZARD.SHORTCUT_DONE_SUB);
      setActions({ rescan: true, details: true });
      return;
    }
    // "No stored helper sign-in" is a sequencing state, not a failure: the
    // repair has to run once before a shortcut can exist. Everything else
    // is a genuine (but recoverable) failure — retry + details, never a
    // red raw log line in the primary flow.
    if (/no stored helper sign-in/i.test(sc.error || '')) {
      showNoticePane('warn', WIZARD.SHORTCUT_NOT_READY_TITLE, WIZARD.SHORTCUT_NOT_READY_SUB);
      setActions({
        fix: canRunFix,
        shortcut: !canRunFix, shortcutQuiet: true,
        rescan: true, details: true
      });
    } else {
      showNoticePane('warn', WIZARD.SHORTCUT_FAILED_TITLE, WIZARD.SHORTCUT_FAILED_SUB);
      setActions({ shortcut: true, rescan: true, details: true });
    }
  });

  api.onFixLog(({ line, kind }) => {
    const cls = kind === 'err' ? 'failed'
      : kind === 'header'  ? 'header'
      : kind === 'success' ? 'success'
      : '';
    addFileItem(line, cls);
  });

  api.onUpdateStatus(handleUpdateStatus);

  // Installer exited — run the promised read-only re-check automatically.
  // If a scan is already in flight, the pending flag makes ITS result use
  // the re-check state strings instead of starting a second scan.
  api.onZoomInstallerDone((info) => {
    // Installer exited: the "Cancel setup" label and unchanged-computer note
    // are true again.
    zrSetInstalling(false);
    if (isRunning) return;
    zrRecheckPending = true;
    // A non-zero msiexec exit means the install did NOT complete — the most
    // common cause is the user declining the Windows administrator prompt
    // (1223) or cancelling the installer (1602). The exit code was being
    // dropped, so a declined elevation went straight into a silent re-check.
    // A decline must not read as progress.
    const declined = installerExitNote(info && info.code);
    if (!scanInProgress) {
      zrSetState(declined || ZOOM_RECOVERY.STATES.checking);
      runEnvironmentScan();
    } else if (declined) {
      zrSetState(declined);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.defaultPrevented) return;
    // Enter activates the primary only on the screen that shows it: never
    // from the Details view, never while a dialog is open, and never when
    // focus is already on a control (that control handles its own Enter).
    if (detailsOpen()) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.tagName !== 'INPUT' && active !== fixBtn && active !== launchBtn && active !== elevateBtn) return;
    const overlayOpen = [...document.querySelectorAll('.fix-confirm-overlay, .fb-overlay.show, .compact-exit-overlay')]
      .some((el) => el && !el.hidden && (el.classList.contains('show') || !el.hidden));
    if (overlayOpen) return;
    const primary = [elevateBtn, fixBtn, launchBtn].find((b) => b && !b.hidden && !b.disabled);
    if (primary) {
      event.preventDefault();
      primary.click();
    }
  });
  try {
    await runStartupSequence();
  } catch (err) {
    showUnableToComplete((err && err.stage) || 'startup');
  }
});

const STARTUP_DEADLINE_MS = 8000;

function showAdminRequired() {
  canRunFix = false;
  // Only the administrator check has a result; everything else is
  // unverified until the app runs elevated.
  lastScan = { statusByKey: { admin: 'blocked' } };
  refreshDetailsIfOpen();
  setStatus('warn', 'Action required');
  showResultPane('warn', WIZARD.ADMIN_TITLE, WIZARD.ADMIN_SUB);
  setActions({ elevate: true, close: true, details: true });
}

function showUnableToComplete(stage) {
  canRunFix = false;
  addFileItem(`Startup stopped at ${stage || 'startup'}.`, 'failed');
  setStatus('error', 'Unable to complete');
  showNoticePane('err', WIZARD.UNABLE_TITLE, WIZARD.UNABLE_SUB);
  setActions({ rescan: true, rescanLabel: WIZARD.TRY_AGAIN, close: true, details: true });
}

async function runStartupSequence() {
  setWizardPane('checking');
  renderWizChecks(null);
  setActions({});
  const startedAt = Date.now();
  let status;
  try {
    status = await Promise.race([
      window.electronAPI.startupStatus(),
      new Promise((_, reject) => setTimeout(() => {
        const err = new Error('timeout:startup-status');
        err.stage = 'startup-status';
        reject(err);
      }, STARTUP_DEADLINE_MS))
    ]);
  } catch (err) {
    showUnableToComplete((err && err.stage) || 'startup-status');
    return;
  }
  addFileItem(`Startup ${status.state} in ${status.elapsedMs || (Date.now() - startedAt)}ms via ${status.elevationMethod || 'unknown'}.`, 'header');
  if (status.state === 'need-elevation' || status.elevated !== true) {
    showAdminRequired();
    return;
  }
  if (status.runningAsTarget) {
    showResultPane('warn', WIZARD.BLOCKED_TITLE, wizardBlockedSub(['Signed in as user1']));
    setActions({ close: true, details: true });
    return;
  }
  canRunFix = true;
  showResultPane('ok', WIZARD.READY_TITLE, WIZARD.READY_SUB);
  setActions({ fix: true, shortcutOption: true, details: true });
  runEnvironmentScan({ quiet: true });
}

// "Continue as administrator" — asks main to relaunch elevated. Windows
// shows its own approval prompt; on success main quits this instance, so
// the button only needs to handle the declined path.
elevateBtn.addEventListener('click', async () => {
  elevateBtn.disabled = true;
  elevateBtn.textContent = 'Waiting for Windows approval…';
  let started = false;
  let outcome = 'failed';
  try {
    const r = await window.electronAPI.relaunchElevated();
    started = !!(r && r.started);
    if (r && typeof r.outcome === 'string') outcome = r.outcome;
  } catch (_) { /* treated as declined */ }
  if (started) {
    elevateBtn.textContent = WIZARD.ADMIN_RESTARTING;
    return; // main.js quits this instance; the elevated one takes over
  }
  // Plain-English reason under View details. No PowerShell text.
  const reasons = {
    declined: 'Windows approval was cancelled or refused.',
    timeout: 'Windows approval was not answered in time.',
    'launch-error': 'Windows PowerShell could not be started to request approval.',
    failed: 'Windows did not confirm that the restart began.',
    'already-elevated': 'The app is already running as administrator.'
  };
  addFileItem(`Restart as administrator: ${reasons[outcome] || reasons.failed}`, 'failed');
  elevateBtn.disabled = false;
  elevateBtn.textContent = WIZARD.ADMIN_PRIMARY;
  showResultPane('warn', WIZARD.ADMIN_TITLE, WIZARD.ADMIN_DECLINED_SUB);
  setActions({ elevate: true, close: true, details: true });
});

// "Open Zoom" (§21) — runs the SAME launcher artifact the desktop
// shortcut runs (no secret travels; the script unseals the DPAPI blob).
launchBtn.addEventListener('click', async () => {
  launchBtn.disabled = true;
  let ok = false;
  try {
    const r = await window.electronAPI.launchZoomHelper();
    ok = !!(r && r.success);
  } catch (_) { /* reported below */ }
  buttonNote.textContent = ok
    ? 'Zoom is starting as the helper account.'
    : 'Could not start Zoom — run the fix once, then try again.';
  buttonNote.hidden = false;
  setTimeout(() => { launchBtn.disabled = false; }, 1500);
});

// "Support Report" — same sanitized report modal as the feedback flow.
supportBtn.addEventListener('click', () => openSupportReport());

// ============================================================
// Footer: app version + admin badge
// ============================================================
(async () => {
  // Version stays hidden until the real value arrives — no "v—" placeholder.
  try {
    const v = await window.electronAPI.getVersion();
    const el = document.getElementById('appVersion');
    el.textContent = 'v' + v;
    el.hidden = false;
  } catch (_) { /* stays hidden */ }
  const ab = document.getElementById('adminBadge');
  if (ab) {
    ab.hidden = true;
    ab.textContent = '';
  }
})();

// ============================================================
// Feedback modal — single Submit Feedback / Report entry: chooser (bug /
// rating / message+support-request), attach-report flow, report preview link
// ============================================================
const ratings = { ease: 0, resolved: 0, recommend: 0, overall: 0 };
let feedbackMode = '';
let releaseFeedbackTrap = null;

function showSection(id) {
  document.querySelectorAll('.fb-section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function openFeedback() {
  const overlay = document.getElementById('fbOverlay');
  overlay.classList.add('show');
  showSection('fbChoose');
  feedbackMode = '';
  document.querySelectorAll('.fb-textarea').forEach(t => { t.value = ''; });
  attachGen++;
  const attachBtn = document.getElementById('fbAttachReport');
  attachBtn.disabled = false;
  attachBtn.textContent = 'Attach Support Report';
  document.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('.fb-status').forEach(s => { s.textContent = ''; s.className = s.className.includes('fb-shot-status') ? 'fb-status fb-shot-status' : 'fb-status'; });
  Object.keys(ratings).forEach(k => { ratings[k] = 0; });
  clearScreenshot();
  refreshScreenshotCapability();
  loadSysInfo();
  releaseFeedbackTrap = installFocusTrap(overlay);
}
function closeFeedback() {
  document.getElementById('fbOverlay').classList.remove('show');
  if (releaseFeedbackTrap) { releaseFeedbackTrap(); releaseFeedbackTrap = null; }
}

async function loadSysInfo() {
  try {
    const info = await window.electronAPI.getSystemInfo();
    const el = document.getElementById('fbSysInfo');
    // Tri-state: true / false / null. null means the elevation probe itself
    // failed — reported as Unknown, not folded into "No" and certainly not
    // into "Yes" (which is what this line printed unconditionally before,
    // because main hardcoded admin: true).
    const admin = info.admin === true ? 'Yes' : info.admin === false ? 'No' : 'Unknown (could not check)';
    el.textContent = `Version: ${info.version}\nOS: ${info.os}\nAdmin: ${admin}`;
  } catch (_) {
    document.getElementById('fbSysInfo').textContent = 'Could not load system info';
  }
}

document.getElementById('btnSupport').addEventListener('click', openFeedback);

// ============================================================
// Explore modal (directive 2026-08-23) — a destination CHOOSER only. The
// renderer sends a fixed key ('fixer' | 'botify'); the main process owns
// the key→URL map and the https allowlist, and the site opens in the
// system browser — this window never navigates anywhere.
// ============================================================
const exploreOverlay = document.getElementById('exploreOverlay');
const exploreStatus  = document.getElementById('exploreStatus');
let releaseExploreTrap = null;

// External-open indicator (16×16) and the generic fallback glyph for
// destinations without a supplied logo (§33: simple web glyph — never a
// broken image, never invented artwork).
const EXPLORE_OPEN_SVG =
  `<svg class="explore-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const EXPLORE_FALLBACK_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>`;

// Project disclosure (addendum 2026-08-23) — filled from the messages.js
// DISCLOSURE catalog into both instances (shell + Explore), so the exact
// approved wording lives in one place. Informational only: no canonical
// click target was mandated, so nothing here is a link.
// Icon: the operator's 1132 open-source badge (assets/brand/
// open-source-badge.png) at 16px — trust metadata, never a CTA.
function renderDisclosure(el) {
  if (!el) return;
  el.setAttribute('aria-label', DISCLOSURE.ARIA);
  el.innerHTML = `<img class="os-icon" src="assets/brand/open-source-badge.png" alt="" aria-hidden="true">` +
    `<span class="os-label">${escapeHtml(DISCLOSURE.OS_LABEL)}</span>` +
    `<span class="os-sep" aria-hidden="true">·</span>` +
    `<span class="os-independence">${escapeHtml(DISCLOSURE.INDEPENDENCE)}</span>`;
}
renderDisclosure(document.getElementById('projectDisclosure'));
// The Explore panel no longer renders a global disclosure line — the
// independence statement is part of the 1132 Fixer hero, built below.

const aboutOverlay = document.getElementById('aboutOverlay');
const aboutBody = document.getElementById('aboutBody');
const aboutLegal = document.getElementById('aboutLegal');
const aboutClose = document.getElementById('aboutClose');
if (aboutBody) aboutBody.textContent = DISCLOSURE.DESCRIPTION;
if (aboutLegal) aboutLegal.textContent = DISCLOSURE.LEGAL;
function showAbout() {
  if (!aboutOverlay) return;
  aboutOverlay.hidden = false;
  if (aboutClose) aboutClose.focus();
}
function hideAbout() {
  if (aboutOverlay) aboutOverlay.hidden = true;
}
if (aboutClose) aboutClose.addEventListener('click', hideAbout);
if (aboutOverlay) {
  aboutOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideAbout();
    }
  });
}

// Build the launcher panel from the EXPLORE_VIEW catalog (messages.js) —
// destinations are declared once, never hand-duplicated across markup.
// Each button carries its fixed key in data-explore; the key→URL map
// stays in the main process.
function buildExplore() {
  document.getElementById('exploreSub').textContent = EXPLORE_COPY.SUB;
  const body = document.getElementById('exploreBody');
  body.innerHTML = '';

  // ONE card component with variants, not a card per category. The
  // variants differ only in accent rail and grid placement; duplicating
  // the markup is how the old panel ended up with an orphaned half-width
  // cell nobody could explain.
  const cardHtml = (d) => `
    <button class="explore-choice${d.accent ? ' accent-' + d.accent : ''}" type="button" data-explore="${escapeHtml(d.id)}"
            aria-label="Open ${escapeHtml(d.name)} in your default browser">
      <span class="explore-logo${d.icon ? '' : ' fallback'}">${
        d.icon ? `<img src="${escapeHtml(d.icon)}" alt="" loading="lazy">` : EXPLORE_FALLBACK_SVG
      }</span>
      <span class="explore-copy">
        <span class="explore-name">${escapeHtml(d.name)}</span>
        <span class="explore-desc">${escapeHtml(d.description)}</span>
      </span>
      ${EXPLORE_OPEN_SVG}
    </button>`;

  // THE HERO. 1132 Fixer is the subject of this panel, so it is not a
  // card in a grid - it is the panel's headline, and the disclaimer lives
  // INSIDE it. The old global footer read as a statement about every
  // product listed, including ones this project does not own.
  const heroHtml = (d) => `
    <section class="explore-hero" aria-labelledby="exploreHeroName">
      <div class="explore-hero-eyebrow">FEATURED</div>
      <div class="explore-hero-main">
        <div class="explore-hero-logo">${
          d.icon ? `<img src="${escapeHtml(d.icon)}" alt="">` : EXPLORE_FALLBACK_SVG
        }</div>
        <div class="explore-hero-copy">
          <h3 class="explore-hero-name" id="exploreHeroName">${escapeHtml(d.name)}</h3>
          <p class="explore-hero-desc">${escapeHtml(d.description)}</p>
        </div>
      </div>
      <div class="explore-hero-actions">
        <span class="explore-badge">${escapeHtml(DISCLOSURE.OS_LABEL)}</span>
        <button class="explore-visit" type="button" data-explore="${escapeHtml(d.id)}"
                aria-label="Open ${escapeHtml(d.name)} in your default browser">
          <span>${escapeHtml(EXPLORE_COPY.VISIT)}</span>${EXPLORE_OPEN_SVG}
        </button>
      </div>
      <p class="explore-hero-note" role="note">${escapeHtml(DISCLOSURE.INDEPENDENCE)}</p>
    </section>`;

  for (const cat of EXPLORE_CATEGORIES) {
    const items = EXPLORE_VIEW.filter(d => d.category === cat.id);
    if (!items.length) continue;

    if (cat.id === 'featured') {
      body.insertAdjacentHTML('beforeend', items.map(heroHtml).join(''));
      // The secondary directory heading, rendered once between the hero
      // and everything below it.
      const intro = document.createElement('div');
      intro.className = 'explore-network-intro';
      intro.innerHTML =
        `<h3 class="explore-network-title">${escapeHtml(EXPLORE_COPY.NETWORK_TITLE)}</h3>` +
        `<p class="explore-network-sub">${escapeHtml(EXPLORE_COPY.NETWORK_SUB)}</p>`;
      body.appendChild(intro);
      continue;
    }

    const section = document.createElement('section');
    section.className = 'explore-section explore-section-' + cat.id;

    // The group label is a real heading the section is labelled by, not
    // an aria-hidden decoration - a screen reader should be able to tell
    // that GIF Directory sits under Organizations and not under Bots.
    const labelId = 'exploreGroup-' + cat.id;
    section.setAttribute('aria-labelledby', labelId);
    const label = document.createElement('h3');
    label.className = 'explore-group';
    label.id = labelId;
    label.textContent = cat.label;
    section.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'explore-grid explore-grid-' + cat.id;
    grid.innerHTML = items.map(cardHtml).join('');
    section.appendChild(grid);
    body.appendChild(section);
  }

  // ONE listener per control. The trailing open-icon is inside the button
  // and decorative, so a click on it bubbles to exactly one handler -
  // there is no nested control to launch the browser twice.
  body.querySelectorAll('[data-explore]').forEach(el => {
    el.addEventListener('click', () => openExploreDestination(el.dataset.explore));
  });
}
buildExplore();

// Explore is reached from the About dialog only. About steps aside while
// the chooser is open and returns, with focus on the Explore control,
// when it closes.
function openExplore() {
  exploreStatus.textContent = '';
  exploreStatus.className = 'fb-status';
  hideAbout();
  exploreOverlay.classList.add('show');
  // installFocusTrap moves focus in and restores it to the opener
  // (the Explore button) on release.
  releaseExploreTrap = installFocusTrap(exploreOverlay);
}
// Closing Explore closes everything: About does not come back (operator
// request 2026-09-05). Focus returns to the About control in the footer.
function closeExplore() {
  exploreOverlay.classList.remove('show');
  if (aboutOverlay) aboutOverlay.hidden = true;
  if (releaseExploreTrap) { releaseExploreTrap(); releaseExploreTrap = null; }
  const about = document.getElementById('aboutBtn');
  if (about) about.focus();
}

async function openExploreDestination(key) {
  exploreStatus.className = 'fb-status';
  let ok = false;
  try {
    const r = await window.electronAPI.openExploreDestination(key);
    ok = !!(r && r.success);
  } catch (_) { /* rejected key or IPC failure — reported below */ }
  exploreStatus.textContent = ok ? EXPLORE_COPY.OPENED : EXPLORE_COPY.FAILED;
  exploreStatus.classList.add(ok ? 'ok' : 'err');
}

document.getElementById('btnExplore').addEventListener('click', openExplore);
document.getElementById('exploreClose').addEventListener('click', closeExplore);
// Backdrop click and Escape both dismiss — this modal is unrelated to the
// destructive fix flow, so normal dismissal is fine.
exploreOverlay.addEventListener('click', (e) => { if (e.target === exploreOverlay) closeExplore(); });
exploreOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); closeExplore(); }
});
['fbClose', 'fbBugCancel', 'fbRatingCancel', 'fbContactCancel'].forEach(id => {
  document.getElementById(id).addEventListener('click', closeFeedback);
});
['fbBugBack', 'fbRatingBack', 'fbContactBack'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => showSection('fbChoose'));
});
document.querySelectorAll('.fb-choice').forEach(el => {
  const activate = () => {
    feedbackMode = el.dataset.mode;
    if      (feedbackMode === 'bug')     showSection('fbBug');
    else if (feedbackMode === 'rating')  showSection('fbRating');
    else if (feedbackMode === 'contact') showSection('fbContact');
  };
  el.addEventListener('click', activate);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
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
document.getElementById('fbBugText').addEventListener('input', refreshBugSubmit);
document.getElementById('fbContactText').addEventListener('input', (e) => {
  document.getElementById('fbContactSubmit').disabled = e.target.value.trim().length < 50;
});

document.getElementById('fbViewReport').addEventListener('click', openSupportReport);

// Bug-report attach flow: pull the sanitized report into the bug description
// so one submission carries both. attachGen invalidates an in-flight build
// when the modal is closed/reopened (openFeedback bumps it), so a stale IPC
// completion can't write into a fresh form. Budget leaves headroom under the
// proxy's 4,000-char MAX_TEXT_CHARS for the auto-appended system-info block.
const MAX_ATTACH_CHARS = 3700;
let attachGen = 0;
document.getElementById('fbAttachReport').addEventListener('click', async () => {
  const btn = document.getElementById('fbAttachReport');
  const status = document.getElementById('fbBugStatus');
  status.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Attaching…';
  const gen = attachGen;
  try {
    const result = await window.electronAPI.supportReport({
      receipt: lastReceipt,
      logTail: logBuffer.join('\n'),
      stage:   lastStageLabel
    });
    if (gen !== attachGen) return;
    const md = result && result.markdown;
    if (!md) throw new Error('report unavailable');
    const ta = document.getElementById('fbBugText');
    const userText = ta.value.trim();
    let combined = userText ? userText + '\n\n---\n' + md : md;
    if (combined.length > MAX_ATTACH_CHARS) {
      const marker = '\n…[report trimmed to fit the 4,000-character limit]';
      combined = combined.slice(0, MAX_ATTACH_CHARS - marker.length) + marker;
      status.textContent = 'The report was trimmed to fit the 4,000-character limit.';
    }
    ta.value = combined;
    ta.dispatchEvent(new Event('input'));
    btn.textContent = 'Report attached'; // stays disabled: one attach per open
  } catch (err) {
    if (gen !== attachGen) return;
    btn.disabled = false;
    btn.textContent = 'Attach Support Report';
    status.textContent = 'Could not build the report — try again.';
  }
});

// ============================================================
// Bug-report screenshot attach (#141).
//
// The whole block stays hidden unless the proxy advertises the screenshots
// capability — a control that cannot deliver is a dead button. Validation
// runs client-side first (type by magic bytes, 5 MB cap) for immediate
// honest feedback; the proxy re-validates server-side regardless.
// ============================================================
const SHOT_MAX_BYTES = 5 * 1024 * 1024;
const SHOT_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
let bugScreenshot = null;        // { bytes: Uint8Array, mediaType, name }
let bugScreenshotUrl = null;     // preview object URL (revoked on clear)
let screenshotsCapable = false;
let shotReadGen = 0;             // invalidates in-flight async file reads
let shotReadBusy = false;        // read in flight: submit must wait

function sniffImageBytes(u8) {
  if (u8.length < 12) return null;
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
      u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a) return 'image/png';
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  const head = String.fromCharCode.apply(null, Array.from(u8.slice(0, 12)));
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function shotStatus(msg, isError) {
  const el = document.getElementById('fbShotStatus');
  el.textContent = msg || '';
  el.className = 'fb-status fb-shot-status' + (isError ? ' err' : '');
}

function refreshBugSubmit() {
  const btn = document.getElementById('fbBugSubmit');
  const len = document.getElementById('fbBugText').value.trim().length;
  btn.disabled = shotReadBusy || len < 50;
}

function clearScreenshot() {
  shotReadGen++; // a queued async read completion must not resurrect state
  shotReadBusy = false;
  bugScreenshot = null;
  if (bugScreenshotUrl) { URL.revokeObjectURL(bugScreenshotUrl); bugScreenshotUrl = null; }
  document.getElementById('fbShotPreview').hidden = true;
  document.getElementById('fbShotRow').hidden = false;
  document.getElementById('fbShotInput').value = '';
  shotStatus('');
  refreshBugSubmit();
}

async function refreshScreenshotCapability() {
  const block = document.getElementById('fbShotBlock');
  block.hidden = true;
  screenshotsCapable = false;
  try {
    const cap = await window.electronAPI.feedbackCapabilities();
    screenshotsCapable = !!(cap && cap.screenshots);
  } catch (_) { /* capability stays false */ }
  block.hidden = !screenshotsCapable;
}

async function setScreenshot(fileOrBlob, name) {
  // Selecting ANY replacement — even one that will be rejected — must
  // invalidate a still-in-flight earlier read, or that older file could
  // attach after the rejection message. The generation bumps first; every
  // rejection then also releases the busy gate it now owns.
  const gen = ++shotReadGen;
  const rejectRead = (msg) => {
    if (gen === shotReadGen) {
      shotReadBusy = false;
      refreshBugSubmit();
    }
    shotStatus(msg, true);
  };
  // Reset the picker immediately: a rejected file must not leave its value
  // behind, or re-selecting the same file later is a silent no-op (change
  // never fires for an identical value).
  document.getElementById('fbShotInput').value = '';
  if (fileOrBlob.size > SHOT_MAX_BYTES) {
    return rejectRead('Screenshot must be 5 MB or smaller.');
  }
  // Declared MIME gate (spec: MIME + magic bytes). An empty type (some
  // drag/paste sources) falls through to the sniff, which stays decisive.
  const declared = (fileOrBlob.type || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (declared && !SHOT_ALLOWED_MIME.includes(declared)) {
    return rejectRead('Only image files can be attached (PNG, JPEG, WebP, or GIF).');
  }
  // Submission must not observe half-updated state: block Submit while the
  // read is in flight, and discard a completion the user has superseded.
  shotReadBusy = true;
  refreshBugSubmit();
  try {
    const bytes = new Uint8Array(await fileOrBlob.arrayBuffer());
    if (gen !== shotReadGen) return; // replaced or cleared mid-read
    const mediaType = sniffImageBytes(bytes);
    if (!mediaType || (declared && declared !== mediaType)) {
      shotStatus('Only image files can be attached (PNG, JPEG, WebP, or GIF).', true);
      return;
    }
    if (bugScreenshotUrl) URL.revokeObjectURL(bugScreenshotUrl);
    bugScreenshot = { bytes, mediaType, name: name || 'screenshot' };
    bugScreenshotUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    document.getElementById('fbShotImg').src = bugScreenshotUrl;
    document.getElementById('fbShotName').textContent = bugScreenshot.name;
    document.getElementById('fbShotPreview').hidden = false;
    document.getElementById('fbShotRow').hidden = true;
    shotStatus('');
    // Hiding the attach row drops keyboard focus to <body>; hand it to the
    // preview's Replace control when the user was on the attach path. A
    // paste/drop while typing keeps focus where it was.
    const active = document.activeElement;
    if (active === document.body || active === document.getElementById('fbShotAttach')) {
      document.getElementById('fbShotReplace').focus();
    }
  } finally {
    if (gen === shotReadGen) {
      shotReadBusy = false;
      refreshBugSubmit();
    }
  }
}

document.getElementById('fbShotAttach').addEventListener('click', () => {
  document.getElementById('fbShotInput').click();
});
document.getElementById('fbShotReplace').addEventListener('click', () => {
  document.getElementById('fbShotInput').click();
});
document.getElementById('fbShotRemove').addEventListener('click', () => {
  clearScreenshot();
  // Removing hides the focused button; keep keyboard users in the flow.
  document.getElementById('fbShotAttach').focus();
});
document.getElementById('fbShotInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) setScreenshot(f, f.name);
});

// A file dropped ANYWHERE must never navigate the window away from the app —
// without this guard Electron replaces the UI with the dropped image. Text
// drags keep their default behavior (dropping text into a textarea works).
const dragHasFile = (e) =>
  e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
['dragover', 'drop'].forEach(ev => document.addEventListener(ev, (e) => {
  if (dragHasFile(e)) e.preventDefault();
}));

// Drag-and-drop onto the bug section (attach only; navigation is already
// guarded above, and text drops keep their default insertion).
const fbBugSection = document.getElementById('fbBug');
['dragover', 'dragenter'].forEach(ev => fbBugSection.addEventListener(ev, (e) => {
  if (!screenshotsCapable || !dragHasFile(e)) return;
  document.getElementById('fbShotRow').classList.add('fb-drag');
}));
['dragleave', 'drop'].forEach(ev => fbBugSection.addEventListener(ev, () => {
  document.getElementById('fbShotRow').classList.remove('fb-drag');
}));
fbBugSection.addEventListener('drop', (e) => {
  if (!screenshotsCapable) return;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setScreenshot(f, f.name);
});

// Paste-from-clipboard while the bug form is open (users screenshot errors
// straight to the clipboard). Inert while the support-report preview modal
// is stacked on top — a paste meant for that surface must not silently
// attach an image to the form underneath.
document.addEventListener('paste', (e) => {
  if (!screenshotsCapable) return;
  if (!document.getElementById('fbOverlay').classList.contains('show')) return;
  if (!fbBugSection.classList.contains('active')) return;
  if (document.getElementById('supportOverlay').classList.contains('show')) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) { e.preventDefault(); setScreenshot(f, 'pasted screenshot'); }
      return;
    }
  }
});

document.getElementById('fbBugSubmit').addEventListener('click', async () => {
  const text = document.getElementById('fbBugText').value.trim();
  const sysInfo = document.getElementById('fbSysInfo').textContent;
  const body = `${text}\n\n---\n**System Info**\n${sysInfo.split('\n').map(l => '- ' + l).join('\n')}`;
  await submitFeedback('Bug Report', body, 'fbBugStatus', bugScreenshot);
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

const SUBMIT_BTN_FOR_STATUS = {
  fbBugStatus: 'fbBugSubmit', fbRatingStatus: 'fbRatingSubmit', fbContactStatus: 'fbContactSubmit',
};

async function submitFeedback(type, text, statusId, screenshot) {
  const statusEl = document.getElementById(statusId);
  // One submission at a time: a second click during the request would send a
  // duplicate report (the legacy path has no server-side idempotency).
  const submitBtn = document.getElementById(SUBMIT_BTN_FOR_STATUS[statusId]);
  if (submitBtn.disabled) return;
  submitBtn.disabled = true;
  statusEl.textContent = screenshot ? 'Submitting report + screenshot...' : 'Submitting...';
  statusEl.className = 'fb-status';
  try {
    // The screenshot rides only when present; success below means the proxy
    // accepted the WHOLE submission (report + screenshot in one request), so
    // "Submitted successfully" can never overstate what was sent.
    const shotPayload = screenshot
      ? { bytes: screenshot.bytes, mediaType: screenshot.mediaType }
      : undefined;
    const result = await window.electronAPI.submitFeedback(type, text, shotPayload);
    if (result.success) {
      statusEl.textContent = 'Submitted successfully!';
      statusEl.className = 'fb-status ok';
      setTimeout(closeFeedback, 1500);
      return; // stays disabled until the modal closes — nothing left to send
    }
    statusEl.textContent = result.error || FEEDBACK_FALLBACK;
    statusEl.className = 'fb-status err';
  } catch (err) {
    statusEl.textContent = FEEDBACK_NETWORK;
    statusEl.className = 'fb-status err';
  }
  submitBtn.disabled = false; // failed: let the user retry
  if (statusId === 'fbBugStatus') refreshBugSubmit(); // re-apply length/read gates
}

// ============================================================
// Support Report modal
// ============================================================
const supportOverlay   = document.getElementById('supportOverlay');
const supportTextArea  = document.getElementById('supportText');
const supportCopyBtn   = document.getElementById('supportCopy');
const supportCloseBtn  = document.getElementById('supportClose');
const supportCopyStat  = document.getElementById('supportCopyStatus');

let releaseSupportTrap = null;

async function openSupportReport() {
  supportOverlay.classList.add('show');
  supportTextArea.value = 'Generating sanitized report…';
  supportCopyStat.textContent = '';
  releaseSupportTrap = installFocusTrap(supportOverlay);
  try {
    const result = await window.electronAPI.supportReport({
      receipt: lastReceipt,
      logTail: logBuffer.join('\n'),
      stage:   lastStageLabel
    });
    supportTextArea.value = (result && result.markdown) ? result.markdown : reportBuildFailure(null);
  } catch (err) {
    supportTextArea.value = reportBuildFailure(err);
  }
}

function closeSupportReport() {
  supportOverlay.classList.remove('show');
  if (releaseSupportTrap) { releaseSupportTrap(); releaseSupportTrap = null; }
}

supportCloseBtn.addEventListener('click', closeSupportReport);
supportCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(supportTextArea.value);
    supportCopyStat.textContent = 'Copied — paste into your support thread.';
    supportCopyStat.style.color = 'var(--success)';
  } catch (err) {
    // Fallback: select all so user can manually copy.
    supportTextArea.focus();
    supportTextArea.select();
    supportCopyStat.textContent = 'Auto-copy blocked — text is selected, press Ctrl+C.';
    supportCopyStat.style.color = 'var(--warning)';
  }
});

// Esc closes any open modal. With no modal open, Esc is the keyboard way
// back from the Details view. (This handler used to call a countdown
// canceller that no longer existed, so every Escape threw before reaching
// the overlay checks.)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Close only the topmost overlay — the report preview can now sit on top
    // of the feedback modal, and closing both would wipe the user's draft.
    if      (supportOverlay.classList.contains('show'))                    closeSupportReport();
    else if (document.getElementById('fbOverlay').classList.contains('show')) closeFeedback();
    else if (exploreOverlay.classList.contains('show') || !aboutOverlay.hidden || !fixConfirmOverlay.hidden) { /* those dialogs handle their own Escape */ }
    else if (detailsOpen()) { e.preventDefault(); closeDetails(); }
  }
});
