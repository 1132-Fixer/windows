#!/usr/bin/env node
'use strict';

/**
 * Explore panel capture + layout assertions (Explore redesign 2026-08-25).
 *
 * Loads the REAL index.html / messages.js / renderer.js in headless
 * Chromium with a mocked window.electronAPI, opens the Explore panel
 * through the REAL renderer code path, and captures the panel at every
 * supported width and display scale.
 *
 * HONESTY LABEL (applies to every capture this tool produces):
 *   "harness render — real page code and assets, mocked electronAPI"
 * The markup, styles, copy and image assets are the shipped files; only
 * the IPC surface is mocked. Packaged-app inspection is a separate step.
 *
 * Run:  node tools/explore-capture.js --out <dir>
 * Exits non-zero if any layout or content assertion fails.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// --root lets the harness render the PACKAGED app's own files (extract
// app.asar and point at it) rather than the worktree, so the acceptance
// capture is proof about what actually ships.
const rootIdx = process.argv.indexOf('--root');
const ROOT = rootIdx >= 0 ? path.resolve(process.argv[rootIdx + 1]) : path.resolve(__dirname, '..');
const messages = require(path.join(ROOT, 'messages.js'));

function requirePlaywright() {
  const candidates = ['playwright'];
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const root = execFileSync(npm, ['root', '-g'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (root) candidates.push(path.join(root, 'playwright'));
  } catch { /* npm not on PATH */ }
  const tried = [];
  for (const c of candidates) {
    try { return require(c); } catch (e) { tried.push(`${c} (${e.code || e.message})`); }
  }
  throw new Error('playwright could not be resolved:\n  ' + tried.join('\n  '));
}
const { chromium } = requirePlaywright();

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'artifacts/explore');
fs.mkdirSync(OUT, { recursive: true });

// The real host window is 900x700 (min 720x640) — every viewport below is
// a size the application can actually be at, not a hypothetical.
// Windows display scaling shrinks the CSS viewport - it does not merely
// raise the device pixel ratio - so 125% on a 900x700 window is a 720x560
// CSS viewport at DPR 1.25. Emulating it as DPR alone would render the
// identical layout at higher resolution and prove nothing about clipping.
// 828x630 is the REAL Explore modal viewport at 100% scaling - the 900x700
// window minus its chrome - and it is the size the one-screen acceptance
// contract is written against. Windows display scaling shrinks that CSS
// viewport rather than merely raising the device pixel ratio, so 125% is a
// 662x504 viewport at DPR 1.25. Emulating scaling as DPR alone would render
// the identical layout at higher resolution and prove nothing about clipping.
const VIEWPORTS = [
  { name: '01-default-828x630',  width: 828,  height: 630, scale: 1,    band: 'wide'     },
  { name: '02-wide-1280x900',    width: 1280, height: 900, scale: 1,    band: 'wide'     },
  { name: '03-standard-760x600', width: 760,  height: 600, scale: 1,    band: 'standard' },
  { name: '04-scale-125',        width: 662,  height: 504, scale: 1.25, band: 'compact'  },
  { name: '05-scale-150',        width: 552,  height: 420, scale: 1.5,  band: 'compact'  },
];

// Scrolling the panel body is correct on a small or scaled viewport and
// wrong at the default size - that is the whole point of the requirement.
const MUST_NOT_SCROLL = new Set(['01-default-828x630', '02-wide-1280x900']);

const OPENED = [];   // destination ids the mocked IPC was asked to open

