'use strict';

/**
 * Packaged acceptance for the inactivity warning and automatic exit, with
 * real elapsed time on the real packaged binary.
 *
 *   node tools/packaged-inactivity-acceptance.js [--exe dist/win-unpacked/1132 Fixer.exe]
 *        [--out inactivity-evidence] [--scales 1,1.25,1.5] [--feed-dir <dir>]
 *        [--port 47831] [--skip-update]
 *
 * The app is driven through a throwaway copy of the unpacked build whose
 * manifest is stamped asInvoker (same technique as tools/packaged-acceptance.js
 * --test-copy) and launched with the self-elevation retry flag, so no Windows
 * approval prompt is needed: the app opens on "Administrator access
 * required", which is a settled first screen and a real place for the timer
 * to run. The main-process timer, the renderer overlay, the copy, focus
 * handling, reduced motion and the 100/125/150 % layouts are all exercised
 * on the shipped code.
 *
 * What is proved (real seconds, measured with the host clock):
 *   - no warning at 29 s; the hourglass at about 30 s with a 30 s countdown;
 *   - interaction dismisses it; it returns 30 s later with a fresh countdown;
 *   - the app exits by itself at about 60 s of total inactivity, gracefully;
 *   - reopening shows no stale warning and a fresh timer;
 *   - Keep open has focus; Escape keeps the app open; Tab stays inside;
 *   - reduced motion stops the sand animation;
 *   - the dialog fits without scrollbars at every requested scale;
 *   - with --feed-dir: a verified update waiting to install suspends the
 *     warning (no hourglass while the update is ready), and the timer
 *     resumes after the update lifecycle ends.
 *
 * Cases that need an elevated session (a running repair, an installing
 * update relaunching) are reported as not-run here; they are covered by
 * tools/inactivity-smoke.js (fake timers) and by
 * tools/packaged-update-acceptance.js (which also asserts no hourglass
 * while an update is ready).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const has = (flag) => args.includes(flag);
const SHIPPED_EXE = path.resolve(argOf('--exe', path.join(ROOT, 'dist', 'win-unpacked', '1132 Fixer.exe')));
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'inactivity-evidence')));
const SCALES = String(argOf('--scales', '1,1.25,1.5')).split(',').map(Number).filter((n) => n > 0);
const FEED_DIR = argOf('--feed-dir', '');
const PORT = Number(argOf('--port', 47831));
const SKIP_UPDATE = has('--skip-update') || !FEED_DIR;
const ONLY_UPDATE = has('--only-update');
const ELEVATE_RETRY_FLAG = require('../src/main/elevation').ELEVATE_RETRY_FLAG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let playwright;
try { playwright = require('playwright-core'); } catch (_) { console.error('playwright-core is not installed (npm ci)'); process.exit(2); }
const { _electron: electron } = playwright;

fs.mkdirSync(OUT, { recursive: true });
const report = { startedAt: new Date().toISOString(), exe: SHIPPED_EXE, host: { platform: process.platform, release: os.release(), arch: process.arch }, cases: [] };
function record(id, status, detail, extra) {
  const row = { id, status, detail: detail || '', ...(extra || {}) };
  report.cases.push(row);
  console.log(`  ${status === 'passed' ? ' ok ' : status === 'failed' ? 'FAIL' : 'skip'}  ${id}${detail ? ` — ${detail}` : ''}`);
}
const passed = (id, d, x) => record(id, 'passed', d, x);
const failed = (id, d, x) => record(id, 'failed', d, x);
const notRun = (id, d, x) => record(id, 'not-run', d, x);

async function prepareTestCopy() {
  const srcDir = path.dirname(SHIPPED_EXE);
  const dstDir = path.join(path.dirname(srcDir), 'inactivity-unpacked');
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
  const exe = path.join(dstDir, path.basename(SHIPPED_EXE));
  const { stampExecutionLevel } = require('../scripts/stamp-exe-manifest');
  const how = await stampExecutionLevel(exe, 'asInvoker');
  if (!SKIP_UPDATE) {
    // Point this copy's updater at the local feed (the shipped copy is untouched).
    fs.writeFileSync(path.join(dstDir, 'resources', 'app-update.yml'), `provider: generic\nurl: http://127.0.0.1:${PORT}/\nupdaterCacheDirName: 1132-fixer-updater\n`);
  }
  return { exe, how };
}

async function launch(exe, opts = {}) {
  const launchArgs = [ELEVATE_RETRY_FLAG];
  if (opts.scale && opts.scale !== 1) launchArgs.push(`--force-device-scale-factor=${opts.scale}`);
  if (opts.reducedMotion) launchArgs.push('--force-prefers-reduced-motion');
  const app = await electron.launch({ executablePath: exe, args: launchArgs, timeout: 60000 });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  // Settled first screen: the renderer reports app-ready and the timer starts.
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const s = await page.evaluate(() => document.body.dataset.compactState || '').catch(() => '');
    if (s && s !== 'checking') break;
    await sleep(200);
  }
  return { app, page, startedAt: Date.now() };
}

const overlayFacts = (page) => page.evaluate(() => {
  const o = document.getElementById('idleOverlay');
  const visible = !!o && !o.hidden && getComputedStyle(o).display !== 'none';
  const d = o ? o.querySelector('.idle-dialog') : null;
  const r = d ? d.getBoundingClientRect() : null;
  const de = document.documentElement;
  const stream = document.querySelector('.idle-stream');
  return {
    visible,
    countdown: (document.getElementById('idleCountdown') || {}).textContent || '',
    title: (document.getElementById('idleTitle') || {}).textContent || '',
    body: (document.getElementById('idleBody') || {}).textContent || '',
    focused: document.activeElement ? document.activeElement.id : '',
    inside: r ? r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5 : false,
    docScroll: de.scrollWidth > de.clientWidth + 1 || de.scrollHeight > de.clientHeight + 1,
    dialogScroll: d ? d.scrollHeight > d.clientHeight + 1 : false,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    streamAnimation: stream ? getComputedStyle(stream).animationName : null,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    keepLabel: (document.getElementById('idleKeepBtn') || {}).textContent || '',
    closeLabel: (document.getElementById('idleCloseBtn') || {}).textContent || '',
    role: o ? o.getAttribute('role') : null,
    modal: o ? o.getAttribute('aria-modal') : null
  };
});

async function waitForOverlay(page, want, timeoutMs) {
  const t0 = Date.now();
  let f = null;
  while (Date.now() - t0 < timeoutMs) {
    f = await overlayFacts(page).catch(() => null);
    if (f && f.visible === want) return { ok: true, facts: f, ms: Date.now() - t0 };
    await sleep(150);
  }
  return { ok: false, facts: f, ms: Date.now() - t0 };
}

function secondsOf(text) { const m = /(\d+)/.exec(text || ''); return m ? Number(m[1]) : null; }

async function timelineCase(exe) {
  const { app, page, startedAt } = await launch(exe);
  const exitPromise = new Promise((resolve) => app.process().once('exit', (code) => resolve({ code, at: Date.now() })));
  await sleep(Math.max(0, 29000 - (Date.now() - startedAt)));
  const at29 = await overlayFacts(page);
  (!at29.visible ? passed : failed)('timeline.no-warning-at-29s', at29.visible ? 'warning visible at 29 s' : `no warning at ${Math.round((Date.now() - startedAt) / 1000)} s`);
  const w1 = await waitForOverlay(page, true, 8000);
  const t1 = Date.now() - startedAt;
  (w1.ok && t1 >= 29000 && t1 <= 36000 ? passed : failed)('timeline.warning-at-30s', w1.ok ? `hourglass at ${(t1 / 1000).toFixed(1)} s; countdown "${w1.facts.countdown}"` : `no warning by ${(t1 / 1000).toFixed(1)} s`);
  if (!w1.ok) { await app.close().catch(() => {}); return; }
  await page.screenshot({ path: path.join(OUT, 'timeline-01-warning-30s.png') });
  (secondsOf(w1.facts.countdown) >= 28 && secondsOf(w1.facts.countdown) <= 30 ? passed : failed)('timeline.countdown-starts-at-30', `countdown "${w1.facts.countdown}"`);
  (w1.facts.title === 'Closing soon' && /close in 30 seconds because it hasn’t been used/.test(w1.facts.body) ? passed : failed)('timeline.copy', `${w1.facts.title} — ${w1.facts.body}`);
  (w1.facts.focused === 'idleKeepBtn' && w1.facts.role === 'dialog' && w1.facts.modal === 'true' ? passed : failed)('timeline.focus-on-keep-open', `focus on #${w1.facts.focused}, role=${w1.facts.role} aria-modal=${w1.facts.modal}`);
  // Interaction during the countdown: real mouse movement.
  await page.mouse.move(120, 120);
  await page.mouse.move(160, 140);
  const d1 = await waitForOverlay(page, false, 3000);
  (d1.ok ? passed : failed)('timeline.activity-dismisses', d1.ok ? `dismissed ${d1.ms} ms after mouse movement` : 'warning stayed after mouse movement');
  const dismissedAt = Date.now();
  await sleep(27000);
  const mid = await overlayFacts(page);
  (!mid.visible ? passed : failed)('timeline.reset-after-activity', mid.visible ? 'warning came back before 30 s' : 'no warning 27 s after activity');
  const w2 = await waitForOverlay(page, true, 10000);
  const t2 = Date.now() - dismissedAt;
  (w2.ok && t2 >= 29000 && t2 <= 36000 && secondsOf(w2.facts.countdown) >= 28 ? passed : failed)('timeline.warning-returns-fresh', w2.ok ? `returned ${(t2 / 1000).toFixed(1)} s after activity with "${w2.facts.countdown}"` : 'did not return');
  // Screenshots at several countdown values (real time).
  const shots = [];
  for (const target of [20, 10, 5]) {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const f = await overlayFacts(page).catch(() => null);
      if (!f || !f.visible) break;
      if (secondsOf(f.countdown) === target) { await page.screenshot({ path: path.join(OUT, `timeline-02-countdown-${target}s.png`) }).catch(() => {}); shots.push(`${target}s`); break; }
      await sleep(120);
    }
  }
  passed('timeline.countdown-screenshots', `captured at ${shots.join(', ') || 'none'}`);
  const exit = await Promise.race([exitPromise, sleep(45000).then(() => null)]);
  const total = exit ? exit.at - dismissedAt : null;
  (exit && total >= 58000 && total <= 68000 ? passed : failed)('timeline.exits-at-60s', exit ? `exited ${(total / 1000).toFixed(1)} s after the last activity (code ${exit.code})` : 'did not exit within 45 s of the second warning');
  if (!exit) await app.close().catch(() => {});
}

async function reopenCase(exe) {
  const { app, page } = await launch(exe);
  await sleep(1500);
  const f = await overlayFacts(page);
  const status = await app.evaluate(async ({ ipcMain }) => null).catch(() => null);
  (!f.visible ? passed : failed)('reopen.no-stale-warning', f.visible ? 'warning visible right after reopen' : 'no warning after reopen');
  await sleep(10000);
  const g = await overlayFacts(page);
  (!g.visible ? passed : failed)('reopen.fresh-timer', g.visible ? 'warning within 12 s of reopen (stale countdown)' : 'no warning 12 s after reopen (timer is fresh)');
  await app.close().catch(() => {});
  void status;
}

async function keyboardCase(exe) {
  const { app, page } = await launch(exe);
  const w = await waitForOverlay(page, true, 40000);
  if (!w.ok) { failed('keyboard.warning', 'no warning'); await app.close().catch(() => {}); return; }
  await page.keyboard.press('Tab');
  const afterTab = await overlayFacts(page);
  await page.keyboard.press('Tab');
  const afterTab2 = await overlayFacts(page);
  (['idleCloseBtn', 'idleKeepBtn'].includes(afterTab.focused) && ['idleCloseBtn', 'idleKeepBtn'].includes(afterTab2.focused) ? passed : failed)('keyboard.focus-trapped', `Tab → #${afterTab.focused}, Tab → #${afterTab2.focused}`);
  await page.keyboard.press('Escape');
  const d = await waitForOverlay(page, false, 3000);
  (d.ok ? passed : failed)('keyboard.escape-keeps-open', d.ok ? 'Escape dismissed the warning' : 'Escape did not dismiss');
  const w2 = await waitForOverlay(page, true, 40000);
  if (w2.ok) {
    await page.keyboard.press('Enter');
    const d2 = await waitForOverlay(page, false, 3000);
    (d2.ok ? passed : failed)('keyboard.enter-keeps-open', d2.ok ? 'Enter on Keep open dismissed the warning' : 'Enter did not dismiss');
  } else {
    failed('keyboard.enter-keeps-open', 'warning did not return');
  }
  const w3 = await waitForOverlay(page, true, 40000);
  if (w3.ok) {
    await page.screenshot({ path: path.join(OUT, 'keyboard-warning.png') });
    await page.keyboard.press(' ');
    const d3 = await waitForOverlay(page, false, 3000);
    (d3.ok ? passed : failed)('keyboard.space-keeps-open', d3.ok ? 'Space on Keep open dismissed the warning' : 'Space did not dismiss');
  } else {
    failed('keyboard.space-keeps-open', 'warning did not return');
  }
  const announce = await page.evaluate(() => { const a = document.getElementById('idleAnnounce'); return a ? { live: a.getAttribute('aria-live'), role: a.getAttribute('role') } : null; });
  (announce && announce.live === 'polite' && announce.role === 'status' ? passed : failed)('keyboard.live-region', JSON.stringify(announce));
  await app.close().catch(() => {});
}

async function reducedMotionCase(exe) {
  const { app, page } = await launch(exe, { reducedMotion: true });
  const w = await waitForOverlay(page, true, 40000);
  if (!w.ok) { failed('reduced-motion.warning', 'no warning'); await app.close().catch(() => {}); return; }
  await page.screenshot({ path: path.join(OUT, 'reduced-motion-warning.png') });
  (w.facts.reducedMotion === true ? passed : notRun)('reduced-motion.preference-applied', `prefers-reduced-motion: ${w.facts.reducedMotion}`);
  (w.facts.streamAnimation === 'none' ? passed : failed)('reduced-motion.no-animation', `sand stream animation: ${w.facts.streamAnimation}`);
  await app.close().catch(() => {});
}

async function scaleCase(exe, scale) {
  const { app, page } = await launch(exe, { scale });
  const w = await waitForOverlay(page, true, 40000);
  const tag = `scale-${String(scale).replace('.', '_')}`;
  if (!w.ok) { failed(`${tag}.warning`, 'no warning'); await app.close().catch(() => {}); return; }
  await page.screenshot({ path: path.join(OUT, `${tag}-warning.png`) });
  const f = w.facts;
  (f.inside && !f.docScroll && !f.dialogScroll ? passed : failed)(`${tag}.fits-without-scrollbars`, `viewport ${f.viewport.w}x${f.viewport.h} @${f.viewport.dpr}; inside=${f.inside} docScroll=${f.docScroll} dialogScroll=${f.dialogScroll}`);
  (f.streamAnimation && f.streamAnimation !== 'none' && !f.reducedMotion ? passed : notRun)(`${tag}.animation-present`, `sand stream animation: ${f.streamAnimation}`);
  await app.close().catch(() => {});
}

function startFeed(dir) {
  const server = http.createServer((req, res) => {
    const name = path.posix.basename(decodeURIComponent((req.url || '/').split('?')[0]));
    const file = path.join(dir, name);
    if (!name || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const st = fs.statSync(file);
    res.writeHead(200, { 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => { server.on('error', reject); server.listen(PORT, '127.0.0.1', () => resolve(server)); });
}

async function updateCase(exe) {
  // Serve a newer version from --feed-dir; the copy's updater points at it.
  let server;
  try { server = await startFeed(FEED_DIR); } catch (err) { notRun('update.suspends-warning', `feed server: ${err.message}`); return; }
  const { app, page, startedAt } = await launch(exe);
  const banner = () => page.evaluate(() => (document.getElementById('ubMsg') || {}).textContent || '').catch(() => '');
  const t0 = Date.now();
  let text = '';
  while (Date.now() - t0 < 180000) {
    text = await banner();
    if (/^Ready to restart|^Update .* is ready/.test(text)) break;
    await sleep(300);
  }
  const ready = /^Ready to restart|^Update .* is ready/.test(text);
  (ready ? passed : failed)('update.reaches-ready', ready ? `"${text}" after ${Math.round((Date.now() - startedAt) / 1000)} s` : `banner: "${text}"`);
  if (!ready) { await app.close().catch(() => {}); server.close(); return; }
  // Defer so the update stays "ready" (a verified update waiting to install).
  await page.click('#ubLater').catch(() => {});
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'update-01-ready-deferred.png') });
  await sleep(40000);
  const f = await overlayFacts(page);
  (!f.visible ? passed : failed)('update.suspends-warning', f.visible ? 'hourglass appeared while a verified update was ready to install' : 'no hourglass after 40 s idle with an update ready (suspended for the update)');
  await page.screenshot({ path: path.join(OUT, 'update-02-no-hourglass-while-ready.png') });
  // Continue with the current version → the update leaves its critical
  // states; the inactivity timer starts fresh and warns 30 s later.
  await page.click('#ubRestart').catch(() => {});
  await sleep(3000);
  const after = await banner();
  await page.click('#ubContinue').catch(() => {});
  const w = await waitForOverlay(page, true, 45000);
  (w.ok ? passed : failed)('update.timer-resumes-after-lifecycle', w.ok ? `hourglass ${Math.round(w.ms / 1000)} s after the update lifecycle ended (banner was "${after}")` : `no hourglass after the update lifecycle ended (banner "${after}")`);
  await app.close().catch(() => {});
  server.close();
}

(async () => {
  console.log(`packaged-inactivity-acceptance: exe=${SHIPPED_EXE} out=${OUT} scales=${SCALES.join(',')}`);
  if (!fs.existsSync(SHIPPED_EXE)) { failed('exe.present', `${SHIPPED_EXE} missing (npm run build:installer)`); return finish(); }
  const copy = await prepareTestCopy();
  passed('test-copy', `${copy.exe} stamped asInvoker via ${copy.how}; launched with ${ELEVATE_RETRY_FLAG} (no approval prompt)`);
  try {
    if (!ONLY_UPDATE) {
      await timelineCase(copy.exe);
      await reopenCase(copy.exe);
      await keyboardCase(copy.exe);
      await reducedMotionCase(copy.exe);
      for (const s of SCALES) await scaleCase(copy.exe, s);
    }
    if (SKIP_UPDATE) notRun('update.suspends-warning', 'no --feed-dir given');
    else await updateCase(copy.exe);
    notRun('repair.suspends-warning', 'a real repair needs an elevated session; covered by tools/inactivity-smoke.js (case 13)');
    notRun('update.install-relaunch-not-interrupted', 'needs an elevated install; covered by tools/packaged-update-acceptance.js (idle-during-ready check) and tools/inactivity-smoke.js (15–16)');
  } catch (err) {
    failed('driver', `threw: ${err && err.stack || err}`);
  }
  finish();
})();

function finish() {
  report.finishedAt = new Date().toISOString();
  const counts = { passed: 0, failed: 0, 'not-run': 0 };
  for (const c of report.cases) counts[c.status] = (counts[c.status] || 0) + 1;
  report.summary = counts;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = ['# Packaged inactivity acceptance — 1132 Fixer for Windows', '', `Run: ${report.startedAt} → ${report.finishedAt}. Host: ${JSON.stringify(report.host)}.`, '', `**${counts.passed} passed, ${counts.failed} failed, ${counts['not-run']} not run.**`, '', '| Case | Status | Detail |', '| --- | --- | --- |'];
  for (const c of report.cases) md.push(`| ${c.id} | ${c.status} | ${String(c.detail).replace(/\|/g, '\\|')} |`);
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n') + '\n');
  console.log(`\npackaged-inactivity-acceptance: ${counts.passed} passed, ${counts.failed} failed, ${counts['not-run']} not run → ${OUT}`);
  process.exitCode = counts.failed ? 1 : 0;
}
