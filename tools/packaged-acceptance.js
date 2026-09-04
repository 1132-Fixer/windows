'use strict';

/**
 * Packaged-build acceptance driver for 1132 Fixer (Windows).
 *
 * Launches the REAL packaged executable (dist/win-unpacked/1132 Fixer.exe by
 * default) through Playwright's Electron driver, walks the user journey, and
 * writes screenshots plus a machine-readable report. It is the evidence that
 * the shipped binary starts, leaves "Checking" within the deadline, renders
 * every state without scrollbars, and that Fix now drives the real repair
 * orchestrator — not a mock, not the dev checkout.
 *
 * What it proves, per case, is written to <out>/report.json and
 * <out>/report.md with one of: passed | failed | not-run (with the reason).
 * A case that could not run on this host is reported as not-run, never as
 * passed.
 *
 * Run:  node tools/packaged-acceptance.js [--exe <path>] [--out <dir>]
 *                                         [--scales 1,1.25,1.5]
 *                                         [--fix-timeout-ms 360000]
 *                                         [--skip-fix]
 *
 * Exit code 1 when any case fails. Cases that do not run do not fail the
 * driver by themselves; the report says so and the release gate reads it.
 *
 * Host expectations: Windows, an elevated (administrator) session, no Smart
 * App Control enforcement (it blocks the unsigned host binary before
 * Electron starts — see docs/security/code-signing.md). GitHub-hosted
 * windows runners satisfy all three.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (flag) => args.includes(flag);

const SHIPPED_EXE = path.resolve(argOf('--exe', path.join(ROOT, 'dist', 'win-unpacked', '1132 Fixer.exe')));
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'acceptance-evidence')));
// --test-copy: drive a throwaway copy of the unpacked app whose exe manifest
// is stamped asInvoker. Needed on hosts with UAC disabled (GitHub-hosted
// runners): there, CreateProcess of a requireAdministrator image from the
// Chromium sandbox's restricted token fails (SBOX_ERROR_CREATE_PROCESS = 18)
// and no renderer ever starts. The shipped artifact is not modified. The
// report records which binary was driven.
const TEST_COPY = has('--test-copy');
const SCALES = String(argOf('--scales', '1,1.25,1.5')).split(',').map(Number).filter((n) => n > 0);
const FIX_TIMEOUT_MS = Number(argOf('--fix-timeout-ms', 360000));
const SKIP_FIX = has('--skip-fix');

// Startup contract (renderer STARTUP_DEADLINE_MS is 8 s; main's whoami probe
// is bounded at 2.5 s). The packaged app must leave Checking well inside this.
const WINDOW_DEADLINE_MS = 30000;
const CHECKING_DEADLINE_MS = 15000;
const DISCLOSURE = 'Independent project. Not affiliated with Zoom.';
const TERMINAL_STATES = ['success', 'error', 'notice', 'cancelled', 'blocked', 'ready'];

let EXE = SHIPPED_EXE;
const report = { exe: EXE, shippedExe: SHIPPED_EXE, testCopy: TEST_COPY, startedAt: new Date().toISOString(), host: {}, cases: [] };
function record(id, status, detail, extra) {
  const row = { id, status, detail: detail || '', ...(extra || {}) };
  report.cases.push(row);
  const mark = status === 'passed' ? ' ok ' : status === 'failed' ? 'FAIL' : 'skip';
  console.log(`  ${mark}  ${id}${detail ? ` — ${detail}` : ''}`);
  return row;
}
const passed = (id, detail, extra) => record(id, 'passed', detail, extra);
const failed = (id, detail, extra) => record(id, 'failed', detail, extra);
const notRun = (id, detail, extra) => record(id, 'not-run', detail, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let playwright;
try {
  playwright = require('playwright-core');
} catch (err) {
  console.error('packaged-acceptance: playwright-core is not installed (npm ci)');
  process.exit(2);
}
const { _electron: electron } = playwright;

fs.mkdirSync(OUT, { recursive: true });

async function stateOf(page) {
  return page.evaluate(() => document.body.dataset.compactState || '');
}

async function waitForState(page, pred, timeoutMs, label) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    last = await stateOf(page).catch(() => '');
    if (pred(last)) return { ok: true, state: last, ms: Date.now() - t0 };
    await sleep(200);
  }
  return { ok: false, state: last, ms: Date.now() - t0, label };
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return path.relative(ROOT, file);
}

async function layoutFacts(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const b = document.body;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overflow = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.hidden) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 || r.bottom > vh + 1) {
        overflow.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} (${Math.round(r.right)}x${Math.round(r.bottom)})`);
        if (overflow.length >= 5) break;
      }
    }
    const footer = document.querySelector('.compact-footer');
    const disclosure = document.getElementById('projectDisclosure');
    const explore = document.getElementById('btnExplore');
    const version = document.getElementById('appVersion');
    return {
      viewport: { w: vw, h: vh, dpr: window.devicePixelRatio },
      docScroll: { w: de.scrollWidth, h: de.scrollHeight, cw: de.clientWidth, ch: de.clientHeight },
      bodyScroll: { w: b.scrollWidth, h: b.scrollHeight },
      overflow,
      footerText: footer ? footer.innerText.replace(/\s+/g, ' ').trim() : null,
      disclosureText: disclosure ? disclosure.textContent.trim() : null,
      disclosureInFooter: !!(footer && disclosure && footer.contains(disclosure)),
      exploreVisible: !!(explore && !explore.hidden && getComputedStyle(explore).display !== 'none'),
      versionText: version ? version.textContent.trim() : null,
      title: (document.querySelector('.wizard-pane.active h2, .wizard-pane.active h1, [data-compact-title]') || {}).textContent || null
    };
  });
}

async function keyboardFacts(page) {
  return page.evaluate(() => {
    const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      if (el.hidden || el.disabled) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const rows = [];
    for (const el of els) {
      el.focus();
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
        (cs.boxShadow && cs.boxShadow !== 'none');
      const name = (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const r = el.getBoundingClientRect();
      rows.push({ tag: el.tagName.toLowerCase(), id: el.id || null, name, focusVisible: !!ring, w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return rows;
  });
}

async function launch(scale) {
  const launchArgs = [];
  if (scale && scale !== 1) launchArgs.push(`--force-device-scale-factor=${scale}`);
  const t0 = Date.now();
  const app = await electron.launch({ executablePath: EXE, args: launchArgs, timeout: WINDOW_DEADLINE_MS });
  const page = await app.firstWindow({ timeout: WINDOW_DEADLINE_MS });
  await page.waitForLoadState('domcontentloaded', { timeout: WINDOW_DEADLINE_MS }).catch(() => {});
  return { app, page, ms: Date.now() - t0 };
}

async function runLanding(scale, tag) {
  let app = null;
  try {
    const l = await launch(scale);
    app = l.app;
    const page = l.page;
    passed(`${tag}.window-visible`, `first window in ${l.ms} ms`);
    const first = await stateOf(page);
    const firstShot = await shot(page, `${tag}-01-first-paint-${first || 'unknown'}`);
    const left = await waitForState(page, (s) => s && s !== 'checking', CHECKING_DEADLINE_MS, 'leave checking');
    if (left.ok) passed(`${tag}.leaves-checking`, `state=${left.state} after ${left.ms} ms`, { screenshot: firstShot });
    else failed(`${tag}.leaves-checking`, `still "${left.state || 'checking'}" after ${left.ms} ms — startup freeze`, { screenshot: firstShot });
    await sleep(600); // let the environment scan settle its cards
    const state = await stateOf(page);
    const landingShot = await shot(page, `${tag}-02-landing-${state}`);
    const facts = await layoutFacts(page);
    const noScroll = facts.docScroll.h <= facts.docScroll.ch + 1 && facts.docScroll.w <= facts.docScroll.cw + 1 && facts.overflow.length === 0;
    (noScroll ? passed : failed)(`${tag}.no-scrollbars`, noScroll
      ? `viewport ${facts.viewport.w}x${facts.viewport.h} @${facts.viewport.dpr}, content fits`
      : `overflow: ${facts.overflow.join('; ') || `doc ${facts.docScroll.w}x${facts.docScroll.h} > ${facts.docScroll.cw}x${facts.docScroll.ch}`}`,
      { screenshot: landingShot, facts });
    (facts.disclosureText === DISCLOSURE && facts.disclosureInFooter ? passed : failed)(`${tag}.footer-disclosure`, `footer: ${facts.footerText}`);
    (!facts.exploreVisible ? passed : failed)(`${tag}.explore-hidden`, facts.exploreVisible ? 'Explore visible in landing chrome' : 'Explore absent from landing chrome');
    (facts.versionText && /\d+\.\d+\.\d+/.test(facts.versionText) ? passed : failed)(`${tag}.version-shown`, `version: ${facts.versionText}`);
    const kb = await keyboardFacts(page);
    const noRing = kb.filter((k) => !k.focusVisible);
    const small = kb.filter((k) => k.w < 24 || k.h < 24);
    (noRing.length === 0 ? passed : failed)(`${tag}.focus-visible`, noRing.length ? `no visible focus on: ${noRing.map((k) => k.id || k.name).join(', ')}` : `${kb.length} focusable controls, all with a visible focus ring`, { controls: kb });
    (small.length === 0 ? passed : failed)(`${tag}.target-size`, small.length ? `targets under 24px: ${small.map((k) => `${k.id || k.name} ${k.w}x${k.h}`).join(', ')}` : 'all targets ≥ 24px');
    return { app, page, state };
  } catch (err) {
    failed(`${tag}.launch`, `could not drive the packaged app: ${err && err.message}`);
    if (app) await app.close().catch(() => {});
    return null;
  }
}

async function runSecondInstance(page) {
  const t0 = Date.now();
  const child = spawn(EXE, [], { windowsHide: true, stdio: 'ignore' });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 15000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
  });
  if (exit.timedOut) {
    try { child.kill(); } catch (_) {}
    failed('single-instance.second-launch-exits', 'second instance still running after 15 s');
  } else {
    passed('single-instance.second-launch-exits', `second instance exited in ${Date.now() - t0} ms (code ${exit.code})`);
  }
  const stillOpen = await page.evaluate(() => document.visibilityState).then(() => true).catch(() => false);
  (stillOpen ? passed : failed)('single-instance.first-window-survives', stillOpen ? 'first window still open' : 'first window gone');
}

async function runFixJourney(page) {
  const state = await stateOf(page);
  if (state !== 'ready') {
    notRun('fix.journey', `landing state is "${state}", not ready (Zoom Workplace not detected on this host?) — Fix now cannot be exercised here`);
    await page.click('#detailsBtn').catch(() => {});
    await sleep(300);
    await shot(page, '03-details-' + state);
    return;
  }
  // Enter on the landing surface activates the primary action (Fix now).
  await page.keyboard.press('Enter');
  const overlayShown = await page.waitForSelector('#fixConfirmOverlay:not([hidden])', { timeout: 5000 }).then(() => true).catch(() => false);
  (overlayShown ? passed : failed)('fix.confirm-opens-on-enter', overlayShown ? 'confirmation dialog opened from the keyboard' : 'confirmation did not open');
  if (!overlayShown) return;
  const confirmShot = await shot(page, '03-confirm');
  const confirmFacts = await page.evaluate(() => {
    const d = document.querySelector('#fixConfirmOverlay .fix-confirm-dialog');
    const r = d ? d.getBoundingClientRect() : null;
    return {
      role: document.getElementById('fixConfirmOverlay').getAttribute('role'),
      labelledBy: document.getElementById('fixConfirmOverlay').getAttribute('aria-labelledby'),
      body: (document.getElementById('fixConfirmBody') || {}).textContent,
      inside: r ? r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight : false,
      focused: document.activeElement && document.activeElement.id
    };
  });
  (confirmFacts.role === 'dialog' && confirmFacts.labelledBy ? passed : failed)('fix.confirm-dialog-semantics', `role=${confirmFacts.role} labelledby=${confirmFacts.labelledBy}`, { screenshot: confirmShot });
  (confirmFacts.inside ? passed : failed)('fix.confirm-fits-window', confirmFacts.inside ? 'dialog inside the window' : 'dialog extends outside the window');
  (/personal files will not be changed/.test(confirmFacts.body || '') ? passed : failed)('fix.confirm-copy', (confirmFacts.body || '').slice(0, 120));
  // Escape = Go back; focus must return to Fix now.
  await page.keyboard.press('Escape');
  await sleep(200);
  const afterEsc = await page.evaluate(() => ({ hidden: document.getElementById('fixConfirmOverlay').hidden, focused: document.activeElement && document.activeElement.id }));
  (afterEsc.hidden ? passed : failed)('fix.confirm-escape-goes-back', `overlay hidden=${afterEsc.hidden}`);
  (afterEsc.focused === 'fixBtn' ? passed : failed)('fix.confirm-focus-returns', `focus on #${afterEsc.focused}`);
  if (SKIP_FIX) { notRun('fix.run', '--skip-fix'); return; }

  // Real run: click Fix now, Continue, and follow the orchestrator to a
  // terminal state. Rapid double-click must not start two repairs.
  await page.click('#fixBtn');
  await page.waitForSelector('#fixConfirmOverlay:not([hidden])', { timeout: 5000 });
  await page.click('#fixConfirmContinue');
  await page.click('#fixConfirmContinue', { force: true }).catch(() => {});
  const fixing = await waitForState(page, (s) => s === 'fixing' || s === 'cancelling' || s === 'success' || s === 'error' || s === 'notice', 15000, 'fixing');
  (fixing.ok ? passed : failed)('fix.starts', `state=${fixing.state} after ${fixing.ms} ms`);
  if (!fixing.ok) return;
  const fixingShot = await shot(page, '04-fixing');
  const progress = await page.evaluate(() => {
    const p = document.querySelector('[role="progressbar"]');
    const line = document.querySelector('.compact-step-line, #stepLine');
    const btn = document.getElementById('fixBtn');
    return { aria: p ? p.getAttribute('aria-valuetext') : null, step: line ? line.textContent : null, fixDisabledOrHidden: !btn || btn.hidden || btn.disabled };
  });
  (progress.fixDisabledOrHidden ? passed : failed)('fix.no-duplicate-run', 'Fix now unavailable while fixing', { screenshot: fixingShot, progress });
  (progress.aria ? passed : failed)('fix.progress-announced', `progress: ${progress.aria || 'none'}`);
  const done = await waitForState(page, (s) => ['success', 'error', 'notice', 'cancelled'].includes(s), FIX_TIMEOUT_MS, 'terminal');
  const endShot = await shot(page, `05-end-${done.state || 'timeout'}`);
  if (!done.ok) { failed('fix.reaches-terminal-state', `still "${done.state}" after ${done.ms} ms — no terminal state`, { screenshot: endShot }); return; }
  passed('fix.reaches-terminal-state', `state=${done.state} after ${done.ms} ms`, { screenshot: endShot });
  const endFacts = await page.evaluate(() => {
    const launch = document.getElementById('launchBtn');
    const title = document.querySelector('.wizard-pane.active h2, .wizard-pane.active h1');
    const spinning = [...document.querySelectorAll('*')].some((el) => {
      const cs = getComputedStyle(el);
      return cs.animationName && cs.animationName !== 'none' && cs.animationPlayState === 'running' && el.getBoundingClientRect().width > 0 && !el.hidden;
    });
    return { openZoomVisible: !!(launch && !launch.hidden), title: title ? title.textContent.trim() : null, spinning };
  });
  if (done.state === 'success') {
    (endFacts.openZoomVisible ? passed : failed)('fix.open-zoom-after-success', `Open Zoom visible=${endFacts.openZoomVisible}; title=${endFacts.title}`);
  } else {
    (!endFacts.openZoomVisible ? passed : failed)('fix.no-open-zoom-without-success', `state=${done.state}; Open Zoom visible=${endFacts.openZoomVisible}; title=${endFacts.title}`);
  }
  (!endFacts.spinning ? passed : failed)('fix.no-animation-after-end', endFacts.spinning ? 'an animation is still running' : 'no running animation');
  const details = await page.click('#detailsBtn').then(() => true).catch(() => false);
  await sleep(300);
  const detailsShot = await shot(page, '06-details');
  (details ? passed : notRun)('fix.view-details', details ? 'View details opened' : 'View details not available', { screenshot: detailsShot });
  const rawPs = await page.evaluate(() => /\$_\.|Write-Output|Start-Process|At line:\d+ char:\d+/.test(document.querySelector('.wizard-pane.active') ? document.querySelector('.wizard-pane.active').innerText : ''));
  (!rawPs ? passed : failed)('fix.no-raw-powershell-on-primary-surface', rawPs ? 'PowerShell text visible on the primary surface' : 'primary surface is plain English');
}

function readEnableLua() {
  try {
    const r = require('child_process').spawnSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'EnableLUA'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const m = /EnableLUA\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout || '');
    return m ? parseInt(m[1], 16) : null;
  } catch (_) { return null; }
}

async function prepareTestCopy() {
  const srcDir = path.dirname(SHIPPED_EXE);
  const dstDir = path.join(path.dirname(srcDir), 'acceptance-unpacked');
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
  const exe = path.join(dstDir, path.basename(SHIPPED_EXE));
  const { stampExecutionLevel } = require('../scripts/stamp-exe-manifest');
  const how = await stampExecutionLevel(exe, 'asInvoker');
  return { exe, how };
}

// Raw launch without the debugger: the app's own stderr for 12 s, so a
// renderer/GPU child launch failure is visible in the report even when the
// driver cannot attach.
async function rawLaunchProbe(exe) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(exe, ['--enable-logging=stderr'], { windowsHide: true });
    const done = (why) => {
      try { require('child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch (_) {}
      resolve({ why, out: out.slice(-4000) });
    };
    const timer = setTimeout(() => done('timeout'), 12000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ why: `error: ${e.message}`, out }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ why: `exited ${code}`, out: out.slice(-4000) }); });
  });
}

(async () => {
  report.host = { platform: process.platform, release: require('os').release(), enableLUA: readEnableLua(), exeExists: fs.existsSync(SHIPPED_EXE) };
  console.log(`packaged-acceptance: ${SHIPPED_EXE} (EnableLUA=${report.host.enableLUA})`);
  if (!fs.existsSync(SHIPPED_EXE)) { failed('exe-present', `missing ${SHIPPED_EXE}`); finish(); return; }
  passed('exe-present', path.basename(SHIPPED_EXE));
  if (TEST_COPY) {
    try {
      const c = await prepareTestCopy();
      EXE = c.exe;
      report.exe = EXE;
      passed('test-copy', `asInvoker copy stamped via ${c.how}: ${path.relative(ROOT, EXE)} (shipped artifact untouched; host EnableLUA=${report.host.enableLUA})`);
    } catch (err) {
      failed('test-copy', `could not prepare the asInvoker copy: ${err && err.message}`);
      finish();
      return;
    }
  }
  const raw = await rawLaunchProbe(EXE);
  const rawFatal = /render-process-gone|GPU process launch failed|FATAL/.test(raw.out);
  (!rawFatal ? passed : failed)('raw-launch', `${raw.why}; ${rawFatal ? 'renderer/GPU launch failure in stderr' : 'no fatal child-launch error in 12 s'}`, { stderrTail: raw.out.split(/\r?\n/).filter(Boolean).slice(-12) });

  const main = await runLanding(1, 'scale100');
  if (main) {
    await runSecondInstance(main.page);
    await runFixJourney(main.page);
    await main.app.close().catch(() => {});
  }
  for (const s of SCALES.filter((x) => x !== 1)) {
    const tag = `scale${Math.round(s * 100)}`;
    const r = await runLanding(s, tag);
    if (r) await r.app.close().catch(() => {});
  }
  finish();
})().catch((err) => {
  failed('driver', `crashed: ${err && err.stack || err}`);
  finish();
});

function finish() {
  report.finishedAt = new Date().toISOString();
  const counts = { passed: 0, failed: 0, 'not-run': 0 };
  for (const c of report.cases) counts[c.status]++;
  report.counts = counts;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const lines = ['# Packaged acceptance', '', `Executable driven: \`${report.exe}\``, `Shipped executable: \`${report.shippedExe}\` (${report.testCopy ? 'driven through an asInvoker-stamped copy because the host has UAC disabled' : 'driven directly'})`, `Host: ${report.host.platform} ${report.host.release}, EnableLUA=${report.host.enableLUA}`, `Run: ${report.startedAt} → ${report.finishedAt}`, '',
    `Passed ${counts.passed} · Failed ${counts.failed} · Not run ${counts['not-run']}`, '',
    '| Case | Result | Detail | Evidence |', '|---|---|---|---|'];
  const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  for (const c of report.cases) lines.push(`| ${c.id} | ${c.status} | ${cell(c.detail)} | ${c.screenshot ? c.screenshot : ''} |`);
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
  console.log(`packaged-acceptance: passed=${counts.passed} failed=${counts.failed} not-run=${counts['not-run']} → ${OUT}`);
  process.exit(counts.failed ? 1 : 0);
}
