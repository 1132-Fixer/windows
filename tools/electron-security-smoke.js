// Smoke test for src/main/electron-security.js — isolation flags, IPC
// allowlist rejects, updater/external URL allowlist, path quoting.
// Imports the REAL module main.js ships with. Exit 0 PASS / 1 FAIL.

'use strict';

const fs = require('fs');
const path = require('path');
const es = require('../src/main/electron-security');

const ROOT = path.join(__dirname, '..');
let failures = 0;
let ipcFake = null;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}

const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

console.log('electron-security-smoke: isolation flags');
{
  const prefs = es.rendererWebPreferences(path.join(ROOT, 'preload.js'));
  check(es.isolationFlagsOk(prefs), 'rendererWebPreferences satisfy isolation contract');
  check(prefs.contextIsolation === true, 'contextIsolation true');
  check(prefs.nodeIntegration === false, 'nodeIntegration false');
  check(prefs.sandbox === true, 'sandbox true');
  check(prefs.webSecurity === true, 'webSecurity true');
  check(prefs.allowRunningInsecureContent === false, 'insecure content denied');
  check(prefs.webviewTag === false, 'webview tag disabled');
  check(prefs.nodeIntegrationInWorker === false, 'no node in workers');
  check(prefs.nodeIntegrationInSubFrames === false, 'no node in subframes');
  check(!es.isolationFlagsOk({ contextIsolation: true, nodeIntegration: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, preload: 'x' }), 'nodeIntegration true is not isolation');
  check(!es.isolationFlagsOk({ contextIsolation: false, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, preload: 'x' }), 'contextIsolation false is not isolation');
  check(mainSrc.includes('electronSecurity.rendererWebPreferences'), 'main.js uses rendererWebPreferences()');
  check(mainSrc.includes('electronSecurity.hardenWebContents'), 'main.js hardens webContents');
  check(mainSrc.includes('electronSecurity.installIpcAllowlist(ipcMain)'), 'main.js installs the IPC allowlist');
}

console.log('electron-security-smoke: IPC allowlist rejects');
{
  const unknown = es.validateInvoke('eval-remote', []);
  check(unknown.ok === false && /not on allowlist/.test(unknown.reason), 'unknown channel invoke rejected');

  const extra = es.validateInvoke('run-fix', ['please-run-cmd.exe', '/c', 'whoami']);
  check(extra.ok === true && extra.args.length === 0, 'zero-arg channel drops extra payload');

  const badType = es.validateInvoke('submit-feedback', ['shell', 'hi']);
  check(badType.ok === false && /type not allowed/.test(badType.reason), 'submit-feedback rejects unknown type');

  const badText = es.validateInvoke('submit-feedback', ['Bug Report', { text: 'nope' }]);
  check(badText.ok === false && /text not a string/.test(badText.reason), 'submit-feedback rejects non-string text');

  const longText = es.validateInvoke('submit-feedback', ['Contact', 'x'.repeat(100 * 1024 + 1)]);
  check(longText.ok === false && /too long/.test(longText.reason), 'submit-feedback rejects oversized text');

  const okFeedback = es.validateInvoke('submit-feedback', ['Bug Report', 'camera is black', undefined]);
  check(okFeedback.ok === true && okFeedback.args[0] === 'Bug Report', 'submit-feedback accepts catalog type');

  const badShot = es.validateInvoke('submit-feedback', ['Bug Report', 'camera is black', { bytes: [1, 2, 3], mediaType: 'application/x-msdownload' }]);
  check(badShot.ok === false && /mediaType/.test(badShot.reason), 'submit-feedback rejects non-image screenshot');

  const okShot = es.validateInvoke('submit-feedback', ['Bug Report', 'camera is black', { bytes: Buffer.alloc(16, 1), mediaType: 'image/png', name: 'ignore-me.exe' }]);
  check(okShot.ok === true && okShot.args[2] && !('name' in okShot.args[2]), 'screenshot extra keys stripped');

  const badCtx = es.validateInvoke('support-report', ['not-an-object']);
  check(badCtx.ok === false, 'support-report rejects non-object context');

  const protoPollute = es.validateInvoke('support-report', [{ receipt: { camera: 'ok', __proto__: { admin: true } } }]);
  check(protoPollute.ok === true, 'support-report accepts a receipt object');

  const registered = [];
  const fake = {
    handle(channel, listener) { registered.push({ channel, listener }); },
  };
  es.installIpcAllowlist(fake);
  let regRejected = false;
  try {
    fake.handle('arbitrary-cmd', async () => {});
  } catch (err) {
    regRejected = /not on allowlist/.test(err.message);
  }
  check(regRejected, 'ipcMain.handle rejects a channel not on the allowlist');
  ipcFake = { fake, registered };
}

