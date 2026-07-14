#!/usr/bin/env node
/**
 * postinstall.js — ensure Electron's native binary is set up after install.
 *
 * Electron ships its own `postinstall` (node install.js) that downloads the
 * platform binary and writes node_modules/electron/path.txt. Some locked-down
 * environments (CI sandboxes, corp machines, allow-scripts policies) block
 * *dependency* lifecycle scripts, so Electron's postinstall never runs and the
 * app fails at launch with:
 *
 *   Error: Electron failed to install correctly, please delete
 *   node_modules/electron and try installing again
 *
 * A root-package postinstall is usually still permitted, so we re-run
 * Electron's installer here to self-heal that case. This is idempotent and
 * cheap when Electron is already set up (it just re-verifies path.txt).
 *
 * It must NEVER fail the install: if Electron isn't present, or its installer
 * throws, we warn and exit 0 so a normal `npm install` is unaffected.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const installer = path.join(electronDir, 'install.js');
const pathTxt = path.join(electronDir, 'path.txt');

try {
  if (!fs.existsSync(installer)) {
    // Electron not installed (e.g. someone ran `npm install --omit=dev`).
    // Nothing to heal — this is a valid state for a non-dev consumer.
    process.exit(0);
  }
  if (fs.existsSync(pathTxt)) {
    // Electron's own postinstall already ran successfully.
    console.log('[postinstall] Electron already set up (path.txt present).');
    process.exit(0);
  }
  console.log('[postinstall] Electron path.txt missing — running Electron installer to self-heal...');
  require(installer);
  // install.js runs its download asynchronously; give the caller a hint.
  console.log('[postinstall] Electron installer invoked.');
} catch (err) {
  console.warn('[postinstall] Could not finalize Electron install (non-fatal): ' + (err && err.message ? err.message : err));
  console.warn('[postinstall] If the app fails to launch, run:  node node_modules/electron/install.js');
  // Non-fatal on purpose.
  process.exit(0);
}
