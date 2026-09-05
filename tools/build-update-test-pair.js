'use strict';

/**
 * Builds the two installers the packaged update acceptance needs:
 * version A (installed first) and version B (served as the update).
 *
 *   node tools/build-update-test-pair.js [--a 6.9.0] [--b 6.9.1]
 *                                        [--feed http://127.0.0.1:47831/]
 *                                        [--out update-acceptance/builds]
 *
 * Both are real NSIS builds from this working tree (same afterPack, same
 * installer.nsh, same per-machine one-click configuration) with one
 * difference from a release: `build.publish` is overridden to a generic
 * provider at --feed, so electron-updater in version A resolves latest.yml
 * from the local server tools/packaged-update-acceptance.js runs instead of
 * GitHub Releases. The update mechanism itself (electron-updater check and
 * download, the app's own verification and handoff, the NSIS silent update
 * and relaunch) is identical to production.
 *
 * package.json's version is edited for each build and restored afterwards
 * (also on failure). dist/ is left holding the last build; the artifacts
 * that matter are copied to <out>/A and <out>/B.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const A = argOf('--a', '6.9.0');
const B = argOf('--b', '6.9.1');
const FEED = argOf('--feed', 'http://127.0.0.1:47831/');
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'update-acceptance', 'builds')));

const pkgPath = path.join(ROOT, 'package.json');
const original = fs.readFileSync(pkgPath, 'utf8');
const lockPath = path.join(ROOT, 'package-lock.json');
const originalLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;

function setVersion(v) {
  const pkg = JSON.parse(original);
  pkg.version = v;
  // A CLI `-c.publish.provider=generic` merges onto the GitHub publish block
  // (owner/repo stay) and fails schema validation; replace the block whole.
  pkg.build.publish = { provider: 'generic', url: FEED };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
function restore() {
  fs.writeFileSync(pkgPath, original);
  if (originalLock !== null) fs.writeFileSync(lockPath, originalLock);
}

function run(cmd, cmdArgs, label) {
  console.log(`\n[build-pair] ${label}: ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${label} failed with exit ${r.status}`);
}

function buildOne(version, label) {
  setVersion(version);
  run('node', ['scripts/inject-config.js'], `${label} inject-config`);
  run('npx', ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'], `${label} electron-builder`);
  run('node', ['scripts/finalize-update-metadata.mjs', '--dist', 'dist', '--expect-version', version], `${label} finalize-update-metadata`);
  const dest = path.join(OUT, label);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const setup = `1132-Fixer-Setup-${version}.exe`;
  for (const name of [setup, `${setup}.blockmap`, 'latest.yml']) {
    const src = path.join(ROOT, 'dist', name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, name));
  }
  const unpackedYml = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app-update.yml');
  if (fs.existsSync(unpackedYml)) fs.copyFileSync(unpackedYml, path.join(dest, 'app-update.yml'));
  console.log(`[build-pair] ${label} = ${version} → ${dest}`);
  return { version, dir: dest, setup: path.join(dest, setup), latestYml: path.join(dest, 'latest.yml') };
}

try {
  const a = buildOne(A, 'A');
  const b = buildOne(B, 'B');
  fs.writeFileSync(path.join(OUT, 'pair.json'), JSON.stringify({ feed: FEED, a, b, builtAt: new Date().toISOString() }, null, 2));
  console.log(`\n[build-pair] done: A=${A} B=${B} feed=${FEED}`);
} catch (err) {
  console.error(`[build-pair] ${err.message}`);
  process.exitCode = 1;
} finally {
  restore();
  console.log('[build-pair] package.json restored');
}
