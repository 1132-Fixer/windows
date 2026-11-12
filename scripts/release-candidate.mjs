#!/usr/bin/env node
/** Generate or verify the exact, reusable release-candidate asset set. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hashFile(file) {
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function expectedNames(version, names) {
  const fixed = [
    `1132-Fixer-Setup-${version}.exe`,
    `1132-Fixer-Portable-${version}.exe`,
    'checksums-sha256.txt',
    'latest.yml',
    'signature-state.json',
    'package-inventory.json',
    'sbom.spdx.json',
    'provenance.json'
  ];
  const blockmaps = names.filter(name => name.endsWith('.blockmap')).sort();
  if (!blockmaps.length) fail('candidate-blockmap-missing');
  return [...fixed, ...blockmaps].sort();
}

export function generateCandidateManifest({ dist, head, version }) {
  if (!SHA40.test(head || '')) fail('candidate-head-invalid');
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(version || '')) fail('candidate-version-invalid');
  const names = fs.readdirSync(dist, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
  const selected = expectedNames(version, names);
  for (const name of selected) if (!names.includes(name)) fail('candidate-asset-missing');
  return {
    schemaVersion: 1,
    sourceHead: head,
    version,
    assets: selected.map(name => ({ name, ...hashFile(path.join(dist, name)) }))
  };
}

export function verifyCandidateManifest({ dist, manifest, head, version, setupSha256, portableSha256 }) {
  const keys = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? Object.keys(manifest).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify(['assets', 'schemaVersion', 'sourceHead', 'version'])) fail('candidate-manifest-shape');
  if (manifest.schemaVersion !== 1 || manifest.sourceHead !== head || manifest.version !== version || !SHA40.test(head || '')) {
    fail('candidate-manifest-identity');
  }
  if (!Array.isArray(manifest.assets)) fail('candidate-assets-invalid');
  const names = manifest.assets.map(asset => asset && asset.name);
  const expected = expectedNames(version, names);
  if (names.length !== expected.length || JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
    fail('candidate-asset-set');
  }
  const seen = new Set();
  for (const asset of manifest.assets) {
    const assetKeys = asset && typeof asset === 'object' && !Array.isArray(asset)
      ? Object.keys(asset).sort() : [];
    if (JSON.stringify(assetKeys) !== JSON.stringify(['name', 'sha256', 'size']) || seen.has(asset.name) ||
        !SHA64.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size) || asset.size < 1) fail('candidate-asset-record');
    seen.add(asset.name);
    const fullPath = path.join(dist, asset.name);
    if (path.dirname(fullPath) !== path.resolve(dist) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      fail('candidate-asset-path');
    }
    const actual = hashFile(fullPath);
    if (actual.size !== asset.size || actual.sha256 !== asset.sha256) fail('candidate-asset-digest');
  }
  const setup = manifest.assets.find(asset => asset.name === `1132-Fixer-Setup-${version}.exe`);
  const portable = manifest.assets.find(asset => asset.name === `1132-Fixer-Portable-${version}.exe`);
  if (!SHA64.test(setupSha256 || '') || setup.sha256 !== setupSha256) fail('candidate-setup-mismatch');
  if (!SHA64.test(portableSha256 || '') || portable.sha256 !== portableSha256) fail('candidate-portable-mismatch');
  return manifest;
}

async function main() {
  const dist = path.resolve(argOf('--dist', path.join(ROOT, 'dist')));
  const head = argOf('--head', process.env.GITHUB_SHA || '');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = argOf('--version', pkg.version);
  const manifestFile = path.join(dist, 'release-candidate.json');
  if (process.argv.includes('--verify')) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    verifyCandidateManifest({
      dist, manifest, head, version,
      setupSha256: argOf('--setup-sha256'),
      portableSha256: argOf('--portable-sha256')
    });
    console.log(`[release-candidate] verified ${manifest.assets.length} exact assets for ${head}`);
    return;
  }
  const manifest = generateCandidateManifest({ dist, head, version });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[release-candidate] recorded ${manifest.assets.length} exact assets for ${head}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[release-candidate] ${error && error.code || 'candidate-invalid'}`);
    process.exitCode = 1;
  });
}
