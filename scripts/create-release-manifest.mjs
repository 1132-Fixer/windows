#!/usr/bin/env node
// Capture the exact local release bytes BEFORE upload. This is a local,
// CreateNew+file-flush+readback operation, not a distributed lease, atomic
// shared publication, signed origin attestation or native acceptance.
//
// node scripts/create-release-manifest.mjs --dist dist --tag vX.Y.Z \
//   --source <full-HEAD-SHA> --out <path-outside-dist.json>
//
// Only the nine explicit upload files are captured. Known electron-builder
// scratch entries may remain but are never uploaded; unknown entries fail.
// Output is never overwritten or deleted on failure. A failed output attempt
// must be read back and reconciled before choosing any retry path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizeReleaseAssetManifest, RELEASE_REPOSITORY } from './validate-release-assets.mjs';
import powershell7 from '../src/main/powershell7.js';
import supportClient from '../src/main/support-client.js';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const SCRATCH_FILES = new Set(['builder-debug.yml', 'builder-effective-config.yaml']);
const SCRATCH_DIRECTORY = 'win-unpacked';
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const HASH40 = /^[0-9a-f]{40}$/;
const HASH256 = /^[0-9a-f]{64}$/;
const CLEAN_REASON = 'tracked-head-equal-and-untracked-policy-verified';
const GENERATED_CONFIG = 'src/main/config.generated.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ReleaseManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseManifestError';
    this.code = code;
  }
}
function requireProof(value, code, message) {
  if (!value) throw new ReleaseManifestError(code, message);
}
function fileName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) &&
    !/[. ]$/.test(value) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
}
function fullPath(value) {
  requireProof(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0'),
    'path_invalid', 'An explicit bounded filesystem path is required.');
  if (process.platform === 'win32') requireProof(!/^\\\\|^[\\/]{2}|^[A-Za-z]:(?![\\/])/.test(value) &&
    !value.slice(/^[A-Za-z]:/.test(value) ? 2 : 0).includes(':'), 'path_invalid',
  'UNC, device, drive-relative and alternate-stream paths are refused.');
  return path.resolve(value);
}
function stableVersion(tag) {
  const match = typeof tag === 'string' && tag.length <= 48 && STABLE_TAG.exec(tag);
  requireProof(match && match.slice(1).every(part => Number.isSafeInteger(Number(part))),
    'stable_tag_required', 'A canonical stable vX.Y.Z tag is required.');
  return tag.slice(1);
}
function releaseNames(version) {
  const setup = `1132-Fixer-Setup-${version}.exe`;
  return [setup, `1132-Fixer-Portable-${version}.exe`, setup + '.blockmap', 'latest.yml',
    'checksums-sha256.txt', 'signature-state.json', 'package-inventory.json', 'sbom.spdx.json', 'provenance.json'];
}
function pathPhysical(target, expectedKind) {
  let cursor = target;
  while (true) {
    const stat = fs.lstatSync(cursor, { bigint: true });
    requireProof(!stat.isSymbolicLink(), 'reparse_path_refused', 'A linked path or ancestor was refused.');
    if (cursor === target && expectedKind === 'directory') requireProof(stat.isDirectory(), 'directory_required', 'An existing physical directory is required.');
    if (cursor !== target) requireProof(stat.isDirectory(), 'directory_required', 'Every ancestor must be a physical directory.');
    const real = fs.realpathSync.native(cursor);
    requireProof(samePath(path.resolve(real), path.resolve(cursor)), 'reparse_path_refused', 'A physical path differs from its requested path.');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function fileIdentity(stat) {
  requireProof(stat.isFile() && stat.ino > 0n && stat.nlink === 1n && stat.size > 0n &&
    [stat.dev, stat.mode, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].every(value => typeof value === 'bigint'),
    'regular_file_required', 'Release inputs must be nonempty, single-link regular files with a usable file identity.');
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}
function directoryIdentity(stat) {
  requireProof(stat.isDirectory() && stat.ino > 0n, 'directory_required', 'A physical directory identity is required.');
  return [stat.dev, stat.ino, stat.mode].map(String).join(':');
}
function canonicalRemote(value) {
  return typeof value === 'string' && /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)1132-Fixer\/windows(?:\.git)?\/?$/i.test(value);
}
function relativeWithin(sourceRoot, target) {
  if (typeof target !== 'string') return null;
  const relative = path.relative(sourceRoot, fullPath(target));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}
function safeGitRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) return false;
  const pieces = value.replace(/\/$/, '').split('/');
  return pieces.every(piece => piece && piece !== '.' && piece !== '..');
}
// No --exclude-standard: Git ignore patterns, private excludes and global
// ignores cannot silently hide untracked source from a release. These are the
// ONLY admitted untracked locations, and dist still has its nine-file guard.
export function checkUntrackedReleaseInputs({ entries, sourceRoot, distPath, outputPath, generatedConfigProof } = {}) {
  requireProof(Array.isArray(entries) && entries.length <= 4096 && typeof sourceRoot === 'string',
    'untracked_proof_invalid', 'The untracked-source inventory is missing or oversized.');
  const distRelative = relativeWithin(sourceRoot, distPath), outputRelative = relativeWithin(sourceRoot, outputPath);
  requireProof(!samePath(sourceRoot, fullPath(distPath)), 'untracked_policy_invalid', 'The whole checkout cannot be declared build scratch.');
  const seen = new Set();
  for (const entry of entries) {
    requireProof(safeGitRelative(entry) && !seen.has(entry), 'untracked_proof_invalid', 'The untracked-source inventory is ambiguous or unsafe.');
    seen.add(entry);
    const directory = entry.endsWith('/'), plain = directory ? entry.slice(0, -1) : entry;
    const buildScratch = plain === 'node_modules' && directory || entry.startsWith('node_modules/') ||
      distRelative && (plain === distRelative && directory || entry.startsWith(distRelative + '/'));
    if (buildScratch || outputRelative && !directory && entry === outputRelative) continue;
    if (entry === GENERATED_CONFIG && generatedConfigProof && generatedConfigProof.ignored === true &&
      generatedConfigProof.untracked === true && generatedConfigProof.bodyVerified === true &&
      typeof generatedConfigProof.sha256 === 'string' && HASH256.test(generatedConfigProof.sha256)) continue;
    return { clean: false, reason: 'undeclared-untracked-source' };
  }
  return { clean: true, reason: 'explicit-build-input-policy', distRelative, outputRelative,
    generatedConfigSha256: generatedConfigProof ? generatedConfigProof.sha256 : null };
}
function readGeneratedConfigProof({ sourceRoot, git }) {
  const tracked = git(['ls-files', '--error-unmatch', '--', GENERATED_CONFIG], [0, 1]);
  requireProof(tracked.status === 1, 'generated_config_tracking_invalid', 'The build-generated public config must remain untracked.');
  const ignored = git(['check-ignore', '--quiet', '--no-index', '--', GENERATED_CONFIG], [0, 1]);
  requireProof(ignored.status === 0, 'generated_config_tracking_invalid', 'The declared generated config is not ignored by the checkout contract.');
  const ignoreFile = fs.readFileSync(path.join(sourceRoot, '.gitignore'), 'utf8');
  requireProof(ignoreFile.split(/\r?\n/).some(line => line.trim() === GENERATED_CONFIG),
    'generated_config_tracking_invalid', 'The generated config lacks its exact maintained ignore declaration.');
  const input = process.env.FEEDBACK_PROXY_URL, empty = input === undefined || input === '';
  const endpoint = supportClient.endpointUrl(input);
  requireProof(empty || endpoint, 'generated_config_input_invalid', 'The public build endpoint does not satisfy the maintained configuration contract.');
  const normalized = endpoint ? endpoint.href : '';
  const expected = Buffer.from('// AUTO-GENERATED. Public configuration only. DO NOT COMMIT.\nmodule.exports = ' +
    JSON.stringify({ FEEDBACK_PROXY_URL: normalized, FEEDBACK_CONFIG_REVISION: supportClient.supportConfigRevision(normalized) }, null, 2) + ';\n', 'utf8');
  const target = path.join(sourceRoot, ...GENERATED_CONFIG.split('/'));
  pathPhysical(target);
  const proof = inspectReleasePaths([target]);
  requireProof(record(proof) && proof.schema === '1132-release-physical-paths/1' && Array.isArray(proof.paths) &&
    proof.paths.length === 1 && samePath(proof.paths[0].path, target) && proof.paths[0].nonReparse === true,
  'generated_config_path_unverified', 'The generated config physical path was not verified.');
  const initial = fs.lstatSync(target, { bigint: true }), identity = fileIdentity(initial);
  requireProof(initial.size <= 65536n, 'generated_config_invalid', 'The generated public config is oversized.');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    requireProof(fileIdentity(fs.fstatSync(fd, { bigint: true })) === identity,
      'generated_config_changed', 'The generated config identity changed during validation.');
    const bytes = Buffer.alloc(Number(initial.size)); let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      requireProof(read > 0, 'generated_config_changed', 'The generated config read was incomplete.'); count += read;
    }
    requireProof(bytes.equals(expected) && fileIdentity(fs.fstatSync(fd, { bigint: true })) === identity &&
      fileIdentity(fs.lstatSync(target, { bigint: true })) === identity,
    'generated_config_invalid', 'The generated config does not match the exact public build input and maintained generator.');
    return { ignored: true, untracked: true, bodyVerified: true, sha256: hash(bytes) };
  } finally { fs.closeSync(fd); }
}
// Real CLI adapter: read only, bounded, no shell, no Git mutation or alternate
// checkout search. An unavailable source is not silently treated as verified.
export function readReleaseSource({ sourceRoot, distPath, outputPath }) {
  requireProof(fs.existsSync(path.join(sourceRoot, '.git')), 'source_checkout_unavailable', 'The source checkout is unavailable.');
  function git(args, accepted = [0]) {
    const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    // Command-scoped cache/monitor settings avoid stale status and hook effects;
    // no index flag, config, worktree, security policy or source is changed.
    const command = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', sourceRoot, ...args];
    try { return { status: 0, stdout: execFileSync('git', command, options) }; }
    catch (error) {
      if (Number.isInteger(error.status) && accepted.includes(error.status) && !error.signal && typeof error.stdout === 'string')
        return { status: error.status, stdout: error.stdout };
      throw new ReleaseManifestError('source_read_failed', 'The bounded source identity/status read failed.');
    }
  }
  const root = git(['rev-parse', '--show-toplevel']).stdout.trim();
  const head = git(['rev-parse', '--verify', 'HEAD']).stdout.trim();
  const remote = git(['config', '--get', 'remote.origin.url']).stdout.trim();
  requireProof(canonicalRemote(remote), 'source_repository_mismatch', 'The source origin is not the canonical Windows repository.');
  const base = { available: true, repository: RELEASE_REPOSITORY, root: path.resolve(root), head, cleanHead: head };
  const diff = git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', 'HEAD', '--'], [0, 1]);
  if (diff.status === 1) return { ...base, clean: false, cleanReason: 'tracked-source-differs-from-head' };
  // Assume-unchanged/skip-worktree must not hide packaged source from diff.
  const indexed = git(['ls-files', '-v', '-z']).stdout;
  requireProof(indexed === '' || indexed.endsWith('\0'), 'source_status_invalid', 'The index flag inventory was incomplete.');
  if (indexed && indexed.slice(0, -1).split('\0').some(entry => !entry.startsWith('H ')))
    return { ...base, clean: false, cleanReason: 'source-index-flags-unverified' };
  const listing = git(['ls-files', '--others', '--directory', '--no-empty-directory', '-z']).stdout;
  requireProof(listing === '' || listing.endsWith('\0'), 'untracked_proof_invalid', 'The untracked inventory was incomplete.');
  const entries = listing ? listing.slice(0, -1).split('\0') : [];
  const generatedConfigProof = entries.includes(GENERATED_CONFIG) ? readGeneratedConfigProof({ sourceRoot, git }) : null;
  const policy = checkUntrackedReleaseInputs({ entries, sourceRoot, distPath, outputPath, generatedConfigProof });
  if (!policy.clean) return { ...base, clean: false, cleanReason: policy.reason };
  const finalHead = git(['rev-parse', '--verify', 'HEAD']).stdout.trim();
  requireProof(finalHead === head, 'source_changed', 'HEAD changed during source cleanliness verification.');
  return { ...base, clean: true, cleanReason: CLEAN_REASON,
    cleanFingerprint: hash(Buffer.from(JSON.stringify({ schema: '1132-release-source-clean/1', head,
      dist: policy.distRelative, output: policy.outputRelative, generatedConfigSha256: policy.generatedConfigSha256 }), 'utf8')) };
}
// Node checks symlinks/junctions; PowerShell checks ALL ReparsePoint attributes
// on Windows, including tags not exposed as links by Node. Paths are data in a
// base64 JSON literal on stdin, never interpolated executable script text.
export function inspectReleasePaths(paths) {
  requireProof(Array.isArray(paths) && paths.length > 0 && paths.length <= 32,
    'path_inspection_invalid', 'An explicit bounded path set is required.');
  if (process.platform !== 'win32') {
    for (const target of paths) pathPhysical(target);
    return { schema: '1132-release-physical-paths/1', paths: paths.map(target => ({ path: target, nonReparse: true })) };
  }
  const payload = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
  const script = [
    "if ($PSVersionTable.PSVersion.Major -ne 7) { throw 'PowerShell7 required' }",
    `$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    '$results = @(foreach ($requested in $paths) {',
    '  $cursor = [IO.Path]::GetFullPath([string]$requested)',
    '  $depth = 0',
    '  while ($cursor) {',
    "    if (++$depth -gt 128) { throw 'Path depth bound' }",
    '    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop',
    "    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path refused' }",
    '    $parent = [IO.Path]::GetDirectoryName($cursor)',
    '    if ($parent -eq $cursor) { break }; $cursor = $parent',
    '  }',
    '  [pscustomobject]@{path=[IO.Path]::GetFullPath([string]$requested);nonReparse=$true}',
    '})',
    "[pscustomobject]@{schema='1132-release-physical-paths/1';paths=$results} | ConvertTo-Json -Depth 4 -Compress"
  ].join('\n');
  try {
    const invocation = powershell7.preparePowerShellScript(script);
    const raw = execFileSync(invocation.exe, invocation.args, { input: invocation.input, encoding: 'utf8',
      timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true });
    return JSON.parse(raw);
  } catch { throw new ReleaseManifestError('path_inspection_failed', 'The protected PowerShell7 non-reparse path read failed.'); }
}

// Explicit sourceReader/pathInspector/observer adapters allow isolated real-
// filesystem race fixtures. CLI never accepts adapters from files, env or JSON.
// All source inputs stay open until final verification. Capture is a bounded
// point-in-time check; the uploader must later revalidate actual remote bytes.
export function buildDistReleaseManifest({ dist, tag, sourceSha, out, sourceRoot = SOURCE_ROOT,
  sourceReader = readReleaseSource, pathInspector = inspectReleasePaths, onBoundary,
  maxAssetBytes = MAX_ASSET_BYTES } = {}) {
  const version = stableVersion(tag);
  requireProof(typeof sourceSha === 'string' && HASH40.test(sourceSha), 'source_sha_invalid', 'A full lowercase source SHA is required.');
  requireProof(typeof sourceReader === 'function' && typeof pathInspector === 'function' &&
    (onBoundary === undefined || typeof onBoundary === 'function') && Number.isSafeInteger(maxAssetBytes) && maxAssetBytes > 0 && maxAssetBytes <= MAX_ASSET_BYTES,
  'adapter_invalid', 'Explicit bounded source/path adapters are required.');
  const distPath = fullPath(dist), outputPath = fullPath(out), rootPath = fullPath(sourceRoot);
  requireProof(fileName(path.basename(outputPath)) && outputPath.endsWith('.json'), 'output_path_invalid', 'The output must be an explicitly named JSON file.');
  requireProof(!samePath(distPath, outputPath) && !pathKey(outputPath).startsWith(pathKey(distPath + path.sep)),
    'output_inside_dist', 'The manifest must be outside dist and cannot join its own upload set.');
  pathPhysical(distPath, 'directory'); pathPhysical(rootPath, 'directory'); pathPhysical(path.dirname(outputPath), 'directory');
  requireProof(!fs.existsSync(outputPath), 'output_exists', 'The output already exists; preserve and reconcile it instead of overwriting.');
  const required = releaseNames(version), allowed = new Set(required);
  const handles = [], inspected = new Set([distPath, rootPath, path.dirname(outputPath)]), directoryGuards = new Map();
  let outputFd = null, outputCreated = false, sourceFingerprint = null;
  function guardDirectories(target) {
    let cursor = target;
    while (true) {
      const stat = fs.lstatSync(cursor, { bigint: true });
      if (stat.isDirectory()) {
        const key = pathKey(cursor), identity = directoryIdentity(stat);
        if (directoryGuards.has(key)) requireProof(directoryGuards.get(key) === identity,
          'directory_identity_changed', 'A source or output directory identity changed during capture.');
        else directoryGuards.set(key, identity);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  for (const target of inspected) guardDirectories(target);
  function boundary(phase, extra = {}) {
    if (!onBoundary) return;
    const value = onBoundary(Object.freeze({ phase, ...extra }));
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new ReleaseManifestError('observer_async', 'The capture observer must finish synchronously.');
    }
  }
  function sourceAt(stage) {
    let current;
    try { current = sourceReader({ sourceRoot: rootPath, distPath, outputPath }); }
    catch (error) {
      if (error instanceof ReleaseManifestError) throw error;
      throw new ReleaseManifestError('source_read_failed', 'The source identity read failed.');
    }
    requireProof(record(current) && current.available === true && current.repository === RELEASE_REPOSITORY &&
      typeof current.head === 'string' && HASH40.test(current.head) && typeof current.root === 'string' &&
      samePath(fullPath(current.root), rootPath), 'source_unverified', 'Source availability, canonical repository, root and full HEAD identity must be verified.');
    requireProof(current.head === sourceSha, stage === 'initial' ? 'source_sha_mismatch' : 'source_changed',
      'The actual source HEAD does not match the captured source SHA.');
    requireProof(current.clean !== false, 'source_dirty', 'Tracked, staged or undeclared untracked source differs from the required HEAD build.');
    requireProof(current.clean === true && current.cleanHead === current.head && current.cleanReason === CLEAN_REASON &&
      typeof current.cleanFingerprint === 'string' && HASH256.test(current.cleanFingerprint),
    'source_clean_unverified', 'A fresh HEAD-bound tracked and untracked source cleanliness proof is required.');
    if (sourceFingerprint === null) sourceFingerprint = current.cleanFingerprint;
    else requireProof(current.cleanFingerprint === sourceFingerprint, 'source_changed', 'The admitted public build inputs changed during capture.');
  }
  function verifyPaths() {
    const targets = [...inspected];
    for (const target of targets) { pathPhysical(target); guardDirectories(target); }
    let proof;
    try { proof = pathInspector(targets); }
    catch (error) {
      if (error instanceof ReleaseManifestError) throw error;
      throw new ReleaseManifestError('path_inspection_failed', 'The non-reparse path inspection failed.');
    }
    requireProof(record(proof) && proof.schema === '1132-release-physical-paths/1' && Array.isArray(proof.paths) && proof.paths.length === targets.length,
      'path_inspection_invalid', 'The non-reparse path inspection was incomplete.');
    const proven = new Set();
    for (const item of proof.paths) {
      requireProof(record(item) && typeof item.path === 'string' && item.nonReparse === true &&
        targets.some(target => samePath(target, item.path)) && !proven.has(pathKey(item.path)),
      'path_inspection_invalid', 'A path result was missing, duplicated, foreign or a reparse point.');
      proven.add(pathKey(item.path));
    }
  }
  function inventory() {
    const entries = fs.readdirSync(distPath, { withFileTypes: true });
    requireProof(entries.length <= required.length + 3,
      'dist_entries_invalid', 'dist must contain the exact release set and only documented build scratch entries.');
    const names = new Set(), identities = [];
    for (const entry of entries) {
      requireProof(fileName(entry.name) && !names.has(entry.name.toLowerCase()), 'dist_entry_invalid', 'Unsafe or case-ambiguous dist names were refused.');
      names.add(entry.name.toLowerCase());
      const target = path.join(distPath, entry.name);
      pathPhysical(target);
      const stat = fs.lstatSync(target, { bigint: true });
      inspected.add(target);
      if (entry.name === SCRATCH_DIRECTORY) identities.push([entry.name, directoryIdentity(stat)]);
      else {
        requireProof(allowed.has(entry.name) || SCRATCH_FILES.has(entry.name), 'unexpected_dist_entry',
          'An extra executable, metadata, blockmap or foreign file was found in dist.');
        const identity = fileIdentity(stat);
        const limit = SCRATCH_FILES.has(entry.name) ? 2 * 1024 * 1024 : maxAssetBytes;
        requireProof(stat.size <= BigInt(limit), 'asset_size_invalid', 'A release input exceeded its size bound.');
        identities.push([entry.name, identity]);
      }
    }
    requireProof(required.every(name => entries.some(entry => entry.name === name)), 'required_asset_missing', 'One or more exact release filenames are missing.');
    return JSON.stringify(identities.sort(([a], [b]) => a.localeCompare(b, 'en')));
  }
  function checkHeld(item) {
    const held = fs.fstatSync(item.fd, { bigint: true });
    const named = fs.lstatSync(item.path, { bigint: true });
    requireProof(!named.isSymbolicLink() && fileIdentity(held) === item.identity && fileIdentity(named) === item.identity,
      'asset_identity_changed', 'A release input or its path identity changed during capture.');
  }
  function readDigest(item, pass) {
    checkHeld(item);
    const buffer = Buffer.allocUnsafe(1024 * 1024), digest = createHash('sha256');
    let position = 0;
    while (true) {
      const count = fs.readSync(item.fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      position += count;
      requireProof(position <= item.size, 'asset_changed', 'A release input grew during capture.');
      digest.update(buffer.subarray(0, count));
      boundary('asset-read-chunk', { name: item.name, pass, bytes: position });
    }
    requireProof(position === item.size, 'asset_changed', 'A release input was truncated during capture.');
    checkHeld(item);
    return digest.digest('hex');
  }
  try {
    sourceAt('initial');
    const initialInventory = inventory();
    verifyPaths();
    for (const name of required) {
      const target = path.join(distPath, name), before = fs.lstatSync(target, { bigint: true });
      const beforeIdentity = fileIdentity(before);
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const held = { name, path: target, fd, size: Number(before.size), identity: beforeIdentity, sha256: null };
      handles.push(held);
      checkHeld(held);
    }
    for (const item of handles) item.sha256 = readDigest(item, 1);
    boundary('after-first-pass');
    for (const item of handles) requireProof(readDigest(item, 2) === item.sha256, 'asset_changed', 'Release input content changed between capture passes.');
    boundary('after-second-pass');
    requireProof(inventory() === initialInventory, 'dist_changed', 'The dist set or a file identity changed during capture.');
    verifyPaths(); sourceAt('final-input');
    const manifest = normalizeReleaseAssetManifest({ schemaVersion: 1, repository: RELEASE_REPOSITORY, tag, sourceSha,
      assets: handles.map(item => ({ name: item.name, size: item.size, sha256: item.sha256 })) }, tag);
    requireProof(manifest.assets.length === 9 && manifest.assets.every(item => allowed.has(item.name) && HASH256.test(item.sha256)),
      'manifest_set_invalid', 'The manifest is not the exact nine-file upload set.');
    const outputBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    boundary('before-output-open', { path: outputPath });
    verifyPaths();
    for (const item of handles) checkHeld(item);
    try { outputFd = fs.openSync(outputPath, 'wx+', 0o600); outputCreated = true; }
    catch (error) {
      if (error.code === 'EEXIST') throw new ReleaseManifestError('output_exists', 'Another output already exists; it was not overwritten.');
      throw error;
    }
    const openedOutput = fs.fstatSync(outputFd, { bigint: true });
    requireProof(openedOutput.isFile() && openedOutput.size === 0n && openedOutput.nlink === 1n && openedOutput.ino > 0n,
      'output_identity_invalid', 'The new output identity was not a single-link regular file.');
    boundary('output-created', { path: outputPath });
    let written = 0;
    while (written < outputBytes.length) {
      const count = fs.writeSync(outputFd, outputBytes, written, outputBytes.length - written, written);
      requireProof(count > 0, 'output_write_failed', 'The output write did not make progress.'); written += count;
    }
    fs.fsyncSync(outputFd);
    boundary('output-written', { path: outputPath });
    const outputStat = fs.fstatSync(outputFd, { bigint: true });
    const outputIdentity = fileIdentity(outputStat), readback = Buffer.alloc(outputBytes.length);
    let received = 0;
    while (received < readback.length) {
      const count = fs.readSync(outputFd, readback, received, readback.length - received, received);
      requireProof(count > 0, 'output_readback_failed', 'Output readback was incomplete.'); received += count;
    }
    requireProof(outputStat.size === BigInt(outputBytes.length) && readback.equals(outputBytes) &&
      fileIdentity(fs.fstatSync(outputFd, { bigint: true })) === outputIdentity &&
      fileIdentity(fs.lstatSync(outputPath, { bigint: true })) === outputIdentity,
    'output_readback_failed', 'Output bytes or file identity changed after flush.');
    boundary('before-final-check');
    requireProof(inventory() === initialInventory, 'dist_changed', 'The dist set changed before final readback.');
    for (const item of handles) requireProof(readDigest(item, 3) === item.sha256, 'asset_changed', 'Release bytes changed before manifest completion.');
    inspected.add(outputPath); verifyPaths(); sourceAt('after-output');
    const finalReadback = Buffer.alloc(outputBytes.length);
    let finalReceived = 0;
    while (finalReceived < finalReadback.length) {
      const count = fs.readSync(outputFd, finalReadback, finalReceived, finalReadback.length - finalReceived, finalReceived);
      requireProof(count > 0, 'output_readback_failed', 'Final output readback was incomplete.'); finalReceived += count;
    }
    requireProof(finalReadback.equals(outputBytes), 'output_readback_failed', 'Output content changed before capture completion.');
    requireProof(fileIdentity(fs.fstatSync(outputFd, { bigint: true })) === outputIdentity &&
      fileIdentity(fs.lstatSync(outputPath, { bigint: true })) === outputIdentity,
    'output_identity_changed', 'The output identity changed during final verification.');
    return Object.freeze({ manifest, file: Object.freeze({ path: outputPath, size: outputBytes.length, sha256: hash(outputBytes) }),
      receipt: Object.freeze({ schema: '1132-release-manifest-capture/1', sourceSha, sourceHeadMatched: true,
        sourceClean: true, sourceCleanReason: CLEAN_REASON, sourceCleanFingerprint: sourceFingerprint,
        exactAssets: 9, contentPasses: 3, createNew: true, fileFlushed: true, readbackVerified: true,
        sourceAdapter: sourceReader === readReleaseSource ? 'GIT_HEAD_READ' : 'EXPLICIT_ADAPTER',
        pathAdapter: pathInspector === inspectReleasePaths ? (process.platform === 'win32' ? 'PS7_REPARSE_READ' : 'POSIX_PHYSICAL_READ') : 'EXPLICIT_ADAPTER',
        publicationPerformed: false, authenticatedOriginEstablished: false, nativeAcceptanceEstablished: false,
        sharedAtomicPublication: false, uploadStillRequiresRemoteByteVerification: true }) });
  } catch (error) {
    const reported = error instanceof ReleaseManifestError ? error : new ReleaseManifestError('capture_failed', 'A bounded local capture operation failed.');
    reported.outputCreated = outputCreated;
    if (outputCreated) { reported.outputPath = outputPath; reported.outputDisposition = 'PRESERVED_REQUIRES_READBACK'; }
    throw reported;
  } finally {
    // These are owned file descriptors only. Never unlink/replace any input or
    // a partial output to make a retry appear successful.
    let closeFailed = false;
    for (const fd of [outputFd, ...handles.reverse().map(item => item.fd)]) {
      if (fd === null) continue;
      try { fs.closeSync(fd); } catch { closeFailed = true; }
    }
    if (closeFailed) {
      const error = new ReleaseManifestError('file_close_failed', 'One or more owned file descriptors could not be confirmed closed.');
      error.outputCreated = outputCreated;
      if (outputCreated) { error.outputPath = outputPath; error.outputDisposition = 'PRESERVED_REQUIRES_READBACK'; }
      throw error;
    }
  }
}
function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--dist': 'dist', '--tag': 'tag', '--source': 'sourceSha', '--out': 'out' }[args[index]];
    requireProof(key && index + 1 < args.length && !args[index + 1].startsWith('--') && !Object.hasOwn(result, key),
      'usage', 'Usage: create-release-manifest.mjs --dist <dir> --tag vX.Y.Z --source <SHA40> --out <new-json-file>');
    result[key] = args[index + 1];
  }
  requireProof(['dist', 'tag', 'sourceSha', 'out'].every(key => Object.hasOwn(result, key)), 'usage', 'All four manifest options are required.');
  return result;
}
function main() {
  try { console.log(JSON.stringify(buildDistReleaseManifest(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) {
    const known = error instanceof ReleaseManifestError;
    console.error(JSON.stringify({ status: 'FAIL', code: known ? error.code : 'capture_failed',
      message: known ? error.message : 'The local capture failed.', outputCreated: error.outputCreated === true,
      ...(error.outputCreated ? { outputPath: error.outputPath, outputDisposition: 'PRESERVED_REQUIRES_READBACK' } : {}) }));
    process.exitCode = known && error.code === 'usage' ? 2 : 1;
  }
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (samePath(invokedPath, modulePath)) main();