console.log('electron-security-smoke: preload and main stay on the allowlist');
{
  const invokeRe = /ipcRenderer\.invoke\('([^']+)'/g;
  const preloadInvokes = [];
  let m;
  while ((m = invokeRe.exec(preloadSrc))) preloadInvokes.push(m[1]);
  const handleRe = /ipcMain\.handle\('([^']+)'/g;
  const mainHandles = [];
  while ((m = handleRe.exec(mainSrc))) mainHandles.push(m[1]);
  const allow = new Set(es.IPC_INVOKE_CHANNELS);

  check(preloadInvokes.length > 0, 'preload declares invoke channels');
  check(mainHandles.length === allow.size, `main registers ${allow.size} allowlisted handlers`);
  check(preloadInvokes.every((ch) => allow.has(ch)), 'every preload invoke is allowlisted');
  check(mainHandles.every((ch) => allow.has(ch)), 'every ipcMain.handle is allowlisted');
  check([...allow].every((ch) => mainHandles.includes(ch)), 'every allowlisted channel is registered in main');
  check([...new Set(preloadInvokes)].every((ch) => mainHandles.includes(ch)), 'preload invokes match main handlers');

  const sendRe = /ipcRenderer\.on\('([^']+)'/g;
  const preloadSends = [];
  while ((m = sendRe.exec(preloadSrc))) preloadSends.push(m[1]);
  check(preloadSends.every((ch) => es.IPC_SEND_CHANNELS.includes(ch)), 'preload listeners are documented send channels');
}

