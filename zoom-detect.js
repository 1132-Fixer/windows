// Pure helpers for machine-wide Zoom install detection.
// main.js owns the filesystem/registry probing; this module owns
// the parsing, path-safety validation, and user-facing copy so the shipped
// logic is unit-testable (tools/zoom-detection-smoke.js) — Electron requires
// in main.js make it impossible to import main.js directly under plain node.

const path = require('path');

// Resolved paths are interpolated into single-quoted PowerShell strings
// (Start-Process launch + helper-shortcut launcher script). Reject anything
// that could escape the quote or smuggle a second statement: apostrophes,
// newlines, `;&|`. Also pins an absolute local drive root (no UNC, no
// relative segments) and a literal Zoom.exe basename.
const SAFE_ZOOM_PATH_RE = /^[A-Za-z]:\\[^'\r\n;&|]*Zoom\.exe$/;

function isSafeZoomPath(p) {
  return typeof p === 'string' && SAFE_ZOOM_PATH_RE.test(p);
}

// Parse the registry-probe stdout — lines of `InstallLocation=<value>` /
// `DisplayIcon=<value>` — into an ordered, de-duplicated list of candidate
// install dirs. DisplayIcon is usually `<dir>\Zoom.exe` or the same with an
// `,<iconIndex>` suffix; strip the index and take the directory.
function deriveCandidateDirs(text) {
  const dirs = [];
  const seen = new Set();
  const push = (dir) => {
    const clean = String(dir || '').trim().replace(/^"|"$/g, '').replace(/\\+$/, '');
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(clean);
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(InstallLocation|DisplayIcon)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'InstallLocation') {
      push(m[2]);
    } else {
      const icon = m[2].trim().replace(/^"|"$/g, '').replace(/,-?\d+$/, '');
      if (icon) push(path.win32.dirname(icon));
    }
  }
  return dirs;
}

// Pull the Zoom path baked into a helper-launcher script (the single-quoted
// Start-Process -FilePath argument). Returns null when the text has no
// recognizable launch line — callers must treat null as "cannot judge",
// never as "stale".
function extractLauncherZoomPath(scriptText) {
  const m = /Start-Process\s+-FilePath\s+'([^']+)'/.exec(String(scriptText || ''));
  return m ? m[1] : null;
}

const ZOOM_NOT_FOUND_MESSAGE =
  'Not found. Install the machine-wide Zoom Workplace MSI (not the per-user installer) — ' +
  'download it from zoom.us/download under "Zoom Workplace for IT admins" — then Check again.';

// One message for the three detection states, used verbatim by the preflight
// card, the preflight blocker, and the fix-run error:
//   machine-wide found -> resolved path (+ variant suffix)
//   only per-user found -> why the helper account can't use it
//   nothing found       -> install the machine-wide MSI
function zoomStatusMessage(install) {
  const { path: zoomPath, source, perUserPath } = install || {};
  if (zoomPath) {
    if (source === 'default-x86') return `${zoomPath} (32-bit)`;
    if (source === 'registry') return `${zoomPath} (custom location)`;
    return zoomPath;
  }
  if (perUserPath) {
    return `Zoom is installed for your Windows user only (${perUserPath}). ` +
      `The fix launches Zoom under its helper account, which can't see per-user installs — ` +
      `install the machine-wide Zoom Workplace MSI from zoom.us/download ` +
      `("Zoom Workplace for IT admins"), then Check again.`;
  }
  return ZOOM_NOT_FOUND_MESSAGE;
}

// ============================================================
// Chosen-installer validation helpers (guided recovery card, operator
// directive 2026-08-09). Pure — main.js owns the file/PowerShell probing;
// tools/zoom-detection-smoke.js pins these against fixture bytes.
// ============================================================

// OLE compound-file magic (0xD0CF11E0) — every real MSI starts with it. A
// renamed .exe (MZ), .zip (PK), or text file fails here before any deeper
// validation runs.
function hasMsiMagic(buf) {
  return !!buf && buf.length >= 4 &&
    buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0;
}

// Extract the CN from an X.500 distinguished name as .NET renders it:
// quoted when the value embeds commas ('CN="Zoom Video Communications,
// Inc.", O=…') or unquoted with backslash-escaped commas. Returns null when
// no CN is present — callers treat null as "not Zoom", never as a pass.
function subjectCn(subject) {
  const s = String(subject || '');
  let m = /CN="((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) return m[1].replace(/\\(.)/g, '$1');
  m = /CN=((?:\\.|[^,])*)/.exec(s);
  return m ? m[1].replace(/\\(.)/g, '$1').trim() : null;
}

// MSI Summary-Information Template property (";"-separated, platform first:
// "x64;1033", "Intel;1033", "Arm64;1033") -> normalized platform token.
// Unrecognized tokens pass through lowercased so refusal copy can show them.
function msiPlatform(template) {
  const tok = String(template || '').split(';')[0].trim().toLowerCase();
  if (tok === 'x64' || tok === 'amd64') return 'x64';
  if (tok === 'intel' || tok === 'x86') return 'x86';
  if (tok === 'arm64') return 'arm64';
  return tok || null;
}

// PROCESSOR_ARCHITECTURE / PROCESSOR_ARCHITEW6432 value -> same token set.
function osArchNorm(procArch) {
  const a = String(procArch || '').trim().toLowerCase();
  if (a === 'amd64' || a === 'x64') return 'x64';
  if (a === 'x86') return 'x86';
  if (a === 'arm64') return 'arm64';
  return a || null;
}

const ARCH_LABEL = {
  x64: 'x64 (Intel/AMD 64-bit)',
  x86: '32-bit (x86)',
  arm64: 'ARM64'
};

// What may run where. 32-bit MSIs run on x64 Windows (WOW64); everything
// else must match exactly. x64-on-ARM64 is deliberately NOT accepted — the
// directive requires an explained refusal, never a silent x64 choice.
const ARCH_COMPAT = {
  x64: ['x64', 'x86'],
  x86: ['x86'],
  arm64: ['arm64']
};

// Compare the MSI's declared platform with the OS architecture. Every
// non-ok result carries a user-facing explanation — a mismatch is NEVER
// silent, and an unreadable/unrecognized value is a refusal, not a pass.
function archCompare(template, procArch) {
  const msi = msiPlatform(template);
  const os = osArchNorm(procArch);
  if (!msi) {
    return { ok: false, msi, os, message: 'The installer does not declare a processor architecture, so it cannot be verified as compatible with this PC.' };
  }
  if (!os) {
    return { ok: false, msi, os, message: `Windows reports an unrecognized processor architecture ("${String(procArch || '')}"), so installer compatibility cannot be verified.` };
  }
  if ((ARCH_COMPAT[os] || []).includes(msi)) {
    return { ok: true, msi, os, message: '' };
  }
  const message = (os === 'arm64' && msi === 'x64')
    ? 'This installer is built for x64 (Intel/AMD 64-bit) Windows, but this PC runs Windows on ARM (ARM64). Download the ARM64 Zoom Workplace installer instead.'
    : `This installer is built for ${ARCH_LABEL[msi] || msi} Windows, but this PC runs ${ARCH_LABEL[os] || os} Windows.`;
  return { ok: false, msi, os, message };
}

module.exports = {
  extractLauncherZoomPath,
  SAFE_ZOOM_PATH_RE,
  isSafeZoomPath,
  deriveCandidateDirs,
  zoomStatusMessage,
  ZOOM_NOT_FOUND_MESSAGE,
  hasMsiMagic,
  subjectCn,
  msiPlatform,
  osArchNorm,
  archCompare
};
