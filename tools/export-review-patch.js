'use strict';

// Export Git's staged bytes, not PowerShell text or a working-directory copy.
// Replay occurs only in a new bare repository and a distinct index. No source
// index/repository writes, network commands, hooks, cleanup, or product code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const SOURCE_ROOT = 'C:\\src';
const RECOVERY_ROOT = 'C:\\src\\AI-Recovery';
const MAX_BYTES = 256 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const MODES = new Set(['100644', '100755', '120000', '160000']);
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { const error = new Error(code + ': ' + message); error.code = code; throw error; };
const utf8 = bytes => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { return fail('INVALID_UTF8', 'Input contains invalid UTF-8 bytes'); }
};
const samePath = (left, right) => path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
const beneath = (root, target) => {
  const relative = path.win32.relative(root, target);
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative));
};

function cleanEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', ...extra };
}

function child(executable, args, options = {}) {
  const result = spawnSync(executable, args, { windowsHide: true, shell: false, timeout: TIMEOUT_MS,
    maxBuffer: MAX_BYTES, encoding: null, env: cleanEnvironment(), ...options });
  if (result.error) fail('COMMAND_FAILED', executable + ': ' + result.error.code);
  if (result.status !== 0) fail('COMMAND_FAILED', executable + ' exited ' + result.status + ': ' + utf8(result.stderr || Buffer.alloc(0)).trim());
  return result.stdout || Buffer.alloc(0);
}

// Node exposes links/junctions, but not every Windows reparse attribute. Check
// both real paths and native attributes. This read-only script handles metadata
// only; patch/pack bytes never pass through PowerShell or a text stream.
function assertPhysicalPaths(candidates) {
  if (process.platform !== 'win32') fail('UNSUPPORTED_PLATFORM', 'Windows with native PowerShell 7 is required');
  const existing = new Set();
  for (const input of candidates) {
    if (typeof input !== 'string' || !path.win32.isAbsolute(input)) fail('UNSAFE_PATH', 'An absolute path is required');
    const candidate = path.win32.resolve(input);
    if (!/^[Cc]:\\/.test(candidate) || candidate.slice(3).includes(':') || !beneath(SOURCE_ROOT, candidate)) {
      fail('UNSAFE_PATH', 'An absolute physical path under C:\\src is required');
    }
    const resolved = path.win32.resolve(candidate);
    let current = path.win32.parse(resolved).root;
    const parts = resolved.slice(current.length).split('\\').filter(Boolean);
    const ancestors = [current];
    for (const part of parts) { current = path.win32.join(current, part); ancestors.push(current); }
    let missing = false;
    for (const ancestor of ancestors) {
      if (missing) continue;
      let stat;
      try { stat = fs.lstatSync(ancestor); }
      catch (error) { if (error.code === 'ENOENT') { missing = true; continue; } throw error; }
      if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(ancestor), ancestor)) fail('REPARSE_PATH', ancestor);
      if (!samePath(ancestor, resolved) && !stat.isDirectory()) fail('UNSAFE_PATH', 'A path ancestor is not a directory');
      existing.add(ancestor);
    }
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'POWERSHELL7_REQUIRED_NOT_AVAILABLE' }",
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$rows = @(foreach ($itemPath in $paths) { $item = Get-Item -LiteralPath $itemPath -Force; [pscustomobject]@{ path = $itemPath; fullName = $item.FullName; reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint) } })',
    'ConvertTo-Json -InputObject $rows -Compress'
  ].join('\n');
  const output = child(path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: Buffer.from(JSON.stringify([...existing]), 'utf8') });
  const rows = JSON.parse(utf8(output));
  if (!Array.isArray(rows) || rows.length !== existing.size) fail('PATH_PROOF_MISSING', 'Native path readback was incomplete');
  for (const row of rows) if (!row || !existing.has(row.path) || row.reparse !== false || !samePath(row.path, row.fullName)) {
    fail('REPARSE_PATH', 'Native path readback disagreed');
  }
}

function newDirectory(directory) {
  if (typeof directory !== 'string' || !path.win32.isAbsolute(directory)) fail('UNSAFE_OUTPUT', 'An absolute output directory is required');
  directory = path.win32.resolve(directory);
  if (!beneath(RECOVERY_ROOT, directory) || samePath(directory, RECOVERY_ROOT)) fail('UNSAFE_OUTPUT', 'Use a new child directory under C:\\src\\AI-Recovery');
  assertPhysicalPaths([directory]);
  if (fs.existsSync(directory)) fail('OUTPUT_EXISTS', directory);
  fs.mkdirSync(directory, { recursive: true });
  assertPhysicalPaths([directory]);
  return directory;
}

