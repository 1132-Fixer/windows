#!/usr/bin/env node
// Release checksum manifest: dist/checksums-sha256.txt.
//
//   node scripts/generate-checksums.mjs [--dist <dir>] [--out <file>]
//   node scripts/generate-checksums.mjs --verify [--dist <dir>] [--out <file>]
//
// Generates the manifest for every *.exe in --dist (default: dist), and in
// --verify mode reads the manifest back as BYTES and proves it is usable as
// published. The format is the coreutils one, so
//
//   sha256sum -c checksums-sha256.txt
//
// succeeds on the file exactly as attached to the GitHub Release:
//
//   - one record per line: "<64 lowercase hex>  <asset filename>"
//   - LF ("\n") separators, a final LF after the last record
//   - UTF-8 without a byte-order mark
//   - records sorted by filename (byte order) so the manifest is deterministic
//
// This used to be a PowerShell step in release.yml that piped an array
// through Out-File. On the windows-latest runner that writes CRLF, so every
// filename in the published manifest carried a trailing "\r" and sha256sum
// reported "No such file or directory" for each line (releases up to 6.3.3).
// The bytes are now written explicitly here; nothing depends on a platform
// default, an editor setting, or Git line-ending normalisation (this file is
// a build output, never a tracked blob).
//
// Exported for tools/release-checksums-smoke.js, which asserts the bytes and
// runs sha256sum -c on the generated file. release.yml and ci.yml call this
// script; the release workflow contains no other checksum writer.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_NAME = 'checksums-sha256.txt';
const RECORD_RE = /^([0-9a-f]{64})  (\S[^\r\n]*)$/;

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// The asset set the manifest covers: every .exe directly under dist, sorted
// by name using code-point order (locale-independent, so the same input
// yields the same manifest on every runner).
export function listAssets(distDir) {
  return readdirSync(distDir)
    .filter((name) => name.toLowerCase().endsWith('.exe') && statSync(path.join(distDir, name)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Builds the manifest text for the given assets. Pure: no I/O beyond hashing.
export function buildManifest(distDir, assets) {
  return assets.map((name) => `${sha256File(path.join(distDir, name))}  ${name}\n`).join('');
}

export function writeManifest(distDir, outFile) {
  const assets = listAssets(distDir);
  if (assets.length === 0) throw new Error(`no .exe files in ${distDir}`);
  const text = buildManifest(distDir, assets);
  // Buffer.from(..., 'utf8') never emits a BOM; "\n" is the only separator.
  writeFileSync(outFile, Buffer.from(text, 'utf8'));
  return { assets, text };
}

// Byte-level verification of a manifest file. Returns { ok, report, errors }.
// `report` carries the numbers the release evidence must state.
export function verifyManifest(distDir, manifestFile) {
  const errors = [];
  const bytes = readFileSync(manifestFile);
  const report = {
    file: manifestFile,
    bytes: bytes.length,
    crBytes: 0,
    lfBytes: 0,
    bom: bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
    finalLf: bytes.length > 0 && bytes[bytes.length - 1] === 0x0A,
    entries: 0,
    sorted: true,
    matched: [],
    mismatched: [],
    missing: []
  };
  for (const b of bytes) {
    if (b === 0x0D) report.crBytes++;
    if (b === 0x0A) report.lfBytes++;
  }
  if (report.bom) errors.push('manifest starts with a UTF-8 BOM');
  if (report.crBytes) errors.push(`manifest contains ${report.crBytes} CR byte(s); sha256sum -c cannot read CRLF records`);
  if (!report.finalLf) errors.push('manifest does not end with LF');
  if (report.lfBytes === 0) errors.push('manifest has no LF separators');

  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const names = [];
  for (const line of lines) {
    const m = RECORD_RE.exec(line);
    if (!m) { errors.push(`malformed record: ${JSON.stringify(line)}`); continue; }
    const [, hash, name] = m;
    names.push(name);
    const file = path.join(distDir, name);
    if (!existsSync(file)) { report.missing.push(name); errors.push(`referenced asset missing: ${name}`); continue; }
    const actual = sha256File(file);
    if (actual === hash) report.matched.push(name);
    else { report.mismatched.push(name); errors.push(`hash mismatch for ${name}: manifest ${hash}, file ${actual}`); }
  }
  report.entries = names.length;
  const sortedNames = names.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  report.sorted = names.join('\n') === sortedNames.join('\n');
  if (!report.sorted) errors.push('records are not in sorted filename order');
  if (new Set(names).size !== names.length) errors.push('duplicate asset names in manifest');
  // Every shipped .exe must be covered.
  if (existsSync(distDir)) {
    for (const name of listAssets(distDir)) {
      if (!names.includes(name)) errors.push(`no record for shipped asset ${name}`);
    }
  }
  return { ok: errors.length === 0, report, errors };
}

function argOf(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const distDir = path.resolve(argOf('--dist', 'dist'));
  const outFile = path.resolve(argOf('--out', path.join(distDir, MANIFEST_NAME)));
  if (process.argv.includes('--verify')) {
    const { ok, report, errors } = verifyManifest(distDir, outFile);
    console.log(`checksums: ${outFile}`);
    console.log(`  bytes=${report.bytes} CR=${report.crBytes} LF=${report.lfBytes} BOM=${report.bom} finalLF=${report.finalLf} entries=${report.entries} sorted=${report.sorted}`);
    for (const n of report.matched) console.log(`  ok    ${n}`);
    for (const e of errors) console.error(`  FAIL  ${e}`);
    if (!ok) { console.error(`checksums: ${errors.length} problem(s)`); process.exit(1); }
    console.log('checksums: manifest verified (LF, no BOM, every hash matches)');
  } else {
    const { assets, text } = writeManifest(distDir, outFile);
    process.stdout.write(text);
    console.log(`checksums: wrote ${assets.length} record(s) to ${outFile} (LF, UTF-8, no BOM)`);
  }
}