console.log('electron-security-smoke: Explore destinations (directive 2026-08-23)');
{
  // Renderer sends KEYS; main owns the URL map. Exactly these seven
  // destinations, each pinned to its exact URL.
  const WANT = {
    fixer: 'https://1132-fixer.xyz/',
    botify: 'https://botify-network.com/',
    gifDirectory: 'https://gif.directory/',
    kickbot: 'https://botify-network.com/apps/botifykickbot',
    modbot: 'https://botify-network.com/apps/botifymodbot',
    emojiGenerator: 'https://botify-network.com/apps/emoji-generator-bot',
    makeItGif: 'https://botify-network.com/apps/makeitgif',
  };
  check(Object.keys(es.EXPLORE_DESTINATIONS).sort().join(',') === Object.keys(WANT).sort().join(','),
    'exactly the seven approved destination keys');
  for (const [key, url] of Object.entries(WANT)) {
    check(es.exploreDestinationUrl(key) === url, `${key} resolves only to ${url}`);
  }
  // Every mapped URL must itself pass the external allowlist — the map can
  // never become a bypass.
  check(Object.values(es.EXPLORE_DESTINATIONS).every(u => es.isAllowedExternalUrl(u)),
    'every destination URL passes the external allowlist');
  // Unknown keys, URL-shaped values, and arbitrary approved-host PATHS are
  // rejected at the map…
  for (const bad of ['github', '', null, undefined, 42, 'https://evil.example/',
                     'https://botify-network.com/apps/not-approved', '/apps/botifykickbot',
                     '__proto__', 'toString']) {
    check(es.exploreDestinationUrl(bad) === null, `destination ${JSON.stringify(bad)} rejected`);
  }
  // …and at the IPC schema layer, so the handler never sees them.
  for (const key of Object.keys(WANT)) {
    check(es.validateInvoke('open-explore-destination', [key]).ok === true, `schema accepts ${key}`);
  }
  check(es.validateInvoke('open-explore-destination', ['https://evil.example/']).ok === false,
    'schema rejects a renderer-supplied URL');
  check(es.validateInvoke('open-explore-destination', ['https://botify-network.com/apps/other']).ok === false,
    'schema rejects a renderer-supplied Botify path');
  check(es.validateInvoke('open-explore-destination', ['unknown-key']).ok === false, 'schema rejects unknown keys');
  check(es.validateInvoke('open-explore-destination', []).ok === false, 'schema rejects a missing key');
  // The old arbitrary-free but redundant channel is gone — no dead IPC.
  check(!es.IPC_INVOKE_CHANNELS.includes('open-website'), 'open-website channel removed');
  check(!preloadSrc.includes('open-website') && !mainSrc.includes("ipcMain.handle('open-website'"),
    'no dead open-website path in preload or main');
  check(mainSrc.includes('exploreDestinationUrl'), 'main resolves keys through the trusted map');

  // Footer + modal UI contract. The launcher panel is data-driven: the
  // EXPLORE_VIEW catalog (messages.js) is the single source of display
  // data, so the drift guard runs view-catalog ↔ security-map, and the
  // runtime look is covered by ui-state-capture's explore state.
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  const messages = require('../messages.js');
  check(indexSrc.includes('id="btnExplore"') && />Explore</.test(indexSrc), 'footer Explore control present');
  check(!indexSrc.includes('Visit Website'), 'Visit Website footer label gone');
  check(/id="exploreOverlay"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="exploreTitle"/.test(indexSrc.replace(/\s+/g, ' ')),
    'explore modal is a labelled aria-modal dialog');
  const viewKeys = messages.EXPLORE_VIEW.map(d => d.key).sort();
  check(viewKeys.join(',') === Object.keys(es.EXPLORE_DESTINATIONS).sort().join(','),
    'EXPLORE_VIEW catalog carries exactly the approved destination keys');
  const viewNames = messages.EXPLORE_VIEW.map(d => d.name);
  for (const name of ['1132 Fixer', 'Botify Network', 'BotifyKickBot', 'BotifyModBot',
                      'Emoji Generator Bot', 'Make It GIF', 'GIF Directory']) {
    check(viewNames.includes(name), `catalog names destination "${name}"`);
  }
  check(messages.EXPLORE_VIEW.filter(d => d.featured).map(d => d.key).join(',') === 'fixer',
    '1132 Fixer is the single featured destination');
  // Logo assets: repo paths only — production code must never reference
  // the user's Downloads directory — and every named asset must exist.
  check(messages.EXPLORE_VIEW.every(d => d.logo === null || d.logo.startsWith('assets/explore/')),
    'logo paths live under assets/explore/');
  check(messages.EXPLORE_VIEW.every(d => d.logo === null || fs.existsSync(path.join(ROOT, d.logo))),
    'every referenced logo asset exists');
  const allUiSrc = indexSrc + rendererSrc + mainSrc + preloadSrc;
  check(!/Downloads[\\/]/.test(allUiSrc), 'no runtime dependency on the Downloads directory');
  check(indexSrc.includes('id="exploreClose"'), 'modal has a close affordance');
  check(rendererSrc.includes('openExploreDestination(btn.dataset.explore)') &&
        rendererSrc.includes(".explore-choice[data-explore]"),
    'renderer sends only the fixed data-explore keys');
  check(!/openExploreDestination\((?!btn\.dataset\.explore|key\b)/.test(rendererSrc),
    'renderer never passes a computed/arbitrary destination');
  check(/exploreOverlay\.addEventListener\('keydown'/.test(rendererSrc) && /Escape/.test(rendererSrc),
    'Escape closes the modal');
  check(/releaseExploreTrap = installFocusTrap\(exploreOverlay\)/.test(rendererSrc),
    'focus is trapped and restored to the Explore button on close');

  // Project disclosure (addendum): rendered into shell + Explore from the
  // single DISCLOSURE catalog; no unsupported Zoom-endorsement wording in
  // any UI source.
  check(indexSrc.includes('id="projectDisclosure"') && indexSrc.includes('id="exploreDisclosure"'),
    'disclosure instances exist in shell and Explore');
  check(rendererSrc.includes('renderDisclosure(document.getElementById(\'projectDisclosure\'))') &&
        rendererSrc.includes('renderDisclosure(document.getElementById(\'exploreDisclosure\'))'),
    'both disclosure instances are filled from the DISCLOSURE catalog');
  check(messages.DISCLOSURE.INDEPENDENCE === 'Independent project — not affiliated with Zoom.',
    'shell ships the exact independence wording');
  for (const banned of ['Verified by Zoom', 'Zoom Certified', 'Zoom Partner', 'Official Zoom']) {
    check(!allUiSrc.includes(banned), `UI never says "${banned}"`);
  }
}

console.log('electron-security-smoke: updater URL is not arbitrary');
{
  const goodFeed = 'https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml';
  const goodCdn = 'https://release-assets.githubusercontent.com/1234/latest.yml';
  check(es.isAllowedUpdaterUrl(goodFeed), 'canonical latest.yml allowed');
  check(es.isAllowedUpdaterUrl(goodCdn), 'GitHub release CDN allowed');
  check(!es.isAllowedUpdaterUrl('https://evil.example/latest.yml'), 'arbitrary https host rejected');
  check(!es.isAllowedUpdaterUrl('http://github.com/1132-Fixer/windows/releases/latest/download/latest.yml'), 'http updater URL rejected');
  check(!es.isAllowedUpdaterUrl('https://github.com.evil.example/latest.yml'), 'suffix host rejected');
  check(!es.isAllowedUpdaterUrl('https://github.com/evil/repo/releases/latest/download/latest.yml'), 'other GitHub repo rejected');
  check(!es.isAllowedUpdaterUrl('javascript:alert(1)'), 'javascript: rejected');
  check(!es.isAllowedUpdaterUrl('file:///C:/evil.yml'), 'file: rejected');
  check(!es.isAllowedUpdaterUrl('https://user:pass@github.com/1132-Fixer/windows/releases/latest/download/latest.yml'), 'embedded credentials rejected');
  check(!es.isAllowedUpdaterUrl('https://objects.githubusercontent.com.evil.example/x'), 'CDN suffix host rejected');
  check(mainSrc.includes('isAllowedUpdaterUrl'), 'httpsGetText consults the updater allowlist');
  check(mainSrc.includes("const LATEST_YML_URL = 'https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml'"), 'portable feed URL is the named GitHub latest.yml');
  check(pkg.build && pkg.build.win && pkg.build.win.verifyUpdateCodeSignature === false, 'verifyUpdateCodeSignature remains false while unsigned');
  check(!/autoUpdater\.setFeedURL/.test(mainSrc), 'renderer cannot steer setFeedURL — it is never called');
}

console.log('electron-security-smoke: openExternal and navigation');
{
  check(es.isAllowedExternalUrl('https://github.com/1132-Fixer/windows/releases/latest'), 'releases page allowed');
  check(es.isAllowedExternalUrl('https://1132-fixer.xyz/'), 'product site allowed');
  check(es.isAllowedExternalUrl('https://www.1132-fixer.xyz/'), 'product site www allowed');
  check(es.isAllowedExternalUrl('https://botify-network.com/'), 'Botify Network site allowed');
  check(es.isAllowedExternalUrl('https://www.botify-network.com/'), 'Botify Network www allowed');
  check(!es.isAllowedExternalUrl('http://1132-fixer.xyz/'), 'http product site rejected');
  check(!es.isAllowedExternalUrl('http://botify-network.com/'), 'http Botify site rejected');
  check(!es.isAllowedExternalUrl('https://evil.botify-network.com/'), 'unapproved Botify subdomain rejected');
  check(!es.isAllowedExternalUrl('https://botify-network.com.evil.example/'), 'Botify suffix host rejected');
  check(es.isAllowedExternalUrl('https://zoom.us/download/admin'), 'Zoom admin download allowed');
  check(!es.isAllowedExternalUrl('https://example.com/'), 'arbitrary site rejected');
  check(!es.isAllowedExternalUrl('https://zoom.us.evil.example/download'), 'Zoom suffix host rejected');

  const appRoot = path.join(ROOT, 'app-root');
  const indexPath = path.join(appRoot, 'index.html');
  const indexUrl = 'file:///' + indexPath.replace(/\\/g, '/');
  check(es.isAllowedRendererNavigation(indexUrl, appRoot), 'file: index.html under app root allowed');
  check(!es.isAllowedRendererNavigation('https://evil.example/', appRoot), 'https navigation rejected');
  check(!es.isAllowedRendererNavigation('file:///C:/Windows/System32/cmd.exe', appRoot), 'file: exe navigation rejected');
  const escapeUrl = 'file:///' + path.join(appRoot, '..', 'index.html').replace(/\\/g, '/');
  check(!es.isAllowedRendererNavigation(escapeUrl, appRoot), 'path escape via .. rejected');

  const events = [];
  const fakeWc = {
    setWindowOpenHandler(fn) { events.push(['open', fn({ url: 'https://evil.example' })]); },
    on(name, fn) {
      events.push(['on', name]);
      if (name === 'will-navigate') {
        const ev = { prevented: false, preventDefault() { this.prevented = true; } };
        fn(ev, 'https://evil.example/');
        events.push(['nav-prevented', ev.prevented]);
      }
    },
    session: {
      setPermissionRequestHandler(fn) {
        fn(null, 'openExternal', (allow) => events.push(['perm', allow]));
      },
    },
  };
  es.hardenWebContents(fakeWc, { appRoot });
  check(events.some((e) => e[0] === 'open' && e[1] && e[1].action === 'deny'), 'window.open denied');
  check(events.some((e) => e[0] === 'nav-prevented' && e[1] === true), 'will-navigate preventDefault on https');
  check(events.some((e) => e[0] === 'perm' && e[1] === false), 'permission requests denied');
}

console.log('electron-security-smoke: path validation and PS quoting');
{
  const msi = es.isSafeUserSelectedPath('C:\\Users\\Public\\ZoomInstallerFull.msi', { ext: '.msi' });
  check(msi.ok === true, 'dialog MSI path accepted');
  check(es.isSafeUserSelectedPath('C:\\Users\\Public\\ZoomInstallerFull.msi', { ext: '.exe' }).ok === false, 'exe rejected when msi required');
  check(es.isSafeUserSelectedPath('C:\\Users\\Public\\ZoomInstallerFull.msi:evil', { ext: '.msi' }).ok === false, 'NTFS ADS basename rejected');
  check(es.isSafeUserSelectedPath('C:\\Users\\Public\\Zoom\nInstaller.msi', { ext: '.msi' }).ok === false, 'newline in path rejected');
  const quoted = es.psSingleQuote("C:\\Users\\O'Brien\\Zoom.msi");
  check(quoted.ok && quoted.literal === "'C:\\Users\\O''Brien\\Zoom.msi'", 'PS single-quote doubles apostrophes');
  check(es.psSingleQuote('C:\\Users\\x\ny').ok === false, 'PS quote rejects control characters');
  check(mainSrc.includes('isSafeUserSelectedPath'), 'zoom installer path goes through isSafeUserSelectedPath');
}

(async () => {
  if (ipcFake) {
    const { fake, registered } = ipcFake;
    fake.handle('get-version', async () => '5.6.0');
    const wrapped = registered.find((r) => r.channel === 'get-version').listener;
    try {
      const v = await wrapped({}, 'C:\\Windows\\System32\\cmd.exe');
      check(v === '5.6.0', 'allowed zero-arg invoke still runs');
    } catch (err) {
      check(false, `allowed invoke threw: ${err && err.message}`);
    }
    fake.handle('submit-feedback', async () => ({ success: true }));
    const fb = registered.find((r) => r.channel === 'submit-feedback').listener;
    try {
      await fb({}, 'powershell', 'Get-Process');
      check(false, 'invalid submit-feedback should reject');
    } catch (err) {
      check(/IPC invoke rejected/.test(err.message), 'invalid submit-feedback invoke throws');
    }
  }

  const blocked = await es.openExternalSafe(async () => { throw new Error('should not open'); }, 'https://evil.example/');
  check(blocked.success === false && blocked.reason === 'url not allowed', 'openExternalSafe blocks arbitrary URL');
  let opened = '';
  const allowed = await es.openExternalSafe(async (u) => { opened = u; }, 'https://1132-fixer.xyz/');
  check(allowed.success === true && opened === 'https://1132-fixer.xyz/', 'openExternalSafe allows catalog URL');

  if (failures) {
    console.error(`\nelectron-security-smoke: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('\nelectron-security-smoke: PASS');
})().catch((err) => {
  console.error('electron-security-smoke: threw', err);
  process.exit(1);
});