const gitPrefix = ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=true',
  '-c', 'color.ui=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.submodule=short', '-c', 'submodule.recurse=false', '-c', 'diff.renames=false',
  '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=false', '-c', 'diff.context=3', '-c', 'diff.interHunkContext=0'];

function gitRead(repository, args, options = {}) {
  return child('git.exe', [...gitPrefix, '-C', repository, ...args], options);
}
function gitMutation(repository, index, args, options = {}) {
  if (!beneath(RECOVERY_ROOT, repository) || !beneath(RECOVERY_ROOT, index) || samePath(repository, RECOVERY_ROOT)) {
    fail('UNSAFE_VERIFICATION_TARGET', 'Verification mutations must stay in new recovery repositories');
  }
  // Re-resolve the physical repository and index ancestors before EVERY Git
  // mutation, not merely when the output directory was first created.
  assertPhysicalPaths([repository, index]);
  return child('git.exe', [...gitPrefix, '--git-dir=' + repository, ...args],
    { ...options, env: cleanEnvironment({ GIT_INDEX_FILE: index }) });
}
function line(bytes) { return utf8(bytes).trim(); }
function readBytes(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('UNSUPPORTED_FILE', file);
  return fs.readFileSync(file);
}
function safeGitPath(value) {
  if (!value || value.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part))) {
    fail('UNSUPPORTED_GIT_PATH', 'Unsupported Windows index path');
  }
  return value;
}
function indexEntries(bytes) {
  const records = utf8(bytes).split('\0');
  if (records.pop() !== '') fail('INVALID_INDEX_OUTPUT', 'Missing NUL terminator');
  const entries = new Map(), folded = new Set();
  for (const item of records) {
    const match = /^([0-9]{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(item);
    if (!match || !MODES.has(match[1]) || match[3] !== '0') fail('UNSUPPORTED_INDEX', 'Only resolved SHA-1 index entries are supported');
    const name = safeGitPath(match[4]);
    if (folded.has(name.toLowerCase())) fail('UNSUPPORTED_INDEX', 'Case-colliding index paths are unsupported');
    folded.add(name.toLowerCase());
    entries.set(name, { mode: match[1], objectId: match[2] });
  }
  return entries;
}
function baseEntries(repository, base) {
  const bytes = gitRead(repository, ['ls-tree', '-r', '-t', '-z', '--full-tree', base]);
  const records = utf8(bytes).split('\0');
  if (records.pop() !== '') fail('INVALID_TREE_OUTPUT', 'Missing NUL terminator');
  const entries = new Map(), objects = new Set([base, line(gitRead(repository, ['rev-parse', '--verify', base + '^{tree}']))]);
  for (const item of records) {
    const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(item);
    if (!match) fail('UNSUPPORTED_BASE', 'Malformed base tree');
    const name = safeGitPath(match[4]);
    if (match[2] === 'tree') objects.add(match[3]);
    else {
      if (!MODES.has(match[1]) || (match[1] === '160000') !== (match[2] === 'commit')) fail('UNSUPPORTED_BASE', 'Unsupported base entry');
      entries.set(name, { mode: match[1], objectId: match[3] });
      if (match[2] === 'blob') objects.add(match[3]);
    }
  }
  return { entries, objects: [...objects].sort() };
}
function blobHashes(repository, objectIds) {
  const unique = [...new Set(objectIds)];
  if (!unique.length) return new Map();
  const output = gitRead(repository, ['cat-file', '--batch'], { input: Buffer.from(unique.join('\n') + '\n', 'ascii') });
  const hashes = new Map();
  let offset = 0;
  for (const expected of unique) {
    const end = output.indexOf(10, offset);
    if (end < 0) fail('INVALID_OBJECT_OUTPUT', 'Missing object header');
    const match = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(output.subarray(offset, end).toString('ascii'));
    const length = match && Number(match[2]);
    if (!match || match[1] !== expected || !Number.isSafeInteger(length) || length > MAX_BYTES) fail('INVALID_OBJECT_OUTPUT', 'Unexpected object or object type');
    offset = end + 1;
    const body = output.subarray(offset, offset + length);
    if (body.length !== length || output[offset + length] !== 10) fail('INVALID_OBJECT_OUTPUT', 'Truncated object bytes');
    const actualId = crypto.createHash('sha1').update(Buffer.from('blob ' + length + '\0', 'ascii')).update(body).digest('hex');
    if (actualId !== expected) fail('OBJECT_HASH_MISMATCH', expected);
    hashes.set(expected, { sha256: sha256(body), bytes: length });
    offset += length + 1;
  }
  if (offset !== output.length) fail('INVALID_OBJECT_OUTPUT', 'Unexpected trailing object bytes');
  return hashes;
}
function workingFiles(repository, changes) {
  const targets = changes.map(change => path.win32.join(repository, ...change.path.split('/')));
  assertPhysicalPaths(targets);
  return changes.map((change, index) => {
    const file = targets[index];
    if (!fs.existsSync(file)) return { state: 'missing', sha256: null, bytes: null, matchesIndex: change.index === null };
    const bytes = readBytes(file);
    return { state: 'present', sha256: sha256(bytes), bytes: bytes.length,
      matchesIndex: change.index !== null && sha256(bytes) === change.index.sha256 };
  });
}
function captureSource(repository, base) {
  if (!SHA1.test(base || '')) fail('INVALID_BASE', 'An exact lowercase 40-hex commit is required');
  if (typeof repository !== 'string' || !path.win32.isAbsolute(repository)) fail('UNSAFE_PATH', 'An absolute source repository is required');
  repository = path.win32.resolve(repository);
  assertPhysicalPaths([repository]);
  if (line(gitRead(repository, ['rev-parse', '--show-object-format'])) !== 'sha1' ||
    line(gitRead(repository, ['rev-parse', '--verify', base + '^{commit}'])) !== base) fail('UNSUPPORTED_BASE', 'Expected immutable SHA-1 commit');
  const indexPath = path.win32.resolve(line(gitRead(repository, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])));
  const gitDirectory = path.win32.resolve(line(gitRead(repository, ['rev-parse', '--absolute-git-dir'])));
  const commonDirectory = path.win32.resolve(line(gitRead(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
  const objectDirectory = path.win32.resolve(line(gitRead(repository, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])));
  assertPhysicalPaths([indexPath, gitDirectory, commonDirectory, objectDirectory]);
  if (fs.existsSync(path.win32.join(objectDirectory, 'info', 'alternates')) ||
    fs.existsSync(path.win32.join(objectDirectory, 'info', 'http-alternates')) ||
    (fs.existsSync(path.win32.join(objectDirectory, 'pack')) && fs.readdirSync(path.win32.join(objectDirectory, 'pack')).some(name => name.endsWith('.promisor')))) {
    fail('UNSUPPORTED_OBJECT_STORE', 'Source alternates and promisor object stores are unsupported');
  }
  const indexFileSha256 = sha256(readBytes(indexPath));
  const entries = indexEntries(gitRead(repository, ['ls-files', '--stage', '-z']));
  const immutable = baseEntries(repository, base);
  const changes = [];
  for (const name of [...new Set([...immutable.entries.keys(), ...entries.keys()])].sort()) {
    const before = immutable.entries.get(name) || null, after = entries.get(name) || null;
    if (before && after && before.mode === after.mode && before.objectId === after.objectId) continue;
    if ((before && ['120000', '160000'].includes(before.mode)) || (after && ['120000', '160000'].includes(after.mode))) {
      fail('UNSUPPORTED_CHANGED_MODE', 'Changed symlinks/gitlinks require a separate review export');
    }
    changes.push({ path: name, base: before, index: after });
  }
  if (!changes.length) fail('EMPTY_EXPORT', 'The staged index does not differ from the base');
  const hashes = blobHashes(repository, changes.flatMap(change => [change.base, change.index].filter(Boolean).map(entry => entry.objectId)));
  for (const change of changes) for (const key of ['base', 'index']) if (change[key]) change[key] = { ...change[key], ...hashes.get(change[key].objectId) };
  const working = workingFiles(repository, changes);
  changes.forEach((change, index) => { change.workingFile = working[index]; });
  return { repository, base, indexPath, gitDirectory, commonDirectory, objectDirectory, indexFileSha256, entries, changes, baseObjects: immutable.objects };
}
function assertSourceUnchanged(snapshot) {
  if (sha256(readBytes(snapshot.indexPath)) !== snapshot.indexFileSha256) fail('SOURCE_INDEX_CHANGED', 'Source index bytes changed during export');
  const now = indexEntries(gitRead(snapshot.repository, ['ls-files', '--stage', '-z']));
  compareEntries(snapshot.entries, now);
  const working = workingFiles(snapshot.repository, snapshot.changes);
  if (JSON.stringify(working) !== JSON.stringify(snapshot.changes.map(change => change.workingFile))) {
    fail('WORKING_FILES_CHANGED', 'Working-file bytes changed during export');
  }
}
function compareEntries(expected, actual) {
  if (expected.size !== actual.size) fail('REPLAY_INDEX_MISMATCH', 'Index entry count differs');
  for (const [name, entry] of expected) {
    const rebuilt = actual.get(name);
    if (!rebuilt || rebuilt.mode !== entry.mode || rebuilt.objectId !== entry.objectId) fail('REPLAY_INDEX_MISMATCH', name);
  }
}
function validatePatch(file, expected) {
  assertPhysicalPaths([file]);
  const bytes = readBytes(file);
  if (expected !== undefined && (!SHA256.test(expected) || sha256(bytes) !== expected)) fail('PATCH_HASH_MISMATCH', 'Patch bytes differ from expected SHA-256');
  const text = utf8(bytes); // Validation only: these bytes are NEVER reencoded.
  if (!text.startsWith('diff --git ') || text.includes('\0')) fail('UNSUPPORTED_PATCH', 'Expected a Git binary-capable diff');
  return { sha256: sha256(bytes), bytes: bytes.length };
}
function replay(snapshot, patch, expected, output) {
  const patchProof = validatePatch(patch, expected);
  const repository = path.win32.join(output, 'verification.git');
  const index = path.win32.join(output, 'verification.index');
  const templates = path.win32.join(output, 'empty-templates');
  const pack = path.win32.join(output, 'immutable-base.pack');
  if (fs.existsSync(repository) || fs.existsSync(index) || fs.existsSync(pack)) fail('VERIFICATION_TARGET_EXISTS', 'Never reuse a verification repository/index');
  fs.mkdirSync(templates);
  assertPhysicalPaths([repository, index, templates, pack]);
  // Git writes its binary pack directly to an exclusive file descriptor.
  const packFd = fs.openSync(pack, 'wx');
  try {
    gitRead(snapshot.repository, ['pack-objects', '--stdout', '--window=0', '--threads=1', '--no-reuse-delta', '--no-reuse-object'],
      { input: Buffer.from(snapshot.baseObjects.join('\n') + '\n', 'ascii'), stdio: ['pipe', packFd, 'pipe'] });
  } finally { fs.closeSync(packFd); }
  gitMutation(repository, index, ['init', '--bare', '--object-format=sha1', '--template=' + templates, repository]);
  const packInput = fs.openSync(pack, 'r');
  try { gitMutation(repository, index, ['index-pack', '--stdin'], { stdio: [packInput, 'pipe', 'pipe'] }); }
  finally { fs.closeSync(packInput); }
  if (fs.existsSync(path.win32.join(repository, 'objects', 'info', 'alternates')) ||
    fs.existsSync(path.win32.join(repository, 'objects', 'info', 'http-alternates'))) fail('UNSAFE_OBJECT_STORE', 'Verification must not use alternates');
  const imported = line(gitRead(repository, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])).split(/\r?\n/).sort();
  if (JSON.stringify(imported) !== JSON.stringify(snapshot.baseObjects)) fail('UNSAFE_OBJECT_STORE', 'Verification must contain only immutable base objects before replay');
  gitMutation(repository, index, ['read-tree', snapshot.base]);
  // Strict matching: no whitespace fixes, ignore-whitespace, or line-ending
  // conversion. Apply only to this new alternate index, never a worktree.
  gitMutation(repository, index, ['apply', '--cached', '--check', patch]);
  if (validatePatch(patch, patchProof.sha256).sha256 !== patchProof.sha256) fail('PATCH_HASH_MISMATCH', 'Patch changed during strict check');
  gitMutation(repository, index, ['apply', '--cached', patch]);
  const rebuilt = indexEntries(gitRead(repository, ['ls-files', '--stage', '-z'], { env: cleanEnvironment({ GIT_INDEX_FILE: index }) }));
  compareEntries(snapshot.entries, rebuilt);
  const changed = snapshot.changes.filter(change => change.index);
  const hashes = blobHashes(repository, changed.map(change => change.index.objectId));
  for (const change of changed) if (hashes.get(change.index.objectId).sha256 !== change.index.sha256) fail('REPLAY_BLOB_MISMATCH', change.path);
  // Git can reuse an already-present binary postimage and avoid decoding its
  // payload. Regenerate the canonical diff from the reconstructed index and
  // require exact bytes too. Unsupported local diff/attribute behavior fails
  // closed instead of weakening comparison or accepting an unusable payload.
  const canonical = path.win32.join(output, 'reconstructed.patch');
  assertPhysicalPaths([canonical]);
  if (fs.existsSync(canonical)) fail('OUTPUT_EXISTS', canonical);
  gitRead(repository, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--output=' + canonical, snapshot.base],
    { env: cleanEnvironment({ GIT_INDEX_FILE: index }) });
  if (!readBytes(canonical).equals(readBytes(patch))) fail('NONCANONICAL_PATCH', 'Reconstructed Git diff bytes disagree; no payload or whitespace relaxation is allowed');
  validatePatch(patch, patchProof.sha256);
  assertSourceUnchanged(snapshot);
  return { repository, indexPath: index, immutableBaseObjects: snapshot.baseObjects.length,
    strictApplyCheck: true, canonicalPatchMatch: true, reconstructedPatch: canonical,
    indexEntriesCompared: rebuilt.size, changedBlobsCompared: changed.length, patch: patchProof };
}
function manifest(snapshot, verification, patch) {
  return { schemaVersion: 1, baseCommit: snapshot.base, source: {
    repository: snapshot.repository, gitDirectory: snapshot.gitDirectory, commonDirectory: snapshot.commonDirectory,
    indexPath: snapshot.indexPath, indexFileSha256: snapshot.indexFileSha256 },
    patch: { path: patch, ...verification.patch }, verification,
    changedFiles: snapshot.changes,
    byteSemantics: 'index hashes describe Git blob bytes; workingFile hashes describe actual disk bytes independently, including CRLF/BOM differences' };
}
function separateOutput(snapshot, output) {
  if (typeof output !== 'string' || !path.win32.isAbsolute(output)) fail('UNSAFE_OUTPUT', 'An absolute output directory is required');
  const resolved = path.win32.resolve(output);
  if ([snapshot.repository, snapshot.gitDirectory, snapshot.commonDirectory, snapshot.objectDirectory, path.win32.dirname(snapshot.indexPath)]
    .some(sourcePath => beneath(sourcePath, resolved) || beneath(resolved, sourcePath))) {
    fail('UNSAFE_OUTPUT', 'Verification artifacts must be outside the source checkout and Git metadata');
  }
  return newDirectory(output);
}
function exportReviewPatch(options) {
  const snapshot = captureSource(options.source, options.base);
  const output = separateOutput(snapshot, options.out);
  const patch = path.win32.join(output, 'review.patch');
  assertPhysicalPaths([patch]);
  if (fs.existsSync(patch)) fail('OUTPUT_EXISTS', patch);
  gitRead(snapshot.repository, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--output=' + patch, snapshot.base]);
  const proof = validatePatch(patch);
  const verification = replay(snapshot, patch, proof.sha256, output);
  const result = manifest(snapshot, verification, patch);
  fs.writeFileSync(path.win32.join(output, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return result;
}
function verifyReviewPatch(options) {
  if (!SHA256.test(options.patchSha256 || '')) fail('PATCH_HASH_REQUIRED', 'Verification requires the original patch SHA-256');
  validatePatch(options.patch, options.patchSha256);
  const snapshot = captureSource(options.source, options.base);
  const output = separateOutput(snapshot, options.out);
  return replay(snapshot, options.patch, options.patchSha256, output);
}

module.exports = { exportReviewPatch, verifyReviewPatch, assertPhysicalPaths, newDirectory, cleanEnvironment, sha256, RECOVERY_ROOT };

if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!['--source', '--base', '--out'].includes(args[index]) || !args[index + 1] || options[args[index].slice(2)]) fail('USAGE', 'Use --source <absolute repo> --base <40-hex commit> --out <new recovery directory>');
      options[args[index].slice(2)] = args[index + 1];
    }
    const result = exportReviewPatch(options);
    console.log(JSON.stringify({ patch: result.patch, manifest: path.win32.join(options.out, 'manifest.json'),
      changedFiles: result.changedFiles.length, indexEntriesCompared: result.verification.indexEntriesCompared }, null, 2));
  } catch (error) { console.error(error.code || 'EXPORT_FAILED', error.message); process.exitCode = 1; }
}
