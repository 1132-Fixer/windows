#!/usr/bin/env node
// Records the true Authenticode state of the built Windows artifacts and
// enforces the one invariant that keeps the update channel recoverable.
//
//   node scripts/check-signature-state.mjs                 # inspect dist/
//   node scripts/check-signature-state.mjs --dist <dir>
//
// Windows only — it shells out to Get-AuthenticodeSignature.
//
// The invariant
// -------------
// electron-updater's `verifyUpdateCodeSignature` is evaluated by the version
// the user already has installed, against the installer it just downloaded.
// So a release whose own artifacts are unsigned while the flag is true does
// not fail at build time — it fails months later, on every client running
// that version, with no way to push a fix through the updater. The check
// below refuses to publish that combination.
//
// It also closes the quieter hole: a release job that had a certificate
// configured, failed to apply it, and shipped unsigned anyway.
//
// Exit codes: 0 = state is publishable, 1 = refuse to publish.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..'
);
const DIST = path.resolve(argOf('--dist', path.join(REPO_ROOT, 'dist')));
const OUT = path.resolve(argOf('--out', path.join(DIST, 'signature-state.json')));

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const win = pkg.build?.win ?? {};
const verifyFlag = win.verifyUpdateCodeSignature === true;
const expectedPublisher = win.publisherName ?? null;

// A certificate was offered to this build if either variable carries a value.
const certConfigured = Boolean(process.env.CSC_LINK) || Boolean(process.env.WIN_CSC_LINK);

const errors = [];
const fail = (msg) => { errors.push(msg); console.error(`FAIL: ${msg}`); };
const ok = (msg) => console.log(`OK:   ${msg}`);

// PowerShell has no backslash escape, so a Windows path must go in a
// single-quoted string with any embedded quote doubled. JSON.stringify would
// turn every separator into a literal double backslash.
const psLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

function inspect(file) {
  // Newline-joined: a hashtable literal cannot be collapsed onto one line
  // with semicolons after the opening brace.
  const ps = [
    '$ErrorActionPreference = "Stop"',
    `$s = Get-AuthenticodeSignature -LiteralPath ${psLiteral(file)}`,
    '[PSCustomObject]@{',
    '  status = $s.Status.ToString()',
    '  message = $s.StatusMessage',
    '  signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }',
    '  thumbprint = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null }',
    '  notAfter = if ($s.SignerCertificate) { $s.SignerCertificate.NotAfter.ToString("o") } else { $null }',
    '  timestamped = [bool]$s.TimeStamperCertificate',
    '} | ConvertTo-Json -Compress',
  ].join('\n');

  // pwsh, not powershell: the release workflow already standardises on
  // PowerShell 7, and Windows PowerShell 5.1 cannot always autoload
  // Microsoft.PowerShell.Security under a constrained profile.
  const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

// The subject is a full DN; compare on the CN only, which is what
// electron-updater matches publisherName against.
function commonName(subject) {
  const m = /CN=("([^"]*)"|[^,]*)/.exec(subject ?? '');
  if (!m) return null;
  return (m[2] ?? m[1]).trim();
}

const exeFiles = readdirSync(DIST)
  .filter((f) => f.toLowerCase().endsWith('.exe'))
  .sort();

if (exeFiles.length === 0) {
  fail(`No .exe artifacts found in ${DIST}`);
  process.exit(1);
}

console.log(`Artifacts        : ${DIST}`);
console.log(`Expected publisher: ${expectedPublisher ?? '<none declared>'}`);
console.log(`verifyUpdateCodeSignature: ${verifyFlag}`);
console.log(`Certificate offered to this build: ${certConfigured ? 'yes' : 'no'}`);
console.log('');

const results = [];
for (const name of exeFiles) {
  const info = inspect(path.join(DIST, name));
  const signed = info.status === 'Valid';
  const cn = commonName(info.signer);
  results.push({ file: name, ...info, commonName: cn, signed });
  console.log(`${name}: ${info.status}${cn ? ` (CN=${cn})` : ''}`);
}
console.log('');

const anyUnsigned = results.some((r) => !r.signed);
const allUnsigned = results.every((r) => r.status === 'NotSigned');

// 1. Unsigned artifacts must never ship with verification switched on.
if (anyUnsigned && verifyFlag) {
  fail(
    'verifyUpdateCodeSignature is true but at least one artifact is not validly signed. ' +
      'Publishing this would make every future update fail on clients running this version. ' +
      'Sign the artifacts, or leave the flag false until signing works.'
  );
}

// 2. A configured certificate that produced nothing is a silent signing failure.
if (certConfigured && anyUnsigned) {
  fail(
    'A signing certificate was configured for this build but an artifact is not validly signed. ' +
      'Treat this as a signing failure, not an unsigned release.'
  );
}

// 3. When artifacts are signed, the identity has to be the declared one and
//    carry a timestamp, or the signature stops verifying the day the
//    certificate expires.
for (const r of results.filter((x) => x.status !== 'NotSigned')) {
  if (!r.signed) fail(`${r.file}: signature status is ${r.status} — ${r.message}`);
  else if (expectedPublisher && r.commonName !== expectedPublisher) {
    fail(`${r.file}: signer CN "${r.commonName}" does not match declared publisherName "${expectedPublisher}"`);
  } else ok(`${r.file}: Authenticode signer = expected publisher (${r.commonName})`);

  if (!r.timestamped) fail(`${r.file}: signature has no timestamp — it will stop validating at certificate expiry`);
  else ok(`${r.file}: signature is timestamped`);
}

// 4. Unsigned with the flag off is the current, documented state. It is
//    allowed, and it is recorded so the release cannot quietly imply
//    otherwise. See docs/security/code-signing.md.
if (allUnsigned && !verifyFlag && !certConfigured) {
  ok('All artifacts unsigned, verification off, no certificate configured — the documented unsigned-build state');
  console.log('');
  console.log('NOTE: this release is UNSIGNED. Windows SmartScreen will warn on download,');
  console.log('      and the updater cannot prove an update came from the publisher.');
  console.log('      Do not describe this release as signed or signature-verified.');
}

const state = {
  generatedAt: new Date().toISOString(),
  version: pkg.version,
  verifyUpdateCodeSignature: verifyFlag,
  expectedPublisher,
  certificateConfigured: certConfigured,
  overall: errors.length ? 'REFUSED' : allUnsigned ? 'UNSIGNED' : 'SIGNED',
  artifacts: results,
};
writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`);
ok(`Signature state written to ${OUT}`);

if (errors.length) {
  console.error(`\n${errors.length} check(s) failed — refusing to publish.`);
  process.exit(1);
}
