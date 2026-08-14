#!/usr/bin/env node
// Enumerates everything the Windows build actually ships and checks it against
// build/package-allowlist.json.
//
//   node scripts/package-inventory.mjs                     # verify dist/win-unpacked
//   node scripts/package-inventory.mjs --unpacked <dir>
//   node scripts/package-inventory.mjs --out <file.json>
//
// Why this exists: package.json "files" is a broad "**/*" glob with a deny
// list. What lands in the installer therefore depends on what happens to be
// in the working tree at build time — an uninitialised submodule, a leftover
// local file, or a new dependency changes the payload with no diff to review.
// This script turns the shipped payload into a reviewable artifact and fails
// the build when an unexpected executable, script, key, database or archive
// appears.
//
// Exit codes: 0 = allowlist satisfied, 1 = violation or read error.

import { createHash } from 'node:crypto';
import { readFileSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const UNPACKED = path.resolve(argOf('--unpacked', path.join('dist', 'win-unpacked')));
const OUT = path.resolve(argOf('--out', path.join('dist', 'package-inventory.json')));
const ALLOWLIST = path.resolve(argOf('--allowlist', path.join(REPO_ROOT, 'build', 'package-allowlist.json')));

const errors = [];
const fail = (msg) => { errors.push(msg); console.error(`FAIL: ${msg}`); };
const ok = (msg) => console.log(`OK:   ${msg}`);

// ---------------------------------------------------------------- asar reader
// ASAR is two chained Pickle records followed by the file data:
//   [0..3]  uint32  payload size of pickle #1 (always 4)
//   [4..7]  uint32  total size of pickle #2
//   pickle #2: [0..3] payload size, [4..7] JSON length, then the JSON header.
// Reading the header alone is enough to enumerate the archive, so this stays a
// header read rather than a full extraction.
function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    readSync(fd, sizeBuf, 0, 8, 0);
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerPickleSize);
    readSync(fd, headerBuf, 0, headerPickleSize, 8);
    const jsonLength = headerBuf.readUInt32LE(4);
    return JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLength));
  } finally {
    closeSync(fd);
  }
}

function flattenAsar(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry.files) flattenAsar(entry, rel, out);
    else out.push({ path: rel, size: entry.size ?? 0, unpacked: Boolean(entry.unpacked) });
  }
  return out;
}

// ------------------------------------------------------------ directory walk
async function walk(dir, base, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, base, out);
    else if (entry.isFile()) {
      out.push({
        path: path.relative(base, abs).split(path.sep).join('/'),
        size: statSync(abs).size,
        sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ main
const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
const denied = new Set(allowlist.deniedExtensions.map((e) => e.toLowerCase()));
const allowedUnpacked = new Set(allowlist.allowedUnpackedPaths);
const allowedAsar = new Set(allowlist.allowedAsarPaths || []);

function isDenied(p) {
  return denied.has(path.extname(p).toLowerCase());
}

let unpackedFiles;
try {
  unpackedFiles = await walk(UNPACKED, UNPACKED);
} catch (e) {
  fail(`Cannot read unpacked build at ${UNPACKED}: ${e.message}`);
  process.exit(1);
}

const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
let asarFiles = [];
try {
  asarFiles = flattenAsar(readAsarHeader(asarPath), '', []);
} catch (e) {
  fail(`Cannot read ${asarPath}: ${e.message}`);
  process.exit(1);
}

console.log(`Unpacked build : ${UNPACKED}`);
console.log(`Files on disk  : ${unpackedFiles.length}`);
console.log(`Files in asar  : ${asarFiles.length}`);
console.log('');

for (const f of unpackedFiles) {
  if (isDenied(f.path) && !allowedUnpacked.has(f.path)) {
    fail(`Unexpected ${path.extname(f.path)} in shipped payload: ${f.path} (${f.size} bytes, sha256 ${f.sha256})`);
  }
}

for (const f of asarFiles) {
  if (isDenied(f.path) && !allowedAsar.has(f.path)) {
    fail(`Unexpected ${path.extname(f.path)} inside app.asar: ${f.path} (${f.size} bytes)`);
  }
}

// An allowlist entry that no longer matches anything is stale and hides drift.
const unpackedPaths = new Set(unpackedFiles.map((f) => f.path));
for (const p of allowedUnpacked) {
  if (!unpackedPaths.has(p)) fail(`Allowlist entry no longer ships and must be removed: ${p}`);
}
const asarPaths = new Set(asarFiles.map((f) => f.path));
for (const p of allowedAsar) {
  if (!asarPaths.has(p)) fail(`Allowlist entry no longer ships and must be removed: asar:${p}`);
}

const inventory = {
  generatedAt: new Date().toISOString(),
  unpackedRoot: path.basename(UNPACKED),
  counts: { unpacked: unpackedFiles.length, asar: asarFiles.length },
  unpacked: unpackedFiles.sort((a, b) => a.path.localeCompare(b.path)),
  asar: asarFiles.sort((a, b) => a.path.localeCompare(b.path)),
};
writeFileSync(OUT, `${JSON.stringify(inventory, null, 2)}\n`);
ok(`Inventory written to ${OUT}`);

if (errors.length) {
  console.error(`\n${errors.length} allowlist violation(s).`);
  process.exit(1);
}
ok(`No unexpected executable, script, key, database or archive in the shipped payload`);
