'use strict';

/**
 * Embed requestedExecutionLevel=requireAdministrator into a PE image.
 * electron-builder 26 leaves asInvoker on unsigned builds (rcedit is skipped
 * when there is no certificate), so afterPack must stamp the manifest itself.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">',
  '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">',
  '    <security>',
  '      <requestedPrivileges>',
  '        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>',
  '      </requestedPrivileges>',
  '    </security>',
  '  </trustInfo>',
  '</assembly>'
].join('\n');

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

async function stampWithRcedit(exePath) {
  let rcedit;
  try { rcedit = require('rcedit'); } catch (_) { return false; }
  await rcedit(exePath, { 'requested-execution-level': 'requireAdministrator' });
  return true;
}

function stampWithResedit(exePath) {
  const resedit = resolveResedit();
  if (!resedit) return false;
  const NtExecutable = resedit.NtExecutable || (resedit.default && resedit.default.NtExecutable);
  const NtExecutableResource = resedit.NtExecutableResource || (resedit.default && resedit.default.NtExecutableResource);
  if (!NtExecutable || !NtExecutableResource) return false;
  const data = fs.readFileSync(exePath);
  const exe = NtExecutable.from(data);
  const res = NtExecutableResource.from(exe);
  const xml = Buffer.from(MANIFEST_XML, 'utf8');
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

async function stampRequireAdministrator(exePath) {
  if (await stampWithRcedit(exePath)) return 'rcedit';
  if (stampWithResedit(exePath)) return 'resedit';
  throw new Error(`could not stamp requireAdministrator onto ${exePath} (no rcedit or resedit)`);
}

module.exports = { stampRequireAdministrator, MANIFEST_XML };

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
