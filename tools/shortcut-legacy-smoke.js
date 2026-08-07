// Standalone smoke for the legacy-shortcut cleanup introduced by the
// 2026-08-07 helper-shortcut rebrand. Mirrors main.js's rules exactly:
//   - exact legacy filenames only (never a glob, never a prefix match)
//   - only the app's own three desktop locations
//   - cleanup runs only AFTER the renamed shortcut exists
//   - creation is idempotent; repeated runs leave one shortcut
//   - a cleanup failure is reported, never fatal
// Runs against a temp sandbox; touches no real Desktop. Exit 0 PASS / 1 FAIL.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX_USER = 'user1';
const SHORTCUT_FILENAME = 'Open Zoom with 1132 Helper.lnk';
const LEGACY_SHORTCUT_FILENAMES = [`Launch Zoom as ${FIX_USER}.lnk`];

let pass = 0, fail = 0;
const check = (name, ok) => {
  if (ok) { console.log(`PASS  ${name}`); pass++; }
  else { console.log(`FAIL  ${name}`); fail++; }
};

// --- sandbox: three "desktop" locations, as main.js enumerates ------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), '1132-shortcut-'));
const locations = ['user', 'onedrive', 'public'].map(kind => {
  const p = path.join(root, kind);
  fs.mkdirSync(p, { recursive: true });
  return { kind, path: p };
});
const touch = (dir, name) => fs.writeFileSync(path.join(dir, name), 'lnk', 'utf8');
const exists = (dir, name) => fs.existsSync(path.join(dir, name));

// --- the functions under test, mirroring main.js -------------------------
function findLegacyShortcuts() {
  const out = [];
  for (const loc of locations) {
    for (const name of LEGACY_SHORTCUT_FILENAMES) {
      const lnk = path.join(loc.path, name);
      if (fs.existsSync(lnk)) out.push({ kind: loc.kind, path: lnk, name });
    }
  }
  return out;
}
function removeLegacyShortcuts() {
  const removed = [], failed = [];
  for (const s of findLegacyShortcuts()) {
    try { fs.unlinkSync(s.path); removed.push(s.path); }
    catch (err) { failed.push({ path: s.path, error: err.message }); }
  }
  return { removed, failed };
}
// Create is idempotent: same filename, overwritten in place, never suffixed.
function createShortcut(dir) {
  fs.writeFileSync(path.join(dir, SHORTCUT_FILENAME), 'lnk', 'utf8');
  return removeLegacyShortcuts();
}

// --- 1: legacy shortcut found and removed --------------------------------
touch(locations[0].path, LEGACY_SHORTCUT_FILENAMES[0]);
let r = createShortcut(locations[0].path);
check('legacy shortcut is found and removed after the new one is created',
  r.removed.length === 1 &&
  !exists(locations[0].path, LEGACY_SHORTCUT_FILENAMES[0]) &&
  exists(locations[0].path, SHORTCUT_FILENAME));

// --- 2: unrelated shortcuts are never touched ----------------------------
const bystanders = [
  'Launch Zoom.lnk',                       // similar, not exact
  'Launch Zoom as user1 - Copy.lnk',       // prefix match, must survive
  'user1.lnk',
  'Zoom.lnk',
];
bystanders.forEach(n => touch(locations[0].path, n));
touch(locations[1].path, LEGACY_SHORTCUT_FILENAMES[0]);
r = createShortcut(locations[1].path);
check('unrelated and near-miss shortcuts are preserved',
  bystanders.every(n => exists(locations[0].path, n)) && r.removed.length === 1);

// --- 3: new shortcut already present -------------------------------------
const before = fs.readdirSync(locations[1].path).length;
r = createShortcut(locations[1].path);
check('creating when the new shortcut already exists is a no-op for count',
  fs.readdirSync(locations[1].path).length === before && r.removed.length === 0);

// --- 4: repeated execution stays duplicate-free --------------------------
for (let i = 0; i < 5; i++) createShortcut(locations[2].path);
const dupes = fs.readdirSync(locations[2].path).filter(f => f.endsWith('.lnk'));
check('repeated execution leaves exactly one shortcut', dupes.length === 1);

// --- 5: cleanup failure is reported, not thrown --------------------------
touch(locations[2].path, LEGACY_SHORTCUT_FILENAMES[0]);
const realUnlink = fs.unlinkSync;
fs.unlinkSync = () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
let threw = false, res = null;
try { res = createShortcut(locations[2].path); } catch (_) { threw = true; }
fs.unlinkSync = realUnlink;
check('a cleanup failure is reported safely and never throws',
  !threw && res && res.failed.length === 1 && res.removed.length === 0 &&
  exists(locations[2].path, SHORTCUT_FILENAME));

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
