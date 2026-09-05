'use strict';

/**
 * Hard brand-logo and placement contract.
 *
 * Canonical roles (from .brand-assets.tsv + index.html + compact-shell):
 *   assets/brand/app-mark.png              — main product / header mark
 *   assets/1132-fixer-logo-transparent.png — managed full logo
 *   assets/logo-transparent.png            — managed full-logo export
 *   assets/icon.ico / assets/icon.png      — app / installer / Start menu
 *   assets/1132-helper-shortcut.png|.ico   — helper-account shortcut only
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PRODUCT_MARK = 'assets/brand/app-mark.png';
const HELPER_PNG = 'assets/1132-helper-shortcut.png';
const HELPER_ICO = 'assets/1132-helper-shortcut.ico';

function sha256(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'compact-shell.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(ROOT, '.brand-assets.tsv'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'messages.js'), 'utf8');
const profileSafety = fs.readFileSync(path.join(ROOT, 'profile-safety.js'), 'utf8');

console.log('brand-placement-smoke: canonical files exist');
for (const rel of [
  PRODUCT_MARK,
  'assets/icon.ico',
  'assets/icon.png',
  'assets/logo-transparent.png',
  'assets/1132-fixer-logo-transparent.png',
  HELPER_PNG,
  HELPER_ICO,
  'assets/brand/open-source-badge.png'
]) {
  check(fs.existsSync(path.join(ROOT, rel)), `tracked ${rel}`);
}

console.log('brand-placement-smoke: manifest maps the product mark');
check(manifest.includes('assets/exports/windows/app-mark.png\t' + PRODUCT_MARK),
  'brand-assets.tsv ships app-mark.png as the product mark');
check(manifest.includes('assets/exports/windows/1132-helper-shortcut.png\t' + HELPER_PNG),
  'brand-assets.tsv keeps helper PNG on the helper shortcut');
check(manifest.includes('assets/exports/windows/icon.ico\tassets/icon.ico'),
  'brand-assets.tsv keeps application icon.ico');

const productHash = sha256(PRODUCT_MARK);
const helperHash = sha256(HELPER_PNG);
const iconHash = sha256('assets/icon.ico');
check(productHash !== helperHash, 'product mark is not the helper-shortcut image');
check(productHash.length === 64, 'product mark hash is sha256');
console.log(`  hash  ${PRODUCT_MARK} ${productHash}`);
console.log(`  hash  ${HELPER_PNG} ${helperHash}`);
console.log(`  hash  assets/icon.ico ${iconHash}`);

console.log('brand-placement-smoke: main header references the product mark');
check(/<img class="app-mark" src="assets\/brand\/app-mark\.png" alt="1132 Fixer">/.test(html),
  'index.html header img is the canonical gear');
check(/\.app-mark\s*\{[\s\S]*?left:\s*50%;[\s\S]*?transform:\s*translate\(-50%,\s*-50%\);[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;[\s\S]*?object-fit:\s*contain;/.test(html),
  'index.html centers a 44px contain-fit mark in the header');
check(!/header[\s\S]{0,800}1132-helper-shortcut/.test(html),
  'index.html header block does not reference the helper icon');

console.log('brand-placement-smoke: the mark lives in the static app header');
check(!shell.includes('btnExplore') && !html.includes('class="footer"'),
  'Explore is not footer chrome (it lives only in the About dialog)');
const explorePos = html.indexOf('id="btnExplore"');
check(explorePos > html.indexOf('id="aboutOverlay"') && explorePos < html.indexOf('id="fixConfirmOverlay"'),
  'Explore control is inside the About dialog');
check(shell.includes("appMark.src = 'assets/brand/app-mark.png'"),
  'compact shell locks the header mark to app-mark.png');
check(/<header class="app-header"[\s\S]*?<img class="app-mark" src="assets\/brand\/app-mark\.png" alt="1132 Fixer">[\s\S]*?<\/header>/.test(html),
  'index.html places the mark inside the static app header');
check(!shell.includes('compact-brand-slot') && !shell.includes('topbar'),
  'compact shell builds no header and moves the mark nowhere');
check(/\.app-mark\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*50%;[\s\S]*?transform:\s*translate\(-50%,\s*-50%\);/.test(html),
  'header mark is horizontally window-centered against the full width');
check(!/app-mark[^}]*display:\s*none/.test(shell) && !/data-compact-state="[a-z]+"[^}]*\.app-mark/.test(shell),
  'no state restyles or hides the product mark');
check(/grid-template-columns:\s*1fr auto 1fr/.test(html),
  'header sides are symmetric so Back and Exit cannot shift the mark');

console.log('brand-placement-smoke: helper icon stays on the helper shortcut');
check(html.includes(`src="${HELPER_PNG}"`) && html.includes('id="shortcutBtn"'),
  'helper PNG is used on the Create desktop shortcut control');
check(profileSafety.includes("PRIMARY_SHORTCUT_ICON = '1132-helper-shortcut.ico'"),
  'helper ICO is the desktop-shortcut resource');
check(pkg.build && pkg.build.win && pkg.build.win.icon === 'assets/icon.ico',
  'Windows executable icon remains assets/icon.ico');
check(pkg.build.nsis && pkg.build.nsis.installerIcon === 'assets/icon.ico',
  'installer icon remains assets/icon.ico');
check(!shell.includes('1132-helper-shortcut'),
  'compact shell never loads the helper-shortcut artwork');

console.log('brand-placement-smoke: Explore does not replace the header mark');
check(
  messages.includes("icon: 'assets/logo-transparent.png'") ||
  messages.includes("logo: 'assets/explore/fixer.png'") ||
  messages.includes("icon: 'assets/explore/fixer.png'"),
  'Explore featured card uses a managed 1132 Fixer logo export'
);
check(!messages.includes("icon: 'assets/brand/app-mark.png'") && !messages.includes("logo: 'assets/brand/app-mark.png'"),
  'Explore catalog does not reuse the header product-mark path');
check(!/helper-shortcut/.test(messages),
  'Explore catalog does not use the helper-shortcut icon');

console.log('brand-placement-smoke: no Zoom-owned branding in tracked assets');
const assetWalk = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else assetWalk.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
}
walk(path.join(ROOT, 'assets'));
const zoomNamed = assetWalk.filter((p) => /(^|\/)(zoom[-_.]|zoomworkplace|zoom\.exe)/i.test(p));
check(zoomNamed.length === 0, 'no Zoom-named files under assets/');
check(!/src=["'][^"']*zoom[^"']*\.(png|ico|svg|jpg|jpeg|webp)["']/i.test(html + shell),
  'header and compact shell do not load a Zoom image as branding');
check(!/\bzoom[-_.]?(logo|icon|mark)\b/i.test(html + shell),
  'header and compact shell do not name a Zoom logo asset');

console.log('brand-placement-smoke: exactly one header product mark in compact shell');
check((html.match(/class="app-mark"/g) || []).length === 1,
  'index.html defines a single .app-mark element');
check((html.match(/<img class="app-mark"/g) || []).length === 1 && !shell.includes('appendChild(appMark)'),
  'the single mark is static markup; the shell never appends a second one');

console.log('brand-placement-smoke: closing Explore closes About too');
{
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  const body = renderer.slice(renderer.indexOf('function closeExplore()'), renderer.indexOf('async function openExploreDestination'));
  check(body.includes('aboutOverlay.hidden = true'), 'closeExplore hides the About dialog instead of restoring it');
  check(!body.includes('aboutOverlay.hidden = false'), 'closeExplore never re-shows About');
  check(body.includes("getElementById('aboutBtn')"), 'focus returns to the footer About control');
}

console.log('brand-placement-smoke: header side controls do not sit under the mark');
// The mark is absolutely positioned, so it is not a grid item. Without
// explicit columns the right side auto-placed into the middle (auto) column
// and Exit rendered underneath the mark (6.3.3).
check(/\.app-header-left\s*\{[^}]*grid-column:\s*1/.test(html), 'left header side is pinned to column 1');
check(/\.app-header-right\s*\{[^}]*grid-column:\s*3/.test(html), 'right header side (Exit) is pinned to column 3');

if (failures) {
  console.error(`brand-placement-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('brand-placement-smoke: all checks passed');
console.log(`brand-placement-smoke: product-mark-sha256=${productHash}`);
