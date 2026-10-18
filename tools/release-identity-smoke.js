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
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

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
  check(afterPack.includes('guardUninstaller') && !afterPack.includes('installUninstallerStamp'),
    'afterPack never edits the generated NSIS uninstaller (re-stamping breaks its integrity check, exit 2)');
  const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  check(/customInit[\s\S]*DisplayVersion[\s\S]*"6\.3\.1"[\s\S]*"6\.3\.3"[\s\S]*DeleteRegValue HKLM "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/.test(nsh),
    'customInit skips the corrupt 6.3.1-6.3.3 uninstaller so the update can apply over it');
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
check(relYml.includes('node scripts/release-candidate.mjs --verify') &&
  relYml.includes('node scripts/generate-checksums.mjs --verify --dist dist') &&
  !relYml.includes('node scripts/generate-checksums.mjs --dist dist\n'),
  'release.yml preserves and verifies the accepted candidate checksum manifest instead of regenerating it');
const validator = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-release-assets.mjs'), 'utf8');
check(validator.includes("text.includes('\\r')") && validator.includes('checksums-sha256.txt uses CRLF'),
  'validate-release-assets.mjs rejects a CRLF checksums file on the published release');

console.log('release-identity-smoke: blocking dependency audit');
const securityYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'security.yml'), 'utf8');
const auditStart = securityYml.indexOf('  npm-audit:');
const auditEnd = securityYml.indexOf('  license-and-binaries:', auditStart);
const auditJob = auditStart >= 0 && auditEnd > auditStart ? securityYml.slice(auditStart, auditEnd) : '';
check(auditJob.includes('run: npm audit --audit-level=high'),
  'Security workflow runs the high-severity dependency audit');
check(auditJob.length > 0 && !auditJob.includes('continue-on-error'),
  'dependency audit failure fails the Security job');
const undiciVersion = String(lock.packages && lock.packages['node_modules/undici'] &&
  lock.packages['node_modules/undici'].version || '');
const undiciParts = undiciVersion.split('.').map(part => Number.parseInt(part, 10));
const undiciFixed = undiciParts.length === 3 && undiciParts.every(Number.isInteger) &&
  (undiciParts[0] > 7 || (undiciParts[0] === 7 &&
    (undiciParts[1] > 29 || (undiciParts[1] === 29 && undiciParts[2] >= 1))));
check(undiciFixed, `top-level undici lock is at or above fixed version 7.29.1 (found ${undiciVersion || 'missing'})`);

