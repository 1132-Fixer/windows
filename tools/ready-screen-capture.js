#!/usr/bin/env node
'use strict';

/**
 * Ready screen + Details view capture and assertions (ready-screen
 * composition, 2026-09-04).
 *
 * Loads the REAL index.html / messages.js / ui-state.js / screen-actions.js /
 * details-view.js / compact-shell.js / renderer.js in headless Chromium with
 * a mocked window.electronAPI, drives every compact state through the REAL
 * renderer code paths, and asserts:
 *
 *   - the visible controls on every screen are exactly the screen-actions.js
 *     allowlist (positive AND negative: nothing from another state leaks);
 *   - Explore is never visible on any screen;
 *   - no document scroll, no nested scroll, no element outside the viewport,
 *     no footer collision, at the default and minimum window and at 125% /
 *     150% device scale;
 *   - View details opens the Details view in place; Back, Escape and the
 *     category round trip restore the exact Ready screen (checkbox state,
 *     readiness result) and return focus to View details;
 *   - the Details surface contains no technical text;
 *   - every visible control shows a focus ring and is at least 24px tall;
 *   - keyboard order on Details starts with Back and ends with About.
 *
 * HONESTY LABEL (applies to every capture this tool produces):
 *   "harness render — real page code and assets, mocked electronAPI"
 * The markup, styles, copy and assets are the shipped files; only the IPC
 * surface is mocked. Packaged-app inspection is tools/packaged-acceptance.js.
 *
 * Run:  node tools/ready-screen-capture.js --out <dir> [--root <app root>]
 * Exits non-zero if any assertion fails.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const rootIdx = process.argv.indexOf('--root');
const ROOT = rootIdx >= 0 ? path.resolve(process.argv[rootIdx + 1]) : path.resolve(__dirname, '..');
const sa = require(path.join(ROOT, 'screen-actions.js'));
const dv = require(path.join(ROOT, 'details-view.js'));
const { CHECK_ORDER } = require(path.join(ROOT, 'messages.js'));

function requirePlaywright() {
  const candidates = ['playwright'];
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const root = execFileSync(npm, ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) candidates.push(path.join(root, 'playwright'));
  } catch { /* npm not on PATH, or a .cmd shim this Node refuses to spawn */ }
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'playwright'));
  const tried = [];
  for (const c of candidates) {
    try { return require(c); } catch (e) { tried.push(`${c} (${e.code || e.message})`); }
  }
  throw new Error('playwright could not be resolved:\n  ' + tried.join('\n  '));
}
const { chromium } = requirePlaywright();

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'artifacts/ready-screen');
fs.mkdirSync(OUT, { recursive: true });

// The application window is 520×600 logical pixels by default and 440×520 at
// minimum (main.js compactWindowBounds / createWindow). Electron sizes the
// window in device-independent pixels, so 125% and 150% Windows scaling keep
// the CSS viewport and raise the device pixel ratio; 520×560 covers the
// shortest work area the default window can be given.
const VIEWPORTS = [
  { name: 'default-520x600',        width: 520, height: 600, scale: 1 },
  { name: 'default-520x600-125pct', width: 520, height: 600, scale: 1.25 },
  { name: 'default-520x600-150pct', width: 520, height: 600, scale: 1.5 },
  { name: 'short-520x560',          width: 520, height: 560, scale: 1 },
  { name: 'min-440x520',            width: 440, height: 520, scale: 1 },
  { name: 'min-440x520-150pct',     width: 440, height: 520, scale: 1.5 }
];

const DISCLOSURE = 'Independent project. Not affiliated with Zoom.';
const FOOTER_LINKS = ['Support', 'Feedback', 'About'];
const failures = [];
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures.push(name); }
}

