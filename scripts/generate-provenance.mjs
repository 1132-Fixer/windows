#!/usr/bin/env node
// Records how the shipped artifacts were built, into dist/provenance.json.
//
//   node scripts/generate-provenance.mjs
//   node scripts/generate-provenance.mjs --dist <dir> --out <file>
//
// WHAT THIS IS NOT: it is not a signed attestation. Nothing here is
// cryptographically bound to the build. It is published metadata, and anyone
// who can modify the release can modify it too — exactly like
// checksums-sha256.txt. It is useful for answering "which commit, which runner,
// which toolchain produced this file", and useless as proof of origin against
// an attacker who controls the release. The document says so in its own
// `disclaimer` field so a reader cannot mistake it for an attestation.
//
// Real origin proof needs code signing (docs/security/code-signing.md).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
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
const DIST = path.resolve(argOf('--dist', path.join(REPO_ROOT, 'dist')));
const OUT = path.resolve(argOf('--out', path.join(DIST, 'provenance.json')));

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));

const lockVersion = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;

function git(...a) {
  try {
    return execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// npm is a .cmd shim on Windows. Name it directly rather than going through a
// shell — execFileSync with shell:true concatenates arguments unescaped.
function npmVersion() {
  try {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return execFileSync(cmd, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const artifacts = readdirSync(DIST)
  .filter((f) => /\.(exe|yml|txt|blockmap|json)$/i.test(f) && f !== path.basename(OUT))
  .sort()
  .map((name) => {
    const p = path.join(DIST, name);
    return {
      name,
      size: statSync(p).size,
      sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
    };
  });

// Fold in the signature state rather than restating it, so the two documents
// cannot drift apart.
const sigStatePath = path.join(DIST, 'signature-state.json');
const signatureState = existsSync(sigStatePath)
  ? JSON.parse(readFileSync(sigStatePath, 'utf8'))
  : null;

const provenance = {
  schema: '1132-fixer/provenance/v1',
  disclaimer:
    'Unsigned build metadata. Not an attestation. Anyone able to modify this release can modify this file. ' +
    'Origin can only be proven by a code signature — see docs/security/code-signing.md.',
  generatedAt: new Date().toISOString(),

  product: {
    name: pkg.name,
    version: pkg.version,
    publisherName: pkg.build?.win?.publisherName ?? null,
  },

  source: {
    repository: process.env.GITHUB_REPOSITORY ?? '1132-Fixer/windows',
    commit: process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD'),
    ref: process.env.GITHUB_REF ?? git('rev-parse', '--abbrev-ref', 'HEAD'),
    commitDate: git('log', '-1', '--format=%cI'),
  },

  build: {
    // Null everywhere means a local build, which is itself worth recording.
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    runUrl:
      process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    runnerOs: process.env.RUNNER_OS ?? process.platform,
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    hosted: Boolean(process.env.GITHUB_ACTIONS),
  },

  toolchain: {
    node: process.version,
    npm: npmVersion(),
    electron: lockVersion('electron'),
    electronBuilder: lockVersion('electron-builder'),
    electronUpdater: lockVersion('electron-updater'),
    lockfileVersion: lock.lockfileVersion,
  },

  signing: signatureState
    ? {
        overall: signatureState.overall,
        verifyUpdateCodeSignature: signatureState.verifyUpdateCodeSignature,
        certificateConfigured: signatureState.certificateConfigured,
        artifacts: signatureState.artifacts.map((a) => ({
          file: a.file,
          status: a.status,
          signer: a.commonName,
          timestamped: a.timestamped,
        })),
      }
    : { overall: 'UNKNOWN', note: 'signature-state.json not present; run scripts/check-signature-state.mjs first' },

  artifacts,
};

writeFileSync(OUT, `${JSON.stringify(provenance, null, 2)}\n`);

console.log(`Provenance written to ${OUT}`);
console.log(`  commit    : ${provenance.source.commit}`);
console.log(`  build     : ${provenance.build.hosted ? provenance.build.runUrl : 'local'}`);
console.log(`  signing   : ${provenance.signing.overall}`);
console.log(`  artifacts : ${artifacts.length}`);
