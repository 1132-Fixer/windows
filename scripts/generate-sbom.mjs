#!/usr/bin/env node
// Generates an SPDX 2.3 JSON software bill of materials for the Windows build.
//
//   node scripts/generate-sbom.mjs
//   node scripts/generate-sbom.mjs --out dist/sbom.spdx.json
//
// Covers the first-party application, every npm package in the lockfile, the
// Electron runtime, the builder, and any native component recorded in
// dist/package-inventory.json.
//
// Two distinctions the output keeps explicit, because collapsing them is how
// an SBOM ends up lying:
//
//   - A package that SHIPS is CONTAINED_BY the application. A package that only
//     builds it is a BUILD_DEPENDENCY_OF. electron is a devDependency whose
//     runtime binaries ship, so it is recorded as contained, not as a build
//     dependency.
//   - Native binaries that electron-builder fetches outside the lockfile are
//     listed from the package inventory with their real hashes, because the
//     lockfile cannot see them.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..'
);
const OUT = path.resolve(argOf('--out', path.join(REPO_ROOT, 'dist', 'sbom.spdx.json')));
const INVENTORY = path.resolve(argOf('--inventory', path.join(REPO_ROOT, 'dist', 'package-inventory.json')));

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));

// devDependencies whose build output is shipped to users. Electron is the only
// one: the npm package is a build-time install, but its runtime binaries are
// the application host.
const SHIPPED_DEV_PACKAGES = new Set(['electron']);

function commitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// npm records integrity as "sha512-<base64>"; SPDX wants the algorithm name and
// a hex digest.
function integrityToChecksum(integrity) {
  if (!integrity) return [];
  const [algo, b64] = integrity.split('-', 2);
  if (!algo || !b64) return [];
  const known = { sha512: 'SHA512', sha256: 'SHA256', sha1: 'SHA1' };
  if (!known[algo]) return [];
  return [{ algorithm: known[algo], checksumValue: Buffer.from(b64, 'base64').toString('hex') }];
}

const usedIds = new Set();
function spdxId(prefix, name, version) {
  const base = `SPDXRef-${prefix}-${`${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, '-')}`;
  let id = base;
  let n = 2;
  while (usedIds.has(id)) id = `${base}-${n++}`;
  usedIds.add(id);
  return id;
}

const packages = [];
const relationships = [];

// ---------------------------------------------------------------- root package
const ROOT_ID = spdxId('Package', pkg.name, pkg.version);
packages.push({
  SPDXID: ROOT_ID,
  name: pkg.name,
  versionInfo: pkg.version,
  downloadLocation: pkg.repository?.url ?? 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: pkg.license ?? 'NOASSERTION',
  licenseDeclared: pkg.license ?? 'NOASSERTION',
  copyrightText: pkg.build?.copyright ?? 'NOASSERTION',
  supplier: `Organization: ${pkg.build?.win?.signtoolOptions?.publisherName ??
    pkg.build?.win?.publisherName ??
    pkg.author ??
    'NOASSERTION'}`,
  primaryPackagePurpose: 'APPLICATION',
  externalRefs: [
    {
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: `pkg:npm/${pkg.name}@${pkg.version}`,
    },
  ],
});
relationships.push({
  spdxElementId: 'SPDXRef-DOCUMENT',
  relationshipType: 'DESCRIBES',
  relatedSpdxElement: ROOT_ID,
});

// ------------------------------------------------------------- npm dependencies
let shippedCount = 0;
let buildCount = 0;

for (const [lockPath, entry] of Object.entries(lock.packages)) {
  if (!lockPath.startsWith('node_modules/')) continue;

  const name = entry.name ?? lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const version = entry.version ?? 'NOASSERTION';
  const ships = !entry.dev || SHIPPED_DEV_PACKAGES.has(name);

  const id = spdxId('Package', name, version);
  packages.push({
    SPDXID: id,
    name,
    versionInfo: version,
    downloadLocation: entry.resolved ?? 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: entry.license ?? 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    supplier: 'NOASSERTION',
    primaryPackagePurpose: 'LIBRARY',
    checksums: integrityToChecksum(entry.integrity),
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/${name}@${version}`,
      },
    ],
  });

  if (ships) {
    shippedCount += 1;
    relationships.push({ spdxElementId: id, relationshipType: 'CONTAINED_BY', relatedSpdxElement: ROOT_ID });
  } else {
    buildCount += 1;
    relationships.push({ spdxElementId: id, relationshipType: 'BUILD_DEPENDENCY_OF', relatedSpdxElement: ROOT_ID });
  }
}

// ------------------------------------------------- native components, if built
// These come from the package inventory rather than the lockfile, because
// electron-builder fetches them at build time into a machine-level cache.
let nativeCount = 0;
if (existsSync(INVENTORY)) {
  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const nativeExtensions = new Set(['.exe', '.dll', '.node', '.sys']);
  for (const f of inventory.unpacked ?? []) {
    if (!nativeExtensions.has(path.extname(f.path).toLowerCase())) continue;
    nativeCount += 1;
    const id = spdxId('File', path.basename(f.path), 'binary');
    packages.push({
      SPDXID: id,
      name: f.path,
      versionInfo: 'NOASSERTION',
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      supplier: 'NOASSERTION',
      primaryPackagePurpose: 'FILE',
      checksums: [{ algorithm: 'SHA256', checksumValue: f.sha256 }],
      comment: 'Shipped binary, enumerated from the built package rather than the lockfile. Provenance: docs/security/BINARY-POLICY.md',
    });
    relationships.push({ spdxElementId: id, relationshipType: 'CONTAINED_BY', relatedSpdxElement: ROOT_ID });
  }
} else {
  console.warn(`WARN: ${INVENTORY} not found — SBOM covers npm packages only.`);
  console.warn('      Run scripts/package-inventory.mjs first to include shipped binaries.');
}

const sha = commitSha();
const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `${pkg.name}-${pkg.version}`,
  documentNamespace: `https://github.com/1132-Fixer/windows/spdx/${pkg.version}/${sha}`,
  creationInfo: {
    created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    creators: ['Tool: 1132-fixer-generate-sbom', 'Organization: 1132 Fixer'],
    comment: `Generated from package-lock.json (lockfileVersion ${lock.lockfileVersion}) at commit ${sha}.`,
  },
  packages,
  relationships,
};

writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);

console.log(`SBOM written to ${OUT}`);
console.log(`  application     : 1`);
console.log(`  shipped packages: ${shippedCount}`);
console.log(`  build-only      : ${buildCount}`);
console.log(`  native binaries : ${nativeCount}`);
console.log(`  relationships   : ${relationships.length}`);
