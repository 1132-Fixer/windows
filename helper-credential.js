// Helper-account credential model (security design, option A — SEC-A6,
// issues #33/#76). Pure, require()-able helpers shared by main.js and
// tools/helper-credential-smoke.js — main.js cannot be imported under plain
// node (Electron requires), so everything here needs to stay Electron-free.
//
// Model: every fix run mints a FRESH cryptographically random password.
// The fix's delete->recreate flow means no consumer ever needs the previous
// password — the run that mints it also (re)writes every consumer: the
// in-memory launch/relaunch credential and the DPAPI-sealed blob the desktop
// shortcut launcher reads. No plaintext password is persisted anywhere.

const crypto = require('crypto');

// Password alphabet. Every character must be safe, UNQUOTED and UNESCAPED, in
// every place the password travels:
//   - PowerShell single-quoted interpolation ('<password>' inside the launch
//     and seal scripts): apostrophes and CR/LF are the only characters that
//     can terminate a single-quoted PS string — banned. Backtick, `;`, `&`,
//     `|` are banned too as belt-and-braces (same policy as
//     zoom-detect.js SAFE_ZOOM_PATH_RE).
//   - Windows CreateProcess argv (net.exe user <password> /add via spawn):
//     double quotes, backslashes, and spaces complicate argv quoting — banned.
//   - net.exe option parsing: '/' could make the password read as a switch —
//     banned.
// The remaining set still spans all four Windows password-complexity classes,
// so a 24-char draw with one guaranteed pick per class clears the default
// policy ("three of four classes") with margin.
const PASSWORD_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PASSWORD_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const PASSWORD_DIGIT = '0123456789';
const PASSWORD_SPECIAL = '!@#$^*-_=+.';
const PASSWORD_CLASSES = [PASSWORD_UPPER, PASSWORD_LOWER, PASSWORD_DIGIT, PASSWORD_SPECIAL];
const PASSWORD_ALPHABET = PASSWORD_CLASSES.join('');
const PASSWORD_LENGTH = 24;

// CSPRNG password: one guaranteed character per complexity class, the rest
// drawn from the full alphabet, then an unbiased Fisher-Yates shuffle.
// crypto.randomInt is CSPRNG-backed and rejection-sampled (no modulo bias).
function generateHelperPassword() {
  const chars = PASSWORD_CLASSES.map(cls => cls[crypto.randomInt(cls.length)]);
  while (chars.length < PASSWORD_LENGTH) {
    chars.push(PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Shape/safety predicate for a helper password: exact length, alphabet-only
// (which by construction excludes every PS/argv/net.exe-hostile character),
// and at least one character from each complexity class.
function isSafeHelperPassword(pw) {
  if (typeof pw !== 'string' || pw.length !== PASSWORD_LENGTH) return false;
  for (const ch of pw) {
    if (!PASSWORD_ALPHABET.includes(ch)) return false;
  }
  return PASSWORD_CLASSES.every(cls => [...pw].some(ch => cls.includes(ch)));
}

// The DPAPI-sealed credential blob, co-located with the launcher script in
// %APPDATA%\1132 Fixer\ (already primary-user-scoped — no ProgramData, no
// hand-rolled ACLs; a CurrentUser DPAPI blob is opaque to every other account).
const CRED_BLOB_NAME = 'helper-credential.bin';

// Desktop-shortcut launcher body — the SINGLE source both the fix run and the
// create-shortcut IPC write (BOM prepended by the writer, same PS 5.1
// legacy-encoding reason as always). Carries NO secret: it reads
// helper-credential.bin from its own directory and unseals it with DPAPI
// CurrentUser — decryptable only by the Windows account that ran the fix,
// elevated or not (elevation does not change the user profile's DPAPI master
// keys). Any failure (blob missing, Data Protection blocked, password rotated
// by a newer fix while this blob is stale) lands in one friendly
// message box pointing at FIX NOW — never a silent hidden-window death.
// The Start-Process line keeps the exact single-quoted -FilePath shape
// zoom-detect.js extractLauncherZoomPath() parses for staleness checks.
// zoomPath/zoomDir must already have passed isSafeZoomPath (no apostrophes).
function launcherScriptContent(fixUser, zoomPath, zoomDir) {
  return [
    `# Starts Zoom as the '${fixUser}' helper account. Written by 1132 Fixer.`,
    `# The sign-in secret is NOT in this file: it is sealed with Windows DPAPI`,
    `# (CurrentUser scope) in ${CRED_BLOB_NAME} next to this script, and only`,
    `# the Windows account that ran the fix can unseal it.`,
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  Add-Type -AssemblyName System.Security`,
    `  $sealed = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '${CRED_BLOB_NAME}'))`,
    `  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    `  $p = ConvertTo-SecureString ([Text.Encoding]::UTF8.GetString($bytes)) -AsPlainText -Force`,
    `  [Array]::Clear($bytes, 0, $bytes.Length)`,
    `  $c = New-Object System.Management.Automation.PSCredential('${fixUser}', $p)`,
    `  Start-Process -FilePath '${zoomPath}' -WorkingDirectory '${zoomDir}' -Credential $c -EA Stop`,
    `} catch {`,
    `  Add-Type -AssemblyName System.Windows.Forms`,
    `  [void][System.Windows.Forms.MessageBox]::Show('1132 Fixer could not start Zoom with its helper account. Open 1132 Fixer and press FIX NOW to refresh the helper sign-in, then use this shortcut again.', '1132 Fixer', 'OK', 'Warning')`,
    `}`,
    ``
  ].join('\r\n');
}

module.exports = {
  PASSWORD_LENGTH,
  PASSWORD_ALPHABET,
  PASSWORD_CLASSES,
  generateHelperPassword,
  isSafeHelperPassword,
  CRED_BLOB_NAME,
  launcherScriptContent
};
