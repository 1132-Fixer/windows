'use strict';

// Real Git byte fixtures only, in new owned recovery directories. This test
// creates no product processes, changes no shared index, and deletes nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const tool = require('./export-review-patch');

if (process.platform !== 'win32') throw new Error('Windows/PowerShell 7 required; no skipped pass');
const root = tool.newDirectory(path.win32.join(tool.RECOVERY_ROOT, 'export-review-smoke-' + crypto.randomUUID()));
const source = tool.newDirectory(path.win32.join(root, 'fixture source'));
const emptyTemplates = tool.newDirectory(path.win32.join(root, 'empty templates'));
const sourceIndex = path.win32.join(source, '.git', 'index');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ok  ' + name); }
function fixtureGit(args, input, mutation = true) {
  if (mutation) tool.assertPhysicalPaths([source, path.win32.join(source, '.git'), sourceIndex]);
  const result = spawnSync('git.exe', ['--no-replace-objects', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + emptyTemplates, '-C', source, ...args], {
    shell: false, windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 * 1024,
    input, encoding: null, env: tool.cleanEnvironment({
      GIT_AUTHOR_NAME: 'Export Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Export Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
    })
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stderr || Buffer.alloc(0)).toString('utf8'));
  return result.stdout || Buffer.alloc(0);
}
const write = (name, bytes) => {
  const file = path.win32.join(source, ...name.split('/'));
  fs.mkdirSync(path.win32.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const unicodeName = 'Unicode r\u00e9sum\u00e9 \u6587.txt';
const unicodeBefore = Buffer.from('before caf\u00e9 \u6f22\u5b57 \ud83d\ude00\r\n', 'utf8');
const unicodeAfter = Buffer.from('after caf\u00e9 \u6f22\u5b57 \ud83d\ude00\r\n', 'utf8');
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const binaryBefore = Buffer.from([0, 255, 128, 13, 10, 1, 2, 3, 0, 200]);
const binaryAfter = Buffer.from([0, 254, 129, 10, 13, 4, 5, 6, 0, 201]);

fixtureGit(['init', '--template=' + emptyTemplates, source]);
write('.gitattributes', Buffer.from('* -text\n*.bin binary\n', 'ascii'));
write('CONTRIBUTING.md', Buffer.from('contribute before\r\nsecond line\r\n', 'ascii'));
write(unicodeName, unicodeBefore);
write('bom file.txt', Buffer.concat([bom, Buffer.from('before bom\r\n', 'ascii')]));
write('binary payload.bin', binaryBefore);
write('already candidate.bin', binaryAfter);
write('space dir/file with spaces.txt', Buffer.from('space before\r\n', 'ascii'));
write('mode-only.txt', Buffer.from('same bytes\n', 'ascii'));
write('unchanged.bin', Buffer.from([0, 22, 33, 44, 255]));
fixtureGit(['add', '--all']);
const baseTree = fixtureGit(['write-tree']).toString('ascii').trim();
const base = fixtureGit(['commit-tree', baseTree], Buffer.from('immutable export fixture base\n', 'ascii')).toString('ascii').trim();

write('.gitattributes', Buffer.from('* text eol=lf\n*.bin binary\n', 'ascii'));
write('CONTRIBUTING.md', Buffer.from('contribute after\r\nsecond line\r\n', 'ascii'));
write(unicodeName, unicodeAfter);
write('bom file.txt', Buffer.concat([bom, Buffer.from('after bom\r\n', 'ascii')]));
write('binary payload.bin', binaryAfter);
write('space dir/file with spaces.txt', Buffer.from('space after\r\n', 'ascii'));
write('added \u65b0.txt', Buffer.from('new Unicode path \u65b0\n', 'utf8'));
fixtureGit(['add', '--all']);
fixtureGit(['update-index', '--chmod=+x', '--', 'mode-only.txt']);
const originalIndexHash = tool.sha256(fs.readFileSync(sourceIndex));
const output = path.win32.join(root, 'good export');
const manifest = tool.exportReviewPatch({ source, base, out: output });
const patch = fs.readFileSync(manifest.patch.path);
const entry = name => manifest.changedFiles.find(file => file.path === name);

check('strict replay compares the complete reconstructed index', () => {
  assert.equal(manifest.verification.strictApplyCheck, true);
  assert.equal(manifest.verification.canonicalPatchMatch, true);
  assert.ok(manifest.verification.indexEntriesCompared > manifest.changedFiles.length);
  assert.equal(manifest.verification.changedBlobsCompared, manifest.changedFiles.filter(file => file.index).length);
  assert.notEqual(manifest.verification.indexPath.toLowerCase(), sourceIndex.toLowerCase());
  assert.ok(manifest.verification.repository.startsWith(output + '\\'));
  assert.equal(tool.sha256(fs.readFileSync(sourceIndex)), originalIndexHash);
});
check('index bytes and actual CRLF working bytes are recorded separately', () => {
  const contributing = entry('CONTRIBUTING.md');
  assert.equal(contributing.base.sha256, tool.sha256(Buffer.from('contribute before\r\nsecond line\r\n', 'ascii')));
  assert.equal(contributing.index.sha256, tool.sha256(Buffer.from('contribute after\nsecond line\n', 'ascii')));
  assert.equal(contributing.workingFile.sha256, tool.sha256(Buffer.from('contribute after\r\nsecond line\r\n', 'ascii')));
  assert.equal(contributing.workingFile.matchesIndex, false);
  assert.notEqual(contributing.index.sha256, contributing.workingFile.sha256);
  assert.equal(manifest.source.indexFileSha256, originalIndexHash);
  assert.ok(patch.includes(Buffer.from('-contribute before\r\n', 'ascii')));
});
check('Unicode, BOM, binary bytes, path spaces and mode-only changes survive', () => {
  assert.equal(entry(unicodeName).index.sha256, tool.sha256(Buffer.from('after caf\u00e9 \u6f22\u5b57 \ud83d\ude00\n', 'utf8')));
  assert.equal(entry('bom file.txt').index.sha256, tool.sha256(Buffer.concat([bom, Buffer.from('after bom\n', 'ascii')])));
  assert.equal(entry('binary payload.bin').base.sha256, tool.sha256(binaryBefore));
  assert.equal(entry('binary payload.bin').index.sha256, tool.sha256(binaryAfter));
  assert.equal(entry('space dir/file with spaces.txt').index.sha256, tool.sha256(Buffer.from('space after\n', 'ascii')));
  assert.equal(entry('mode-only.txt').base.mode, '100644');
  assert.equal(entry('mode-only.txt').index.mode, '100755');
  assert.equal(entry('mode-only.txt').base.objectId, entry('mode-only.txt').index.objectId);
  assert.ok(entry('added \u65b0.txt'));
});
check('patch bytes are the exact file Git produced', () => {
  assert.equal(tool.sha256(patch), manifest.patch.sha256);
  assert.equal(patch.length, manifest.patch.bytes);
  assert.ok(patch.includes(Buffer.from('GIT binary patch', 'ascii')));
  assert.equal(fs.existsSync(path.win32.join(manifest.verification.repository, 'objects', 'info', 'alternates')), false);
});
check('existing artifact directories are never reused or overwritten', () => {
  assert.throws(() => tool.exportReviewPatch({ source, base, out: output }), error => error.code === 'OUTPUT_EXISTS');
  assert.equal(tool.sha256(fs.readFileSync(manifest.patch.path)), manifest.patch.sha256);
  assert.equal(tool.sha256(fs.readFileSync(sourceIndex)), originalIndexHash);
});

function corruptCopy(name, bytes) {
  const file = path.win32.join(root, name);
  tool.assertPhysicalPaths([file]);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return file;
}
check('tampering is rejected by the original patch digest before replay mutation', () => {
  const changed = Buffer.from(patch); changed[0] ^= 1;
  const file = corruptCopy('tampered digest.patch', changed);
  const out = path.win32.join(root, 'must not exist digest');
  assert.throws(() => tool.verifyReviewPatch({ source, base, patch: file, patchSha256: manifest.patch.sha256, out }),
    error => error.code === 'PATCH_HASH_MISMATCH');
  assert.equal(fs.existsSync(out), false);
});
check('bad UTF-8 is rejected even when its changed hash is supplied', () => {
  const changed = Buffer.concat([patch, Buffer.from([0xff])]);
  const file = corruptCopy('bad utf8.patch', changed);
  const out = path.win32.join(root, 'must not exist utf8');
  assert.throws(() => tool.verifyReviewPatch({ source, base, patch: file, patchSha256: tool.sha256(changed), out }),
    error => error.code === 'INVALID_UTF8');
  assert.equal(fs.existsSync(out), false);
});
check('UTF-16 text-pipeline damage is refused without whitespace relaxation', () => {
  const changed = Buffer.from(patch.toString('utf8'), 'utf16le');
  const file = corruptCopy('utf16 pipeline.patch', changed);
  const out = path.win32.join(root, 'must not exist utf16');
  assert.throws(() => tool.verifyReviewPatch({ source, base, patch: file, patchSha256: tool.sha256(changed), out }),
    error => ['INVALID_UTF8', 'UNSUPPORTED_PATCH'].includes(error.code));
  assert.equal(fs.existsSync(out), false);
});
check('a recomputed tampered hash cannot bypass reconstructed index comparison', () => {
  const changed = Buffer.from(patch), marker = Buffer.from('+contribute after\n', 'ascii');
  const offset = changed.indexOf(marker);
  assert.ok(offset >= 0);
  changed[offset + '+contribute '.length] = 'x'.charCodeAt(0);
  const file = corruptCopy('tampered content.patch', changed);
  assert.throws(() => tool.verifyReviewPatch({ source, base, patch: file, patchSha256: tool.sha256(changed),
    out: path.win32.join(root, 'recomputed corruption verification') }),
  error => ['COMMAND_FAILED', 'REPLAY_INDEX_MISMATCH', 'REPLAY_BLOB_MISMATCH'].includes(error.code));
  assert.equal(tool.sha256(fs.readFileSync(sourceIndex)), originalIndexHash);
});
check('binary payload corruption is rejected even when its postimage already exists in the base', () => {
  const changed = Buffer.from(patch), marker = Buffer.from('GIT binary patch\n', 'ascii');
  const markerOffset = changed.indexOf(marker);
  assert.ok(markerOffset >= 0);
  const payload = changed.indexOf(10, markerOffset + marker.length) + 1;
  assert.ok(payload > markerOffset + marker.length);
  changed[payload + 1] = changed[payload + 1] === 65 ? 66 : 65;
  const file = corruptCopy('corrupted existing binary postimage.patch', changed);
  assert.throws(() => tool.verifyReviewPatch({ source, base, patch: file, patchSha256: tool.sha256(changed),
    out: path.win32.join(root, 'binary payload verification') }),
  error => ['COMMAND_FAILED', 'REPLAY_INDEX_MISMATCH', 'NONCANONICAL_PATCH'].includes(error.code));
  assert.equal(tool.sha256(fs.readFileSync(sourceIndex)), originalIndexHash);
});
check('verification requires the original digest and a new safe target', () => {
  assert.throws(() => tool.verifyReviewPatch({ source, base, patch: manifest.patch.path, out: path.win32.join(root, 'no digest') }),
    error => error.code === 'PATCH_HASH_REQUIRED');
  assert.throws(() => tool.exportReviewPatch({ source, base, out: source }), error => error.code === 'UNSAFE_OUTPUT');
  const nested = path.win32.join(source, '.git', 'must-not-create');
  assert.throws(() => tool.exportReviewPatch({ source, base, out: nested }), error => error.code === 'UNSAFE_OUTPUT');
  assert.equal(fs.existsSync(nested), false);
  assert.throws(() => tool.newDirectory('C:\\outside-recovery\\unsafe'), error => error.code === 'UNSAFE_OUTPUT');
});
check('changed symlink entries are explicitly unsupported, not dereferenced', () => {
  const blob = fixtureGit(['hash-object', '-w', '--stdin'], Buffer.from('unfollowed target\n', 'ascii')).toString('ascii').trim();
  fixtureGit(['update-index', '--add', '--cacheinfo', '120000,' + blob + ',unsupported-link']);
  assert.throws(() => tool.exportReviewPatch({ source, base, out: path.win32.join(root, 'unsupported link') }),
    error => error.code === 'UNSUPPORTED_CHANGED_MODE');
});

console.log('export-review-patch-smoke: ' + checks + ' passed; preserved fixtures: ' + root);