console.log('release-identity-smoke: workflow authority and bounded execution');
const ciYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const brandYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'brand.yml'), 'utf8');
const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: ROOT, encoding: 'utf8', timeout: 10000
});
const trackedTextFiles = tracked.status === 0
  ? tracked.stdout.split('\0').filter(Boolean)
    .filter(file => /\.(?:c?js|mjs|ts|tsx|ps1|ya?ml|md)$/i.test(file))
    .filter(file => !/^docs\/(?:history|evidence)\//i.test(file))
  : [];
const uacWord = ['U', 'AC'].join('');
const disabledWord = ['dis', 'abled'].join('');
const unsupportedUacInference = new RegExp(`\\b${uacWord}\\s+(?:is\\s+)?${disabledWord}\\b`, 'i');
const unsupportedUacFiles = trackedTextFiles.filter(file =>
  unsupportedUacInference.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
check(tracked.status === 0 && trackedTextFiles.length > 0 && unsupportedUacFiles.length === 0,
  'tracked source, workflow and documentation text makes no unsupported UAC-state inference');
const workflows = Object.fromEntries(fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
  .filter(file => /\.ya?ml$/i.test(file))
  .map(file => [file, fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8')]));
const uses = Object.entries(workflows).flatMap(([file, source]) => source.split(/\r?\n/)
  .filter(line => /^\s*-?\s*uses:\s*/.test(line))
  .map(line => ({ file, line: line.trim() })));
check(uses.length > 0 && uses.every(item => /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@[a-f0-9]{40}(?:\s+#\s*\S+)?$/.test(item.line)),
  'every external workflow action is pinned to a verified full commit SHA');
const checkoutCount = uses.filter(item => item.line.includes('actions/checkout@')).length;
const persistedCredentialGuards = Object.values(workflows)
  .reduce((count, source) => count + (source.match(/persist-credentials:\s*false/g) || []).length, 0);
check(checkoutCount === persistedCredentialGuards,
  'every checkout removes persisted GitHub credentials');
for (const [file, source] of Object.entries(workflows)) {
  const jobs = (source.match(/^\s{4}runs-on:/gm) || []).length;
  const timeouts = (source.match(/^\s{4}timeout-minutes:/gm) || []).length;
  check(jobs > 0 && jobs === timeouts, `${file} gives every job an explicit timeout`);
}
check(ciYml.includes('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}') &&
  securityYml.includes('group: security-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}') &&
  brandYml.includes('group: brand-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}'),
'pull-request workflows cancel only superseded work in their own stable groups');
const securityHeader = securityYml.slice(0, securityYml.indexOf('\njobs:'));
check(!securityHeader.includes('security-events: write') &&
  (securityYml.match(/security-events:\s*write/g) || []).length === 1 &&
  securityYml.slice(securityYml.indexOf('  codeql:')).includes('security-events: write'),
'security-events write permission is scoped to the CodeQL job');
check(!/uses:\s*actions\/upload-artifact@[\s\S]{0,100}continue-on-error:\s*true/.test(Object.values(workflows).join('\n')),
  'artifact upload failures remain visible in CI and release results');
check(ciYml.includes('Check tracked JavaScript syntax') && !ciYml.includes('Advisory only') &&
  !/name:\s*Code Quality[\s\S]*continue-on-error:\s*true/.test(ciYml),
'Code Quality performs enforcing static syntax validation instead of a suppressed audit');

const preflightJob = relYml.slice(relYml.indexOf('  preflight:'), relYml.indexOf('  publish:'));
const publishJob = relYml.slice(relYml.indexOf('  publish:'));
check(preflightJob.includes('actions: read') && preflightJob.includes('checks: read') &&
  preflightJob.includes('contents: read') && preflightJob.includes('pull-requests: read') &&
  !preflightJob.includes('contents: write'),
'tag authorization has read-only repository permissions');
check(publishJob.includes('needs: preflight') && publishJob.includes('contents: write') &&
  relYml.includes('node scripts/release-preflight.mjs') && relYml.includes('node scripts/publish-release.mjs'),
'the sole write-capable release job is downstream of the fail-closed preflight');
check(relYml.includes('NATIVE_ACCEPTANCE_ARTIFACT_ID') &&
  relYml.includes('SUPPORT_CLEARANCE_ARTIFACT_ID') &&
  !relYml.includes('NATIVE_ACCEPTANCE_MANIFEST') &&
  !relYml.includes('SUPPORT_RELEASE_CLEARANCE'),
'release evidence variables contain immutable artifact IDs, not self-authored receipt JSON');
check(!relYml.includes('electron-builder') && !relYml.includes('softprops/action-gh-release') &&
  relYml.includes('download-release-candidate.mjs'),
'release reuses the accepted CI candidate and has no direct public-release action');
const retainIndex = relYml.indexOf('Retain exact release transaction inputs');
const publishIndex = relYml.indexOf('Draft, verify and publish exact assets');
check(retainIndex >= 0 && publishIndex > retainIndex &&
  publishJob.slice(0, publishIndex - relYml.indexOf('  publish:')).includes('verify-support-endpoint.mjs'),
'candidate/evidence retention and bound support verification precede publication');
check(ciYml.includes('release-candidate-${{ github.sha }}') &&
  ciYml.includes('node scripts/release-candidate.mjs --dist dist --head "${{ github.sha }}"') &&
  !/Upload exact release candidate[\s\S]{0,500}continue-on-error:\s*true/.test(ciYml),
'CI records and retains the exact main-SHA release candidate without masking failure');

const releaseDoc = fs.readFileSync(path.join(ROOT, 'docs', 'development', 'release-process.md'), 'utf8');
check(!/npm audit[^\n]*advisory-only/i.test(releaseDoc) &&
  releaseDoc.includes('blocking `npm audit --audit-level=high`') &&
  releaseDoc.includes('non-latest draft') &&
  releaseDoc.includes('Native acceptance') &&
  releaseDoc.includes('Support clearance') && releaseDoc.includes('exact current `main`'),
'release documentation describes the enforced audit, exact-main, draft, native and support gates');
check(releaseDoc.includes('support-clearance.json') && !releaseDoc.includes('support-release-clearance.json'),
'release documentation uses the implemented support-clearance asset name');
const releaseActionPins = uses.filter(item => ['release.yml', 'release-evidence.yml'].includes(item.file))
  .map(item => (/@([a-f0-9]{40})/.exec(item.line) || [])[1]).filter(Boolean);
check(releaseActionPins.length > 0 && releaseActionPins.every(sha => releaseDoc.includes(sha)),
'release documentation action inventory matches the exact workflow pins');
const releaseScripts = [
  'github-rest.mjs', 'download-release-candidate.mjs', 'release-preflight.mjs', 'publish-release.mjs'
].map(file => fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8')).join('\n');
check(releaseScripts.includes("export const GITHUB_API_VERSION = '2026-03-10'") &&
  !releaseScripts.includes('2022-11-28') &&
  ['download-release-candidate.mjs', 'release-preflight.mjs', 'publish-release.mjs'].every(file =>
    fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8').includes("./github-rest.mjs")),
'release REST callers share the repository-required 2026-03-10 transport');

if (failures) { console.error(`release-identity-smoke: ${failures} FAIL`); process.exit(1); }
console.log('release-identity-smoke: PASS');