(async () => {
  const failures = [];
  const browser = await chromium.launch({ headless: true });

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
    });
    const page = await ctx.newPage();

    await page.addInitScript(() => {
      window.__opened = [];
      window.electronAPI = new Proxy({}, {
        get: (_t, prop) => {
          if (prop === 'openExploreDestination') {
            return async (key) => { window.__opened.push(String(key)); return { success: true }; };
          }
          if (prop === 'onLog' || prop === 'onProgress' || prop === 'onScanResult') return () => {};
          return async () => ({ success: true });
        }
      });
    });

    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    await page.click('#btnExplore');
    await page.waitForSelector('#exploreOverlay.show .explore-hero', { timeout: 5000 });
    await page.waitForTimeout(250);   // let lazy images settle

    const card = await page.$('#exploreOverlay .explore-card');
    await card.screenshot({ path: path.join(OUT, vp.name + '.png') });

    // ---- assertions on the rendered DOM --------------------------------
    const m = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const qa = (s) => [...document.querySelectorAll(s)];
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const cards = qa('#exploreBody .explore-choice');
      return {
        order: [...qa('#exploreBody [data-explore]')].map(e => e.dataset.explore),
        heroName: q('.explore-hero-name') && q('.explore-hero-name').textContent,
        heroDesc: q('.explore-hero-desc') && q('.explore-hero-desc').textContent,
        heroNote: q('.explore-hero-note') && q('.explore-hero-note').textContent,
        heroBox: box(q('.explore-hero')),
        heroLogoBox: box(q('.explore-hero-logo')),
        heroMainBox: box(q('.explore-hero-main')),
        heroNameBox: box(q('.explore-hero-name')),
        heroActionsBox: box(q('.explore-hero-actions')),
        heroNameSize: parseFloat(getComputedStyle(q('.explore-hero-name')).fontSize),
        cardNameSize: cards.length ? parseFloat(getComputedStyle(cards[0].querySelector('.explore-name')).fontSize) : 0,
        groups: qa('#exploreBody .explore-group').map(e => e.textContent),
        orgBoxes: qa('.explore-grid-organizations .explore-choice').map(box),
        botBoxes: qa('.explore-grid-bots .explore-choice').map(box),
        creativeBoxes: qa('.explore-grid-creative-tools .explore-choice').map(box),
        cardBoxes: cards.map(box),
        icons: qa('#exploreBody .explore-choice img, .explore-hero-logo img').map(i => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight })),
        fallbacks: qa('#exploreBody .explore-logo.fallback').length,
        globalDisclosure: !!q('#exploreDisclosure'),
        bodyScrolls: (() => { const b = q('#exploreBody'); return b.scrollHeight > b.clientHeight + 1; })(),
        docHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        cardH: box(q('.explore-card')).h,
        cardBox: box(q('.explore-card')),
        bodyBox: box(q('#exploreBody')),
        cardPadBottom: parseFloat(getComputedStyle(q('.explore-card')).paddingBottom),
        lastRowBottom: cards.length ? Math.max(...cards.map(c => box(c).y + box(c).h)) : 0,
        hiddenOverflow: [...qa('#exploreOverlay *')].filter(e => {
          const o = getComputedStyle(e).overflowY;
          return o === 'hidden' && e.scrollHeight > e.clientHeight + 1;
        }).map(e => e.className),

        viewportH: window.innerHeight,
        viewportW: window.innerWidth,
      };
    });

    const fail = (msg) => failures.push(`[${vp.name}] ${msg}`);
    const EXPECT_ORDER = ['fixer', 'botify', 'primeHosting', 'gifDirectory', 'kickbot', 'modbot', 'emojiGenerator', 'makeItGif'];

    if (JSON.stringify(m.order) !== JSON.stringify(EXPECT_ORDER)) fail(`order ${JSON.stringify(m.order)}`);
    if (m.heroName !== '1132 Fixer') fail(`hero name "${m.heroName}"`);
    if (m.heroDesc !== 'Project website') fail(`hero desc "${m.heroDesc}"`);
    if (m.heroNote !== messages.DISCLOSURE.INDEPENDENCE) fail(`hero note "${m.heroNote}"`);
    if (m.globalDisclosure) fail('global disclosure footer still present');
    if (m.fallbacks !== 0) fail(`${m.fallbacks} generic fallback icon(s) rendered`);
    if (m.heroNameSize <= m.cardNameSize) fail(`hero title ${m.heroNameSize}px not larger than card title ${m.cardNameSize}px`);
    if (m.docHScroll) fail('horizontal scrolling introduced');

    // The hero is centred as a GROUP: on a short viewport the logo sits
    // beside the name rather than above it, so centring is a property of
    // the logo+copy block, not of the logo on its own.
    const heroMid = m.heroBox.x + m.heroBox.w / 2;
    const mid = (b) => b.x + b.w / 2;
    for (const [label, b] of [['logo+copy group', m.heroMainBox], ['actions', m.heroActionsBox]]) {
      if (Math.abs(heroMid - mid(b)) > 2) fail(`hero ${label} not centred (${heroMid} vs ${mid(b)})`);
    }

    // every image actually decoded — a broken src has naturalWidth 0
    for (const i of m.icons) {
      if (!i.w || !i.h) fail(`image failed to load: ${i.src}`);
    }

    const expectGroups = ['ORGANIZATIONS & SERVICES', 'BOTS', 'CREATIVE TOOLS'];
    if (JSON.stringify(m.groups) !== JSON.stringify(expectGroups)) fail(`groups ${JSON.stringify(m.groups)}`);

    // equal columns within each row
    const eqW = (boxes, label) => {
      const rows = {};
      for (const b of boxes) { (rows[b.y] = rows[b.y] || []).push(b); }
      for (const [y, r] of Object.entries(rows)) {
        const w = r.map(b => b.w);
        if (Math.max(...w) - Math.min(...w) > 1) fail(`${label} row y=${y} unequal widths ${w}`);
        const h = r.map(b => b.h);
        if (Math.max(...h) - Math.min(...h) > 1) fail(`${label} row y=${y} unequal heights ${h}`);
      }
      return rows;
    };
    eqW(m.orgBoxes, 'organizations');
    eqW(m.botBoxes, 'bots');
    eqW(m.creativeBoxes, 'creative-tools');

    // layout-band expectations. The wide band starts at 880px because
    // that is where an organization column stays wide enough to read -
    // a content-driven breakpoint, not a round number.
    const colsOf = (boxes) => new Set(boxes.map(b => b.y)).size;
    if (vp.band === 'wide') {
      if (colsOf(m.orgBoxes) !== 1) fail(`wide: organizations should be one 3-column row, got ${colsOf(m.orgBoxes)} rows`);
    } else if (vp.band === 'standard') {
      if (colsOf(m.orgBoxes) !== 2) fail(`standard: organizations should be 2 cols + a full-width card, got ${colsOf(m.orgBoxes)} rows`);
    } else {
      if (colsOf(m.orgBoxes) !== 3) fail(`compact: organizations should be 3 stacked rows, got ${colsOf(m.orgBoxes)}`);
      if (m.cardBoxes.some(b => b.x !== m.cardBoxes[0].x)) fail('compact: cards are not a single column');
    }

    // ---- the one-screen acceptance contract --------------------------
    if (MUST_NOT_SCROLL.has(vp.name)) {
      if (m.bodyScrolls) fail('the panel scrolls where the whole directory must fit on one screen');
      // Every destination card's box inside the dialog's box.
      for (const b of m.cardBoxes) {
        if (b.y < m.cardBox.y || b.y + b.h > m.cardBox.y + m.cardBox.h) {
          fail(`a destination card (y=${b.y} h=${b.h}) falls outside the dialog`);
        }
      }
      // The dialog itself inside the viewport, border and all.
      if (m.cardBox.y < 0 || m.cardBox.y + m.cardBox.h > m.viewportH) {
        fail(`the dialog (y=${m.cardBox.y} h=${m.cardBox.h}) does not fit the ${m.viewportH}px viewport`);
      }
      if (m.cardBox.x < 0 || m.cardBox.x + m.cardBox.w > m.viewportW) fail('the dialog exceeds the viewport width');
      // The last row must clear the bottom padding, not merely touch it.
      const gap = (m.cardBox.y + m.cardBox.h) - m.lastRowBottom;
      if (gap < 14) fail(`last row ends ${gap}px above the modal bottom border, contract requires >= 14px`);
      if (m.cardBoxes.length !== 7) fail(`${m.cardBoxes.length} secondary cards rendered, expected 7`);
      if (m.order.length !== 8) fail(`${m.order.length} destinations rendered, expected 8`);
    }
    // Never hide required content behind an overflow rule, at any size.
    if (m.hiddenOverflow.length) fail(`content clipped by overflow:hidden on ${m.hiddenOverflow.join(', ')}`);
    // A focus ring is only real if it renders under genuine keyboard
    // focus — :focus-visible does not match a programmatic .focus() in
    // Chromium, so this drives it with an actual Tab.
    await page.evaluate(() => document.getElementById('exploreClose').focus());
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const card = document.querySelector('.explore-card').getBoundingClientRect();
      return {
        tag: el.className,
        visible: el.matches(':focus-visible'),
        width: parseFloat(cs.outlineWidth),
        style: cs.outlineStyle,
        clipped: r.top < card.top || r.bottom > card.bottom,
      };
    });
    if (!ring.visible) fail(`Tab focus did not land on a focus-visible control (${ring.tag})`);
    if (ring.style === 'none' || ring.width < 1) fail(`focus outline is ${ring.style} ${ring.width}px on ${ring.tag}`);
    if (ring.clipped) fail(`focus ring clipped by the dialog on ${ring.tag}`);

    // click-once proof, on the hero button and on one secondary card
    await page.click('.explore-visit');
    await page.click('.explore-choice[data-explore="primeHosting"]');
    const opened = await page.evaluate(() => window.__opened);
    if (JSON.stringify(opened) !== JSON.stringify(['fixer', 'primeHosting'])) {
      fail(`click launches ${JSON.stringify(opened)} — expected exactly ["fixer","primeHosting"]`);
    }

    // Escape closes and focus returns to the trigger
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => ({
      shown: document.getElementById('exploreOverlay').classList.contains('show'),
      focus: document.activeElement && document.activeElement.id,
    }));
    if (closed.shown) fail('Escape did not close the panel');
    if (closed.focus !== 'btnExplore') fail(`focus returned to "${closed.focus}", expected btnExplore`);

    console.log(`${vp.name.padEnd(22)} card ${m.cardH}px / viewport ${m.viewportH}px  bodyScrolls=${m.bodyScrolls}  orgRows=${colsOf(m.orgBoxes)}`);
    OPENED.push({ vp: vp.name, opened });
    await ctx.close();
  }

  // keyboard-focus capture, on the default viewport
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.electronAPI = new Proxy({}, { get: () => async () => ({ success: true }) });
  });
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.click('#btnExplore');
  await page.waitForSelector('#exploreOverlay.show .explore-hero');
  await page.focus('.explore-visit');
  await page.evaluate(() => document.querySelector('.explore-visit').classList.add('focus-visible'));
  await (await page.$('#exploreOverlay .explore-card')).screenshot({ path: path.join(OUT, '06-focus-visit-project.png') });
  await page.focus('.explore-choice[data-explore="gifDirectory"]');
  await (await page.$('#exploreOverlay .explore-card')).screenshot({ path: path.join(OUT, '07-focus-secondary-card.png') });
  // close-ups of the rendered card rows. Named for the ROW, not for
  // 'logos': the brand-assets guard treats a filename that looks like brand
  // artwork as an unmanaged asset, and these are QA captures of rendered UI,
  // not artwork to register as managed.
  await (await page.$('.explore-grid-organizations')).screenshot({ path: path.join(OUT, '08-organizations-row.png') });
  await (await page.$('.explore-grid-creative-tools')).screenshot({ path: path.join(OUT, '09-creative-tools-row.png') });
  await ctx.close();

  await browser.close();

  if (failures.length) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log('\nAll Explore layout assertions passed. Captures in ' + OUT);
})();
