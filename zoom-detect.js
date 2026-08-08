// Pure helpers for machine-wide Zoom install detection (triage cluster
// W1-DETECT). main.js owns the filesystem/registry probing; this module owns
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

const ZOOM_NOT_FOUND_MESSAGE =
  'Not found. Install the machine-wide Zoom Workplace MSI (not the per-user installer), then Check again.';

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
      `install the machine-wide Zoom Workplace MSI, then Check again.`;
  }
  return ZOOM_NOT_FOUND_MESSAGE;
}

module.exports = {
  SAFE_ZOOM_PATH_RE,
  isSafeZoomPath,
  deriveCandidateDirs,
  zoomStatusMessage,
  ZOOM_NOT_FOUND_MESSAGE
};
