#!/usr/bin/env node
// Normalizes and verifies the updater metadata electron-builder wrote for a
// Windows build, before anything is published.
//
//   node scripts/finalize-update-metadata.mjs [--dist dist] [--expect-version 6.4.0] [--check]
//
// What it does to dist/latest.yml:
//
//   1. Removes `isAdminRightsRequired: true`. electron-builder writes that
//      flag for every per-machine one-click installer, and electron-updater
//      then starts the installer through `resources/elevate.exe`. This
//      project strips that unsigned helper from the package (see
//      docs/security/BINARY-POLICY.md), so clients built from 6.3.1 to
//      6.3.3 tried to run a file that does not exist, quit, and never
//      installed the update. Without the flag those clients start the
//      installer directly — they already run elevated — and the update
//      applies. Current clients (src/main/updater.js) do not read the flag
//      at all.
//   2. Verifies that every installer named in the file exists in dist/, that
//      the recorded size and SHA-512 match the bytes on disk, and that the
//      version equals package.json (and --expect-version, when given).
//   3. Rewrites the file with LF line endings and no BOM.
//
// --check verifies without rewriting (fails if the flag is still present).
// Exit 0 on success, 1 on any mismatch.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DIST = path.resolve(argOf('--dist', path.join(ROOT, 'dist')));
const CHECK_ONLY = args.includes('--check');
const EXPECT_VERSION = argOf('--expect-version', '');
const FILE = path.join(DIST, 'latest.yml');

export function parseLatestYml(text) {
  const lines = text.split(/\r?\n/);
  const out = { version: '', path: '', sha512: '', releaseDate: '', files: [], hasAdminFlag: false, raw: lines };
  let current = null;
  for (const line of lines) {
    let m;
    if ((m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))) out.version = m[1];
    else if ((m = /^path:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))) out.path = m[1];
    else if ((m = /^sha512:\s*(\S+)\s*$/.exec(line))) out.sha512 = m[1];
    else if ((m = /^releaseDate:\s*['"]?([^'"]+)['"]?\s*$/.exec(line))) out.releaseDate = m[1];
    else if ((m = /^\s+-\s+url:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))) { current = { url: m[1], sha512: '', size: 0 }; out.files.push(current); }
    else if (current && (m = /^\s+sha512:\s*(\S+)\s*$/.exec(line))) current.sha512 = m[1];
    else if (current && (m = /^\s+size:\s*(\d+)\s*$/.exec(line))) current.size = Number(m[1]);
    if (/^\s*isAdminRightsRequired:\s*true\s*$/.test(line)) out.hasAdminFlag = true;
  }
  return out;
}

export function stripAdminFlag(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*isAdminRightsRequired:\s*true\s*$/.test(line))
    .join('\n')
    .replace(/\n*$/, '\n');
}

export function verifyMetadata(meta, { dist, pkgVersion, expectVersion, hashFile }) {
  const problems = [];
  if (!meta.version) problems.push('latest.yml has no version');
  if (pkgVersion && meta.version && meta.version !== pkgVersion) problems.push(`latest.yml version ${meta.version} != package.json ${pkgVersion}`);
  if (expectVersion && meta.version !== expectVersion) problems.push(`latest.yml version ${meta.version} != expected ${expectVersion}`);
  if (!meta.path) problems.push('latest.yml has no path');
  if (meta.path && meta.version && meta.path !== `1132-Fixer-Setup-${meta.version}.exe`) problems.push(`latest.yml path ${meta.path} does not match 1132-Fixer-Setup-${meta.version}.exe`);
  if (!meta.files.length) problems.push('latest.yml lists no files');
  for (const f of meta.files) {
    const file = path.join(dist, f.url);
    if (!fs.existsSync(file)) { problems.push(`${f.url}: not in ${dist}`); continue; }
    const actual = hashFile(file);
    if (f.size !== actual.size) problems.push(`${f.url}: size ${f.size} != on-disk ${actual.size}`);
    if (f.sha512 !== actual.sha512) problems.push(`${f.url}: sha512 does not match the file on disk`);
    if (f.url === meta.path && meta.sha512 !== actual.sha512) problems.push('top-level sha512 does not match the installer on disk');
  }
  if (meta.hasAdminFlag) problems.push('isAdminRightsRequired: true is present (clients 6.3.1–6.3.3 cannot install with it; run without --check to strip it)');
  return problems;
}

export function hashFileSync(file) {
  const buf = fs.readFileSync(file);
  return { size: buf.length, sha512: crypto.createHash('sha512').update(buf).digest('base64') };
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`FAIL: ${FILE} does not exist`);
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let text = fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '');
  const before = parseLatestYml(text);
  if (before.hasAdminFlag && !CHECK_ONLY) {
    text = stripAdminFlag(text);
    console.log('latest.yml: removed isAdminRightsRequired (elevate.exe is not shipped; the app runs elevated and starts the installer itself)');
  } else if (!CHECK_ONLY) {
    text = text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  }
  const meta = parseLatestYml(text);
  const problems = verifyMetadata(meta, { dist: DIST, pkgVersion: pkg.version, expectVersion: EXPECT_VERSION, hashFile: hashFileSync });
  for (const p of problems) console.error(`FAIL: ${p}`);
  if (problems.length) process.exit(1);
  if (!CHECK_ONLY) fs.writeFileSync(FILE, text, { encoding: 'utf8' });
  console.log(`OK: latest.yml version ${meta.version}, ${meta.files.length} file(s) verified against ${DIST}${CHECK_ONLY ? ' (check only)' : ''}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) main();