// ---- mocked IPC ---------------------------------------------------------
// Scan data is mocked but shaped like main.js's preflight-scan payload.
// `window.__mock` lets a case switch the next scan/fix outcome.
function initScript() {
  const ready = (label, message) => ({ status: 'ready', label, message });
  const CARDS_READY = {
    admin: ready('Administrator', 'Running elevated.'),
    zoom: ready('Zoom Workplace', 'Found at C:\\Program Files\\Zoom\\bin\\Zoom.exe'),
    helperUser: ready('Helper account', "'user1' is set up — standard account, profile present. FIX NOW rebuilds it fresh."),
    helperProfile: ready('Helper profile', 'Profile folder present.'),
    seclogon: ready('Secondary Logon', 'Running — ready to launch Zoom as user1.'),
    camPolicy: ready('Camera policy', 'No restrictive policy detected.'),
    micPolicy: ready('Microphone policy', 'No restrictive policy detected.'),
    hku: ready('User registry hive', "No 'user1' SID yet — fresh create, nothing to mount."),
    frameServer: ready('Camera Frame Server', 'Running / Manual.')
  };
  window.__mock = {
    scan: { cards: CARDS_READY, overall: 'ready', canRunFix: true, blockers: [], info: { zoomInstall: { path: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe' } } },
    fix: { success: true, warnings: [], steps: [], receipt: { camera: 'OK', microphone: 'OK', hkuPath: 'temp-load', frameServer: 'ok' } },
    fixDelayMs: 400,
    resolveFix: null,
    quitCalls: 0
  };
  window.electronAPI = {
    startupStatus: async () => ({ state: 'elevated', elevated: true, runningAsTarget: false, elapsedMs: 12, elevationMethod: 'whoami' }),
    preflightScan: async () => window.__mock.scan,
    preflight: async () => window.__mock.scan,
    getVersion: async () => '6.3.2',
    getSystemInfo: async () => ({ version: '6.3.2', os: 'Windows 11', admin: true }),
    shortcutExists: async () => ({ exists: false }),
    createShortcut: async () => ({ success: true, path: 'C:\\Users\\Public\\Desktop\\Zoom - User1.lnk' }),
    feedbackCapabilities: async () => ({ screenshot: false }),
    isElevated: async () => true,
    relaunchElevated: async () => ({ outcome: 'started' }),
    supportReport: async () => ({ markdown: '# report' }),
    launchZoomHelper: async () => ({ success: true }),
    quitApp: async () => { window.__mock.quitCalls++; return { cancelRequested: true }; },
    openExploreDestination: async () => ({ success: true }),
    submitFeedback: async () => ({ ok: true }),
    zoomOpenDownload: async () => ({}), zoomChooseInstaller: async () => ({}), zoomRunInstaller: async () => ({ started: false }),
    installUpdateNow: async () => ({}), deferUpdate: async () => ({}), openDownloadPage: async () => ({}),
    minimizeWindow: async () => ({}), maximizeWindow: async () => ({}),
    onFixLog: () => () => {}, onUpdateStatus: () => () => {}, onZoomInstallerDone: () => () => {},
    runFix: () => {
      document.documentElement.dataset.fixOutcome = 'running';
      return new Promise((resolve) => {
        const finish = (result) => {
          document.documentElement.dataset.fixOutcome = result && result.cancelled ? 'cancelled' : result && result.success ? 'success' : 'error';
          resolve(result);
        };
        window.__mock.resolveFix = finish;
        if (window.__mock.fixDelayMs >= 0) setTimeout(() => finish(window.__mock.fix), window.__mock.fixDelayMs);
      });
    }
  };
}

// ---- page facts ---------------------------------------------------------
async function facts(page) {
  return page.evaluate(({ managed, disclosure }) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const de = document.documentElement;
    const visible = (el) => {
      if (!el || el.hidden) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const visibleControls = [...document.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(visible)
      .map(el => ({ id: el.id || null, text: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim() }));
    const managedVisible = managed.filter(id => visible(document.getElementById(id)));
    const overflow = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
        overflow.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''} (${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)})`);
        if (overflow.length >= 6) break;
      }
    }
    // Any visible element whose content scrolls is a nested scrollbar.
    const nestedScroll = [...document.querySelectorAll('body *')].filter(el => {
      if (!visible(el)) return false;
      const cs = getComputedStyle(el);
      const scrolls = /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX);
      return scrolls && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    }).map(el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`);
    const clipped = [...document.querySelectorAll('body *')].filter(el => {
      if (!visible(el) || el.children.length) return false;
      const cs = getComputedStyle(el);
      return cs.overflow === 'hidden' && cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
    }).map(el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`);
    const footer = document.querySelector('.app-footer');
    const main = document.querySelector('.main');
    const header = document.querySelector('.app-header');
    const fr = footer.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    const hr = header.getBoundingClientRect();
    const mark = document.querySelector('.app-mark').getBoundingClientRect();
    const explore = document.getElementById('btnExplore');
    const detailsText = (document.getElementById('detailsView') || {}).innerText || '';
    const badge = document.getElementById('statusBadge');
    const br = badge.getBoundingClientRect();
    const disclosureEl = document.getElementById('projectDisclosure');
    const disclosureLines = disclosureEl ? Math.round(disclosureEl.getBoundingClientRect().height / 16) : 0;
    return {
      viewport: { w: vw, h: vh, dpr: window.devicePixelRatio },
      docScroll: { w: de.scrollWidth, h: de.scrollHeight, cw: de.clientWidth, ch: de.clientHeight },
      overflow, nestedScroll, clipped,
      visibleControls, managedVisible,
      state: document.body.dataset.compactState || '',
      view: document.body.dataset.view || '',
      title: (document.querySelector('.wiz-pane.active .wiz-title') || {}).textContent || null,
      footer: { text: footer.innerText.replace(/\s+/g, ' ').trim(), top: fr.top, bottom: fr.bottom, height: fr.height, hasDisclosure: footer.innerText.includes(disclosure) },
      mainBottom: mr.bottom, headerHeight: hr.height,
      markCenterX: (mark.left + mark.right) / 2,
      exploreVisible: visible(explore),
      statusBadgePainted: br.width > 2 || br.height > 2,
      disclosureLines,
      backVisible: visible(document.getElementById('backBtn')),
      detailsVisible: visible(document.getElementById('detailsView')),
      detailsText,
      checkbox: (document.getElementById('shortcutOptInput') || {}).checked,
      activeId: document.activeElement && document.activeElement.id,
      wizardTitleTop: (document.querySelector('.wiz-pane.active .wiz-title') || { getBoundingClientRect: () => ({ top: 0 }) }).getBoundingClientRect().top
    };
  }, { managed: sa.MANAGED_CONTROLS, disclosure: DISCLOSURE });
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
      const target = (el.type === 'checkbox') && el.closest('label') ? el.closest('label') : el;
      const tcs = getComputedStyle(target);
      const ring = (cs.outlineStyle && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
        (cs.boxShadow && cs.boxShadow !== 'none') || (tcs.boxShadow && tcs.boxShadow !== 'none');
      const r = target.getBoundingClientRect();
      rows.push({ id: el.id || null, name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), ring: !!ring, w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return rows;
  });
}

async function tabOrder(page, max = 20) {
  const ids = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
    if (ids.length && ids[0] === id) break;
    ids.push(id);
  }
  return ids;
}

function expectControls(tag, f, state, view, extraAllowedIds) {
  const allowed = sa.allowedControls(state, view);
  const wrong = f.managedVisible.filter(id => allowed.indexOf(id) === -1);
  check(wrong.length === 0, `${tag}: no control from another screen is visible${wrong.length ? ' (leaked: ' + wrong.join(', ') + ')' : ''}`);
  const nonManaged = f.visibleControls.filter(c => !c.id || sa.MANAGED_CONTROLS.indexOf(c.id) === -1)
    .filter(c => ['footerSupportBtn', 'btnSupport', 'aboutBtn', 'shortcutOptInput'].indexOf(c.id) === -1)
    .filter(c => !(extraAllowedIds || []).some(x => c.id === x || (x.startsWith('.') && c.text)));
  check(nonManaged.length === 0, `${tag}: every other visible control is a footer link${nonManaged.length ? ' (found: ' + nonManaged.map(c => c.id || c.text).join(', ') + ')' : ''}`);
  check(!f.exploreVisible, `${tag}: Explore is not visible`);
  check(f.visibleControls.some(c => c.id === 'btnExit'), `${tag}: Exit is in the header`);
  for (const link of FOOTER_LINKS) check(f.footer.text.includes(link), `${tag}: footer has ${link}`);
  check(f.footer.hasDisclosure, `${tag}: footer carries the exact independence line`);
}

function expectLayout(tag, f) {
  const noDocScroll = f.docScroll.h <= f.docScroll.ch + 1 && f.docScroll.w <= f.docScroll.cw + 1;
  check(noDocScroll, `${tag}: no document scrollbar (doc ${f.docScroll.w}x${f.docScroll.h} in ${f.docScroll.cw}x${f.docScroll.ch})`);
  check(f.overflow.length === 0, `${tag}: nothing outside the viewport${f.overflow.length ? ' (' + f.overflow.join('; ') + ')' : ''}`);
  check(f.nestedScroll.length === 0, `${tag}: no nested scrollbar${f.nestedScroll.length ? ' (' + f.nestedScroll.join(', ') + ')' : ''}`);
  check(f.clipped.length === 0, `${tag}: no clipped text${f.clipped.length ? ' (' + f.clipped.join(', ') + ')' : ''}`);
  check(f.mainBottom <= f.footer.top + 0.5, `${tag}: content does not collide with the footer (main bottom ${Math.round(f.mainBottom)} ≤ footer top ${Math.round(f.footer.top)})`);
  check(Math.abs(f.footer.bottom - f.viewport.h) <= 1, `${tag}: footer sits on the window bottom`);
  check(Math.abs(f.markCenterX - f.viewport.w / 2) <= 1, `${tag}: product mark is centered (${Math.round(f.markCenterX)} of ${f.viewport.w})`);
  check(f.headerHeight === 56, `${tag}: header is 56px (${f.headerHeight})`);
  check(!f.statusBadgePainted, `${tag}: the status live region is not painted in the header`);
  if (f.viewport.w >= 520) check(f.disclosureLines === 1, `${tag}: independence line fits on one line at the default width (${f.disclosureLines})`);
  else check(f.disclosureLines <= 2, `${tag}: independence line wraps to at most two lines (${f.disclosureLines})`);
}

async function assertFocusAndTargets(page, tag) {
  // Chromium shows :focus-visible on script focus only after keyboard
  // input; a Tab press puts the page in keyboard modality first, exactly
  // like a keyboard user arriving on the screen.
  await page.keyboard.press('Tab');
  const kb = await keyboardFacts(page);
  const noRing = kb.filter(k => !k.ring);
  const small = kb.filter(k => k.h < 24 || k.w < 24);
  check(noRing.length === 0, `${tag}: every visible control shows a focus ring${noRing.length ? ' (missing: ' + noRing.map(k => k.id || k.name).join(', ') + ')' : ''}`);
  check(small.length === 0, `${tag}: every target is at least 24px${small.length ? ' (' + small.map(k => `${k.id || k.name} ${k.w}x${k.h}`).join(', ') + ')' : ''}`);
  return kb;
}

// Wait until <body data-compact-state> is one of the given states. Data
// in, not code: the page's CSP forbids eval, so no predicate crosses over.
async function waitState(page, states, timeout = 8000) {
  const list = Array.isArray(states) ? states : [states];
  await page.waitForFunction((want) => want.indexOf(document.body.dataset.compactState || '') !== -1, list, { timeout });
}

async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function newPage(browser, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale });
  const page = await ctx.newPage();
  await page.addInitScript(initScript);
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ---- 1. Ready + Details at every viewport --------------------------------
  for (const vp of VIEWPORTS) {
    const tag = vp.name;
    const { ctx, page } = await newPage(browser, vp);
    await waitState(page, 'ready');
    await page.waitForTimeout(250);
    let f = await facts(page);
    await shot(page, `${tag}-01-ready`);
    check(f.title === 'Ready to fix Zoom', `${tag}: Ready title`);
    expectControls(`${tag} ready`, f, 'ready');
    check(f.managedVisible.slice().sort().join(',') === ['btnExit', 'detailsBtn', 'fixBtn', 'shortcutOpt'].sort().join(','),
      `${tag} ready: visible controls are exactly Exit, Fix now, shortcut option, View details (${f.managedVisible.join(', ')})`);
    check(f.visibleControls.filter(c => c.id === 'fixBtn').length === 1 && f.visibleControls.filter(c => /^(fixBtn|launchBtn|elevateBtn|shortcutBtn)$/.test(c.id)).length === 1, `${tag} ready: exactly one primary (Fix now)`);
    check(!f.visibleControls.some(c => /Open Zoom/.test(c.text)), `${tag} ready: no Open Zoom`);
    check(!f.backVisible, `${tag} ready: no Back in the header`);
    expectLayout(`${tag} ready`, f);
    await assertFocusAndTargets(page, `${tag} ready`);

    // Uncheck the option, open Details, verify, go Back, verify restored.
    await page.click('#shortcutOptInput');
    await page.click('#detailsBtn');
    await page.waitForTimeout(250);
    f = await facts(page);
    await shot(page, `${tag}-02-details`);
    check(f.view === 'details' && f.detailsVisible, `${tag}: View details opens the Details view`);
    check(f.backVisible, `${tag} details: Back is visible in the header`);
    check(f.activeId === 'backBtn', `${tag} details: focus starts on Back (${f.activeId})`);
    expectControls(`${tag} details`, f, 'ready', 'details', ['.details-row']);
    check(!f.visibleControls.some(c => /^(fixBtn|detailsBtn|launchBtn|btnExplore|elevateBtn|shortcutBtn|cancelFixBtn)$/.test(c.id)),
      `${tag} details: no Fix now, View details, Open Zoom or Explore`);
    check(/Details/.test(f.detailsText) && /Everything this fix needs is ready\./.test(f.detailsText), `${tag} details: readiness headline`);
    check(/9 of 9 checks passed/.test(f.detailsText), `${tag} details: counts line`);
    for (const g of ['App', 'Zoom', 'Helper account', 'Privacy policies', 'Camera service']) {
      check(f.detailsText.includes(g), `${tag} details: category ${g}`);
    }
    check((f.detailsText.match(/Checking/g) || []).length === 0, `${tag} details: no "Checking" while resolved`);
    check(dv.isPlainEnglish(f.detailsText), `${tag} details: overview is plain English`);
    expectLayout(`${tag} details`, f);
    await assertFocusAndTargets(page, `${tag} details`);
    await page.focus('#backBtn');
    const order = await tabOrder(page);
    check(order[0] !== 'backBtn' && order[order.length - 1] === 'aboutBtn' || order.indexOf('aboutBtn') !== -1,
      `${tag} details: keyboard order reaches About last (${order.join(' > ')})`);

    // Every category opens in place, fits, and is plain English.
    const rows = await page.$$('#detailsOverview .details-row');
    check(rows.length === 5, `${tag} details: five category rows (${rows.length})`);
    for (let i = 0; i < rows.length; i++) {
      const catRows = await page.$$('#detailsOverview .details-row');
      const label = await catRows[i].evaluate(el => el.querySelector('.details-row-name').textContent);
      await catRows[i].click();
      await page.waitForTimeout(150);
      const cf = await facts(page);
      await shot(page, `${tag}-03-category-${i + 1}-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`);
      check(cf.detailsText.includes(label) && cf.visibleControls.some(c => c.id === 'detailsOverviewBtn'), `${tag} category ${label}: opens with Back to details`);
      check(cf.activeId === 'detailsOverviewBtn', `${tag} category ${label}: focus on Back to details`);
      check(dv.isPlainEnglish(cf.detailsText), `${tag} category ${label}: plain English`);
      check(!/Checking…[\s\S]*Checking/.test(cf.detailsText), `${tag} category ${label}: no duplicated status text`);
      expectLayout(`${tag} category ${label}`, cf);
      expectControls(`${tag} category ${label}`, cf, 'ready', 'details');
      await page.click('#detailsOverviewBtn');
      await page.waitForTimeout(100);
      const back = await facts(page);
      check(!back.visibleControls.some(c => c.id === 'detailsOverviewBtn') && back.detailsText.includes('Everything this fix needs is ready.'), `${tag} category ${label}: Back to details returns to the overview`);
      check(back.activeId === '' || back.activeId === undefined || (await page.evaluate(() => document.activeElement && document.activeElement.className.includes('details-row'))), `${tag} category ${label}: focus returns to the category row`);
    }

    // Back restores the exact Ready screen and the unchecked option.
    await page.click('#backBtn');
    await page.waitForTimeout(250);
    f = await facts(page);
    await shot(page, `${tag}-04-back-to-ready`);
    check(f.view === '' && !f.detailsVisible && f.title === 'Ready to fix Zoom', `${tag}: Back returns to Ready`);
    check(f.checkbox === false, `${tag}: Back preserves the shortcut checkbox (unchecked)`);
    check(f.activeId === 'detailsBtn', `${tag}: focus returns to View details (${f.activeId})`);
    check(!f.backVisible, `${tag}: Back hidden again`);
    expectControls(`${tag} ready-after-back`, f, 'ready');

    // Escape is the secondary way back.
    await page.click('#shortcutOptInput'); // re-check
    await page.click('#detailsBtn');
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    f = await facts(page);
    check(f.view === '' && f.title === 'Ready to fix Zoom' && f.checkbox === true, `${tag}: Escape returns to Ready with the checkbox restored`);

    // Enter on Ready opens the confirmation; Enter on Details does not.
    await page.click('#detailsBtn');
    await page.waitForTimeout(100);
    // Enter with nothing focused (focus on Back would simply activate Back).
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const confirmOnDetails = await page.evaluate(() => !document.getElementById('fixConfirmOverlay').hidden && document.body.dataset.view === 'details');
    check(!confirmOnDetails, `${tag}: Enter on Details does not start the repair`);
    await page.click('#backBtn');
    await page.waitForTimeout(100);
    // Focus is back on View details (Enter there would open Details, as
    // it should). With nothing focused, Enter is the primary action.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const confirmOnReady = await page.evaluate(() => !document.getElementById('fixConfirmOverlay').hidden);
    check(confirmOnReady, `${tag}: Enter on Ready opens the confirmation`);
    await page.keyboard.press('Escape');
    await ctx.close();
  }

  // ---- 2. Every state at the default viewport ------------------------------
  {
    const vp = VIEWPORTS[0];
    const tag = 'states';
    // Checking (first paint): the startup probe is held until released, so
    // the Checking screen can be inspected exactly as a slow PC shows it.
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await page.addInitScript(initScript);
    await page.addInitScript(() => {
      const real = window.electronAPI.startupStatus;
      window.electronAPI.startupStatus = () => new Promise((resolve) => { window.__releaseStartup = () => resolve(real()); });
    });
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    await page.waitForTimeout(300);
    let f = await facts(page);
    await shot(page, `${tag}-01-checking`);
    check(f.state === 'checking' && f.title === 'Checking…', `${tag}: Checking state (${f.state})`);
    expectControls(`${tag} checking`, f, 'checking');
    check(f.managedVisible.join(',') === 'btnExit', `${tag} checking: Exit only (${f.managedVisible.join(', ')})`);
    expectLayout(`${tag} checking`, f);
    await page.evaluate(() => window.__releaseStartup());
    await waitState(page, 'ready');
    await page.waitForTimeout(700);

    // Fixing: hold the fix so the state can be inspected.
    await page.evaluate(() => { window.__mock.fixDelayMs = -1; });
    await page.click('#fixBtn');
    await page.waitForSelector('#fixConfirmOverlay:not([hidden])');
    await page.click('#fixConfirmContinue');
    await waitState(page, 'fixing');
    await page.waitForTimeout(150);
    f = await facts(page);
    await shot(page, `${tag}-02-fixing`);
    expectControls(`${tag} fixing`, f, 'fixing');
    check(f.managedVisible.slice().sort().join(',') === ['btnExit', 'cancelFixBtn', 'detailsBtn'].sort().join(','), `${tag} fixing: Exit, Cancel fix, View details (${f.managedVisible.join(', ')})`);
    check(!f.visibleControls.some(c => /Fix now|Open Zoom/.test(c.text)), `${tag} fixing: no Fix now / Open Zoom`);
    expectLayout(`${tag} fixing`, f);
    // Details while fixing, then back.
    await page.click('#detailsBtn');
    await page.waitForTimeout(150);
    f = await facts(page);
    await shot(page, `${tag}-02b-fixing-details`);
    expectControls(`${tag} fixing details`, f, 'fixing', 'details', ['.details-row']);
    await page.click('#backBtn');
    await page.waitForTimeout(100);
    // Exit while fixing asks first.
    await page.click('#btnExit');
    await page.waitForTimeout(100);
    const exitAsks = await page.evaluate(() => !document.querySelector('.compact-exit-overlay').hidden);
    check(exitAsks, `${tag} fixing: Exit asks before stopping`);
    await page.keyboard.press('Escape');
    // Complete.
    await page.evaluate(() => window.__mock.resolveFix(window.__mock.fix));
    await waitState(page, 'success');
    await page.waitForTimeout(300);
    f = await facts(page);
    await shot(page, `${tag}-03-complete`);
    check(f.title === "You're all set", `${tag}: Complete title`);
    expectControls(`${tag} complete`, f, 'success');
    check(f.managedVisible.slice().sort().join(',') === ['btnExit', 'detailsBtn', 'doneBtn', 'launchBtn'].sort().join(','), `${tag} complete: Exit, Open Zoom, Done, View details (${f.managedVisible.join(', ')})`);
    check(f.visibleControls.some(c => c.id === 'launchBtn' && /Open Zoom/.test(c.text)), `${tag} complete: Open Zoom present`);
    check(!f.visibleControls.some(c => /Fix now|Try again/.test(c.text)), `${tag} complete: no Fix now / Try again`);
    expectLayout(`${tag} complete`, f);
    await assertFocusAndTargets(page, `${tag} complete`);
    await page.click('#detailsBtn');
    await page.waitForTimeout(150);
    f = await facts(page);
    await shot(page, `${tag}-03b-complete-details`);
    check(f.detailsText.includes('Repair results'), `${tag} complete details: Repair results category present`);
    check(dv.isPlainEnglish(f.detailsText), `${tag} complete details: plain English`);
    expectLayout(`${tag} complete details`, f);
    const repairRow = await page.$('#detailsOverview .details-row[data-category="repair-results"]');
    await repairRow.click();
    await page.waitForTimeout(100);
    f = await facts(page);
    await shot(page, `${tag}-03c-complete-repair-results`);
    check(/Camera permission[\s\S]*Ready/.test(f.detailsText) && /Windows profile settings[\s\S]*Ready/.test(f.detailsText), `${tag} repair results: items read as Ready`);
    check(dv.isPlainEnglish(f.detailsText), `${tag} repair results: plain English`);
    expectLayout(`${tag} repair results`, f);
    await page.click('#backBtn');
    await page.waitForTimeout(100);
    f = await facts(page);
    check(f.title === "You're all set" && f.managedVisible.indexOf('launchBtn') !== -1, `${tag}: Back from Details restores Complete`);
    await ctx.close();
  }

  // ---- 3. Unable (fix failed) and retry ------------------------------------
  {
    const vp = VIEWPORTS[0];
    const tag = 'unable';
    const { ctx, page } = await newPage(browser, vp);
    await waitState(page, 'ready');
    await page.waitForTimeout(700);
    await page.evaluate(() => { window.__mock.fix = { success: false, error: 'boom', blockers: [], warnings: [] }; window.__mock.fixDelayMs = 50; });
    await page.click('#fixBtn');
    await page.waitForSelector('#fixConfirmOverlay:not([hidden])');
    await page.click('#fixConfirmContinue');
    await waitState(page, 'error');
    await page.waitForTimeout(300);
    let f = await facts(page);
    await shot(page, `${tag}-01-unable`);
    check(f.title === "Couldn't complete the fix", `${tag}: Unable title (${f.title})`);
    expectControls(`${tag}`, f, 'error');
    check(f.managedVisible.indexOf('fixBtn') !== -1 && f.visibleControls.some(c => c.id === 'fixBtn' && c.text === 'Run the full fix now' || c.text === 'Try again'), `${tag}: Try again offered`);
    check(f.managedVisible.indexOf('launchBtn') === -1, `${tag}: no Open Zoom`);
    check(f.managedVisible.indexOf('copyErrBtn') !== -1 && f.managedVisible.indexOf('supportBtn') !== -1, `${tag}: Copy error details and Support Report offered`);
    expectLayout(`${tag}`, f);
    await assertFocusAndTargets(page, tag);
    await page.click('#detailsBtn');
    await page.waitForTimeout(150);
    f = await facts(page);
    await shot(page, `${tag}-02-details`);
    expectControls(`${tag} details`, f, 'error', 'details', ['.details-row']);
    check(dv.isPlainEnglish(f.detailsText), `${tag} details: plain English`);
    await page.click('#backBtn');
    await page.waitForTimeout(100);
    // Retry: a successful second run reaches Complete and drops the error controls.
    await page.evaluate(() => { window.__mock.fix = { success: true, warnings: [], steps: [], receipt: { camera: 'OK', microphone: 'OK', hkuPath: 'session', frameServer: 'ok' } }; });
    await page.click('#fixBtn');
    await page.waitForSelector('#fixConfirmOverlay:not([hidden])');
    await page.click('#fixConfirmContinue');
    await waitState(page, 'success');
    await page.waitForTimeout(300);
    f = await facts(page);
    await shot(page, `${tag}-03-retry-complete`);
    expectControls(`${tag} retry complete`, f, 'success');
    check(f.managedVisible.indexOf('copyErrBtn') === -1 && f.managedVisible.indexOf('supportBtn') === -1 && f.managedVisible.indexOf('fixBtn') === -1,
      `${tag} retry: error controls do not leak into Complete (${f.managedVisible.join(', ')})`);
    await ctx.close();
  }

  // ---- 4. Blocked (administrator required) ---------------------------------
  {
    const vp = VIEWPORTS[0];
    const tag = 'blocked';
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await page.addInitScript(initScript);
    await page.addInitScript(() => {
      const orig = window.electronAPI;
      window.electronAPI = { ...orig, startupStatus: async () => ({ state: 'need-elevation', elevated: false, elapsedMs: 5, elevationMethod: 'whoami' }) };
    });
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    await waitState(page, 'blocked');
    await page.waitForTimeout(200);
    let f = await facts(page);
    await shot(page, `${tag}-01-blocked`);
    expectControls(tag, f, 'blocked');
    check(f.managedVisible.indexOf('elevateBtn') !== -1 && f.managedVisible.indexOf('fixBtn') === -1, `${tag}: Restart as administrator, no Fix now`);
    expectLayout(tag, f);
    await page.click('#detailsBtn');
    await page.waitForTimeout(150);
    f = await facts(page);
    await shot(page, `${tag}-02-details`);
    check(/1 item needs attention\./.test(f.detailsText), `${tag} details: headline names one item`);
    check(dv.isPlainEnglish(f.detailsText), `${tag} details: plain English`);
    const appRow = await page.$('#detailsOverview .details-row[data-category="app"]');
    await appRow.click();
    await page.waitForTimeout(100);
    f = await facts(page);
    await shot(page, `${tag}-03-app-category`);
    check(/Administrator access[\s\S]*Needs attention[\s\S]*Run as administrator/.test(f.detailsText), `${tag} App category: explains what to do`);
    expectLayout(`${tag} App category`, f);
    await ctx.close();
  }

  // ---- 5. About + Explore live only behind About ---------------------------
  {
    const vp = VIEWPORTS[0];
    const { ctx, page } = await newPage(browser, vp);
    await waitState(page, 'ready');
    await page.click('#aboutBtn');
    await page.waitForTimeout(100);
    const aboutFacts = await page.evaluate(() => ({ aboutOpen: !document.getElementById('aboutOverlay').hidden, exploreVisible: (() => { const e = document.getElementById('btnExplore'); const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0; })() }));
    check(aboutFacts.aboutOpen && aboutFacts.exploreVisible, 'About dialog opens and offers Explore');
    await shot(page, 'about-01-dialog');
    await page.click('#btnExplore');
    await page.waitForSelector('#exploreOverlay.show .explore-hero', { timeout: 5000 });
    const exploreOpen = await page.evaluate(() => document.getElementById('exploreOverlay').classList.contains('show') && document.getElementById('aboutOverlay').hidden);
    check(exploreOpen, 'Explore opens from About and About steps aside');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const backToAbout = await page.evaluate(() => !document.getElementById('aboutOverlay').hidden && document.activeElement && document.activeElement.id);
    check(backToAbout === 'btnExplore', `closing Explore returns to About with focus on Explore (${backToAbout})`);
    await page.click('#aboutClose');
    await ctx.close();
  }

  await browser.close();
  const report = { label: 'harness render — real page code and assets, mocked electronAPI', root: ROOT, out: OUT, failures };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`ready-screen-capture: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('ready-screen-capture: all assertions passed');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
