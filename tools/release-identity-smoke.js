// Release-identity & migration guardrails (static; no network).
//
// Locks the invariants that a repository/release migration must never break:
//   1. Canonical project/home/source/support URLs point at 1132-Fixer/windows.
//   2. Application identity is frozen — appId, updater cache dir, artifact
//      naming, product/publisher name. Changing any of these makes Windows
//      treat an update as a SECOND app (side-by-side install), which is the
//      exact failure this migration must avoid.
//   3. The current updater channel is github/1132-Fixer/windows and stays
//      unsigned-compatible (verifyUpdateCodeSignature false).
//   4. The legacy compatibility bridge is still wired: the code and docs must
//      keep referencing PrimeUpYourLife/1132-Fixer-Windows-Releases so a future
//      edit cannot silently drop the feed that <=5.5.1 clients still poll.
//
// Exit 0 PASS / 1 FAIL.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Frozen identity. These values are a contract with every installed client.
const FROZEN = {
  appId: 'com.hightexas.1132fixer',
  productName: '1132 Fixer',
  updaterCacheDirName: '1132-fixer-updater',
  setupArtifact: '1132-Fixer-Setup-${version}.${ext}',
  portableArtifact: '1132-Fixer-Portable-${version}.${ext}',
  publisherName: 'High Texas',
};
const CANONICAL = '1132-Fixer/windows';
const LEGACY_FEED_REPO = 'PrimeUpYourLife/1132-Fixer-Windows-Releases';

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); } else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('release-identity-smoke: canonical project URLs');
check((pkg.repository && pkg.repository.url || '').includes(`github.com/${CANONICAL}`), `repository.url is ${CANONICAL}`);
check((pkg.bugs && pkg.bugs.url || '').includes(`github.com/${CANONICAL}`), `bugs.url is ${CANONICAL}`);
check((pkg.homepage || '').includes(`github.com/${CANONICAL}`), `homepage is ${CANONICAL}`);

console.log('release-identity-smoke: frozen application identity');
const b = pkg.build || {};
check(b.appId === FROZEN.appId, `appId is ${FROZEN.appId}`);
check(b.productName === FROZEN.productName, `productName is "${FROZEN.productName}"`);
check(b.nsis && b.nsis.artifactName === FROZEN.setupArtifact, `nsis installer artifactName is ${FROZEN.setupArtifact}`);
check(b.nsis && b.nsis.uninstallDisplayName === FROZEN.productName, `nsis uninstallDisplayName is "${FROZEN.productName}"`);
check(b.nsis && b.nsis.perMachine === true, 'nsis perMachine stays true (per-machine uninstall identity)');
check(b.nsis && b.nsis.runAfterFinish === false, 'nsis runAfterFinish is false (Setup does not auto-launch)');
check(!fs.existsSync(path.join(ROOT, 'build', 'installer.nsi')),
  'no custom installer.nsi (electron-builder skips uninstaller generation when one is present)');
{
  const afterPack = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack-verify-manifest.js'), 'utf8');
  check(afterPack.includes('CopyElevateHelper') && afterPack.includes('elevate.exe'),
    'afterPack strips elevate.exe after NSIS copy');
  check(afterPack.includes('__uninstaller.exe'),
    'afterPack stamps the generated NSIS uninstaller requireAdministrator');
  const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  check(nsh.includes('Delete "$INSTDIR\\resources\\elevate.exe"'),
    'customInstall still deletes elevate.exe if copy-strip misses');
  const allow = fs.readFileSync(path.join(ROOT, 'build', 'package-allowlist.json'), 'utf8');
  check(!allow.includes('elevate.exe'), 'package allowlist does not permit elevate.exe');
}
check(b.portable && b.portable.artifactName === FROZEN.portableArtifact, `portable artifactName is ${FROZEN.portableArtifact}`);
check(b.win && b.win.signtoolOptions && b.win.signtoolOptions.publisherName === FROZEN.publisherName, `publisherName is "${FROZEN.publisherName}"`);

// updaterCacheDirName is not set explicitly — electron-builder derives it as
// `${package.name}-updater` and writes it into the shipped app-update.yml. The
// value baked into 5.5.1 is `1132-fixer-updater`, so the frozen invariant is
// the package `name`: change it and every installed client's on-disk updater
// cache path (%LOCALAPPDATA%\<name>-updater) moves, breaking update continuity.
check(pkg.name === '1132-fixer', `package name is "1132-fixer" (derives updaterCacheDirName ${FROZEN.updaterCacheDirName})`);

console.log('release-identity-smoke: current channel + signing posture');
check(b.publish && b.publish.provider === 'github' && b.publish.owner === '1132-Fixer' && b.publish.repo === 'windows', 'build.publish is github/1132-Fixer/windows (current channel)');
check(b.win && b.win.verifyUpdateCodeSignature === false, 'verifyUpdateCodeSignature stays false (installed clients accept unsigned updates)');

console.log('release-identity-smoke: legacy compatibility bridge is still wired');
const smoke = fs.readFileSync(path.join(ROOT, 'tools', 'updater-channel-smoke.js'), 'utf8');
check(smoke.includes(LEGACY_FEED_REPO), `updater-channel-smoke still references the legacy feed ${LEGACY_FEED_REPO}`);
const migDoc = path.join(ROOT, 'docs', 'history', 'release-migration-2026-08.md');
const mig = fs.existsSync(migDoc) ? fs.readFileSync(migDoc, 'utf8') : '';
check(mig.includes(LEGACY_FEED_REPO) && /compatibility bridge/i.test(mig), 'migration doc documents the legacy compatibility bridge');
check(!/migrate by manual reinstall|manually reinstall/i.test(mig) || /not an acceptable|no longer policy|not acceptable/i.test(mig), 'migration doc does not present manual reinstall as the migration strategy');
// Pinned-transition policy: the doc must describe v6.0.0 as a one-time pinned
// transition and must NOT claim every future release is mirrored to the legacy
// feed (release.yml does not do that). Keeps code and docs in agreement.
check(/pinned/i.test(mig) && mig.includes('6.0.0') && /not[^.]*mirror|one-time|do not mirror/i.test(mig), 'migration doc describes v6.0.0 as a one-time pinned transition (not an every-release mirror)');
const relYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
check(!relYml.includes(LEGACY_FEED_REPO), 'release.yml does not publish to the legacy feed (docs must not claim it does)');
// checksums-sha256.txt must be written LF / no BOM so `sha256sum -c` accepts
// it. Out-File writes CRLF on Windows; 6.3.3 shipped that way.
check(!/checksums-sha256\.txt[^\n]*\n?[^\n]*Out-File/.test(relYml) && !/Out-File[^\n]*checksums-sha256\.txt/.test(relYml),
  'release.yml does not write checksums-sha256.txt with Out-File (CRLF)');
check(/WriteAllText\([^\n]*checksums-sha256\.txt[^\n]*UTF8Encoding\]::new\(\$false\)/.test(relYml),
  'release.yml writes checksums-sha256.txt as LF UTF-8 without BOM');
const validator = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-release-assets.mjs'), 'utf8');
check(validator.includes("text.includes('\\r')") && validator.includes('checksums-sha256.txt uses CRLF'),
  'validate-release-assets.mjs rejects a CRLF checksums file on the published release');

if (failures) { console.error(`release-identity-smoke: ${failures} FAIL`); process.exit(1); }
console.log('release-identity-smoke: PASS');
