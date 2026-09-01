#!/usr/bin/env node
'use strict';

/**
 * Packaged-resource verification for the Explore logos (issue #185).
 *
 * The three supplied logos are useless if they do not ship. This proves,
 * against the REAL electron-builder output, that every icon the Explore
 * catalog references is inside app.asar, byte-identical to the repository
 * copy, and reachable by its exact case.
 *
 * Case matters and is easy to get wrong: the repository and the packaged
 * archive are both case-sensitive on Linux CI, while a Windows developer's
 * filesystem is not — so `Make-It-GIF.png` would work locally and fail in
 * CI and in the archive.
 *
 * Run:  node tools/explore-package-smoke.js
 * Build first: npx electron-builder --win dir --x64 --publish never
 * SKIPS (exit 0) when no build output is present, so `npm test` stays fast;
 * it never reports a pass it did not measure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const messages = require('../messages.js');

let failures = 0;
const check = (ok, label) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) failures++; };

// The packaging config must not exclude the assets in the first place.
console.log('explore-package-smoke: packaging configuration');
{
  const build = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build || {};
  const files = build.files || [];
  const excludes = files.filter(f => typeof f === 'string' && f.startsWith('!'));
  for (const d of messages.EXPLORE_VIEW) {
    const hit = excludes.find(e => e.slice(1).replace(/\*\*.*$/, '') && d.icon.startsWith(e.slice(1).replace(/\*+$/, '')));
    check(!hit, `${d.icon} is not excluded from the package`);
  }
}

if (!fs.existsSync(ASAR)) {
  console.log('\nexplore-package-smoke: SKIPPED — no dist/win-unpacked build present.');
  console.log('  Build with: npx electron-builder --win dir --x64 --publish never');
  process.exit(failures ? 1 : 0);
}

// Minimal asar reader.
//
// The container is a Chromium Pickle: [0..4) = 4, [4..8) = the size of the
// header pickle, [8..12) = that pickle's own payload size, [12..16) = the
// length of the header JSON string, then the JSON. File data begins at
// 8 + headerPickleSize — NOT at 16 + jsonLength, which lands mid-archive
// because the pickle is padded to a 4-byte boundary.
function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerPickleSize = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  const raw = Buffer.alloc(jsonLength);
  fs.readSync(fd, raw, 0, jsonLength, 16);
  const header = JSON.parse(raw.toString('utf8'));
  return { fd, header, base: 8 + headerPickleSize };
}

function lookup(header, relPath) {
  let node = header;
  for (const part of relPath.split('/')) {
    if (!node.files || !Object.prototype.hasOwnProperty.call(node.files, part)) return null;
    node = node.files[part];   // exact-case lookup by construction
  }
  return node;
}

console.log('\nexplore-package-smoke: packaged Explore assets');
const { fd, header, base } = readAsar(ASAR);
try {
  for (const d of messages.EXPLORE_VIEW) {
    const entry = lookup(header, d.icon);
    if (!entry || entry.size === undefined) { check(false, `${d.icon} is present in app.asar`); continue; }
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
    const packed = crypto.createHash('md5').update(buf).digest('hex');
    const repo = crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, d.icon))).digest('hex');
    check(packed === repo, `${d.icon} ships byte-identical (${repo.slice(0, 8)})`);
  }
  // The three logos supplied on the issue, named explicitly so a rename
  // cannot quietly drop one while the catalog still looks complete.
  for (const asset of ['assets/explore/make-it-gif.png',
                       'assets/explore/gif-directory.png',
                       'assets/explore/prime-hosting.png']) {
    check(!!lookup(header, asset), `supplied logo ${path.basename(asset)} is in the packaged app`);
  }
} finally {
  fs.closeSync(fd);
}

console.log(`\nexplore-package-smoke: ${failures ? failures + ' FAIL' : 'PASS'}`);
process.exit(failures ? 1 : 0);
