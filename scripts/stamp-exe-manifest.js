'use strict';

/**
 * Embed requestedExecutionLevel=requireAdministrator into a PE image.
 * electron-builder 26 leaves asInvoker on unsigned builds (rcedit is skipped
 * when there is no certificate), so afterPack must stamp the manifest itself.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = new Set(['requireAdministrator', 'asInvoker', 'highestAvailable']);

function manifestXml(level = 'requireAdministrator') {
  if (!LEVELS.has(level)) throw new Error(`unsupported requestedExecutionLevel: ${level}`);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">',
    '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">',
    '    <security>',
    '      <requestedPrivileges>',
    `        <requestedExecutionLevel level="${level}" uiAccess="false"/>`,
    '      </requestedPrivileges>',
    '    </security>',
    '  </trustInfo>',
    '</assembly>'
  ].join('\n');
}

const MANIFEST_XML = manifestXml('requireAdministrator');

const RT_MANIFEST = 24;

function resolveResedit() {
  const bases = [];
  try { bases.push(path.dirname(require.resolve('app-builder-lib/package.json'))); } catch (_) {}
  try { bases.push(path.dirname(require.resolve('electron-builder/package.json'))); } catch (_) {}
  bases.push(process.cwd());
  for (const base of bases) {
    try { return require(require.resolve('resedit', { paths: [base] })); } catch (_) {}
  }
  try { return require('resedit'); } catch (_) {}
  return null;
}

async function stampWithRcedit(exePath, level) {
  let rcedit;
  try { rcedit = require('rcedit'); } catch (_) { return false; }
  await rcedit(exePath, { 'requested-execution-level': level });
  return true;
}

function stampWithResedit(exePath, level) {
  const resedit = resolveResedit();
  if (!resedit) return false;
  const NtExecutable = resedit.NtExecutable || (resedit.default && resedit.default.NtExecutable);
  const NtExecutableResource = resedit.NtExecutableResource || (resedit.default && resedit.default.NtExecutableResource);
  if (!NtExecutable || !NtExecutableResource) return false;
  const data = fs.readFileSync(exePath);
  const exe = NtExecutable.from(data);
  const res = NtExecutableResource.from(exe);
  const xml = Buffer.from(manifestXml(level), 'utf8');
  for (let i = res.entries.length - 1; i >= 0; i--) {
    if (res.entries[i].type === RT_MANIFEST) res.entries.splice(i, 1);
  }
  res.entries.push({
    type: RT_MANIFEST,
    id: 1,
    lang: 1033,
    bin: xml
  });
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return true;
}

// Shipped builds are always requireAdministrator. asInvoker exists only for
// the packaged acceptance driver: a GitHub-hosted runner has UAC disabled,
// and with UAC off Windows refuses to CreateProcess a requireAdministrator
// image from the sandbox's restricted token (Chromium SBOX_ERROR_CREATE_PROCESS
// = 18), so the renderer never launches there. The driver stamps a throwaway
// copy; the release artifact is never touched.
async function stampExecutionLevel(exePath, level = 'requireAdministrator') {
  if (!LEVELS.has(level)) throw new Error(`unsupported requestedExecutionLevel: ${level}`);
  if (await stampWithRcedit(exePath, level)) return 'rcedit';
  if (stampWithResedit(exePath, level)) return 'resedit';
  throw new Error(`could not stamp ${level} onto ${exePath} (no rcedit or resedit)`);
}

function stampRequireAdministrator(exePath) {
  return stampExecutionLevel(exePath, 'requireAdministrator');
}

module.exports = { stampRequireAdministrator, stampExecutionLevel, manifestXml, MANIFEST_XML };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/stamp-exe-manifest.js <exe>');
    process.exit(2);
  }
  stampRequireAdministrator(target).then((how) => {
    console.log(`stamped requireAdministrator via ${how}: ${target}`);
  }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
