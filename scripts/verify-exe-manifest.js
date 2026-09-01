'use strict';

/**
 * Read the requestedExecutionLevel from a PE image by searching the
 * embedded manifest XML (UTF-8 or UTF-16LE). Used by afterPack and tests.
 * Does not assume package.json requestedExecutionLevel was applied.
 */

const fs = require('fs');

const LEVEL_RE = /requestedExecutionLevel[^>]*level\s*=\s*"(asInvoker|highestAvailable|requireAdministrator)"/i;

function inspectExeManifest(filePath) {
  const buf = fs.readFileSync(filePath);
  const utf8 = buf.toString('utf8');
  const utf16 = buf.toString('utf16le');
  const m = utf8.match(LEVEL_RE) || utf16.match(LEVEL_RE);
  const uiAccess = /uiAccess\s*=\s*"(true|false)"/i.exec((m && m.input) || utf8) ||
    /uiAccess\s*=\s*"(true|false)"/i.exec(utf16);
  return {
    filePath,
    size: buf.length,
    requestedExecutionLevel: m ? m[1] : null,
    uiAccess: uiAccess ? uiAccess[1] : null,
    foundManifestXml: /assemblyIdentity|requestedExecutionLevel/i.test(utf8) ||
      /assemblyIdentity|requestedExecutionLevel/i.test(utf16)
  };
}

function assertRequireAdministrator(filePath) {
  const info = inspectExeManifest(filePath);
  if (info.requestedExecutionLevel !== 'requireAdministrator') {
    const err = new Error(
      `embedded manifest requestedExecutionLevel is ${JSON.stringify(info.requestedExecutionLevel)}, expected requireAdministrator (${filePath})`
    );
    err.manifest = info;
    throw err;
  }
  return info;
}

module.exports = { inspectExeManifest, assertRequireAdministrator };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/verify-exe-manifest.js <exe>');
    process.exit(2);
  }
  const info = inspectExeManifest(target);
  console.log(JSON.stringify(info, null, 2));
  if (info.requestedExecutionLevel !== 'requireAdministrator') process.exit(1);
}
