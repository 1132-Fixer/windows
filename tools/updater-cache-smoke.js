'use strict';

// Exercise the maintained electron-updater helper, not our mocked updater
// adapter. All files, including the "outside" sentinel, belong to one new
// temporary fixture. No executable is run and no update is downloaded.
// Windows basename semantics are required for both separator controls.
// This proves the filename/checksum cache contract only; it does not prove
// general ACL, reparse/device-name safety, installation or live updates.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const attempts = [];
const restorers = [];
let finished = false;
let passed = 0;
let failed = 0;
let runRoot = null;
let physicalRoot = null;
let permittedReadRoot = null;
const streamReads = [];
process.once('beforeExit', () => {
  if (!finished) {
    console.error('FAIL updater-cache: asynchronous fixture did not finish');
    process.exitCode = 1;
  }
});

function deny(name) {
  attempts.push(name);
  throw new Error('Updater cache fixture attempted a forbidden effect: ' + name);
}
const originalLoad = Module._load;
Module._load = function guarded(request, ...args) {
  const name = String(request).replace(/^node:/, '');
  if (/^(?:electron|@electron\/remote)(?:\/|$)/.test(name) ||
      /^(?:http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster)(?:\/|$)/.test(name)) {
    return deny('import:' + name);
  }
  return originalLoad.call(this, request, ...args);
};
restorers.push(() => { Module._load = originalLoad; });
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (!descriptor) continue;
  if (!descriptor.configurable) throw new Error('Cannot establish required global guard: ' + name);
  Object.defineProperty(globalThis, name, {configurable:true, writable:true, value:function () { return deny('global:' + name); }});
  restorers.push(() => Object.defineProperty(globalThis, name, descriptor));
}
for (const name of ['kill', 'exit', 'dlopen']) {
  const original = process[name];
  process[name] = () => deny('process:' + name);
  restorers.push(() => { process[name] = original; });
}
const originalReadStream = fs.createReadStream;
fs.createReadStream = function guardedRead(file, ...args) {
  if (typeof file !== 'string' || !permittedReadRoot) return deny('unscoped-cache-stream');
  const absolute = path.resolve(file);
  const relative = path.relative(permittedReadRoot, absolute);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    return deny('cache-stream-outside-pending');
  }
  streamReads.push(absolute);
  return originalReadStream.call(this, file, ...args);
};
restorers.push(() => { fs.createReadStream = originalReadStream; });

function hash(bytes) { return crypto.createHash('sha512').update(bytes).digest('base64'); }
const BODY = Buffer.from('Inert updater cache fixture bytes. Not an executable.');
const SENTINEL = Buffer.from('Unrelated sentinel inside the owned test root. Preserve exactly.');
function logger() {
  const infos = [], warns = [];
  return {infos,warns,info:value => infos.push(String(value)),warn:value => warns.push(String(value)),error:() => {}};
}
function fixture(DownloadedUpdateHelper, {name='setup.exe', body=BODY, cachedHash=hash(BODY), expectedHash=hash(BODY), writeFile=true, writeMetadata=true} = {}) {
  const root = fs.mkdtempSync(path.join(runRoot, 'case-'));
  const pending = path.join(root, 'pending');
  fs.mkdirSync(pending);
  const outside = path.join(root, 'outside.exe');
  fs.writeFileSync(outside, SENTINEL, {flag:'wx'});
  const file = path.join(pending, 'setup.exe');
  if (writeFile) fs.writeFileSync(file, body, {flag:'wx'});
  const metadataPath = path.join(pending, 'update-info.json');
  const metadata = {fileName:name,sha512:cachedHash,isAdminRightsRequired:false};
  if (writeMetadata) fs.writeFileSync(metadataPath, JSON.stringify(metadata), {flag:'wx'});
  // Fresh instance is essential: setDownloadedFile creates an in-memory fast
  // path that checks existence instead of the persisted filename/hash guard.
  const helper = new DownloadedUpdateHelper(root);
  assert.equal(helper.file, null);
  const log = logger();
  const fileInfo = {url:new URL('https://not-used.invalid/setup.exe'), info:{url:'setup.exe',sha512:expectedHash,size:BODY.length}};
  const updateInfo = {version:'6.4.1',files:[fileInfo.info],path:'setup.exe',sha512:expectedHash,releaseDate:''};
  return {root,pending,outside,file,metadataPath,metadata,helper,log,fileInfo,updateInfo,
    async validate() {
      permittedReadRoot = pending;
      streamReads.length = 0;
      try { return await helper.validateDownloadedPath(file, updateInfo, fileInfo, log); }
      finally { permittedReadRoot = null; }
    },
    preserveSentinel() { assert.deepEqual(fs.readFileSync(outside), SENTINEL); }
  };
}
async function test(name, body) {
  try { await body(); passed++; console.log('PASS updater-cache: ' + name); }
  catch (error) { failed++; process.exitCode = 1; console.error('FAIL updater-cache: ' + name + ': ' + error.message); }
}

(async () => {
  try {
    assert.equal(process.platform, 'win32', 'Run this required Windows cache driver on Windows; other path semantics do not satisfy it.');
    const libraryPath = require.resolve('electron-updater/out/DownloadedUpdateHelper');
    const {DownloadedUpdateHelper} = require(libraryPath);
    const pkg = require('electron-updater/package.json');
    const librarySha256 = crypto.createHash('sha256').update(fs.readFileSync(libraryPath)).digest('hex');
    assert.equal(typeof DownloadedUpdateHelper, 'function');
    console.log(JSON.stringify({layer:'actual maintained library with owned filesystem fixtures',version:pkg.version,librarySha256,networkAllowed:false,installerExecuted:false}));
    const tempRoot = fs.realpathSync(os.tmpdir());
    runRoot = fs.mkdtempSync(path.join(tempRoot, '1132-updater-cache-'));
    physicalRoot = fs.realpathSync(runRoot);
    assert.equal(path.dirname(physicalRoot).toLowerCase(), tempRoot.toLowerCase());
    assert.ok(path.basename(physicalRoot).startsWith('1132-updater-cache-'));
    assert.equal(fs.lstatSync(physicalRoot).isSymbolicLink(), false);

    const invalidNames = [
      ['missing', undefined], ['null', null], ['empty', ''], ['number', 17],
      ['boolean', true], ['array', []], ['object', {name:'setup.exe'}],
      ['forward traversal', '../outside.exe'], ['Windows traversal', '..\\outside.exe'],
      ['forward nested path', 'nested/setup.exe'], ['Windows nested path', 'nested\\setup.exe']
    ];
    for (const [label, name] of invalidNames) await test('invalid cached filename refuses before file read: ' + label, async () => {
      const f = fixture(DownloadedUpdateHelper, {name,cachedHash:hash(SENTINEL),expectedHash:hash(SENTINEL)});
      if (name === undefined) delete f.metadata.fileName;
      fs.writeFileSync(f.metadataPath, JSON.stringify(f.metadata));
      if (label.includes('nested')) {
        fs.mkdirSync(path.join(f.pending, 'nested'));
        fs.writeFileSync(path.join(f.pending, 'nested', 'setup.exe'), SENTINEL);
      }
      assert.equal(await f.validate(), null);
      assert.ok(f.log.warns.some(value => value.includes('invalid fileName')));
      assert.equal(streamReads.length, 0);
      assert.equal(fs.existsSync(f.metadataPath), false);
      assert.deepEqual(fs.readdirSync(f.pending), []);
      f.preserveSentinel();
    });
    for (const namespaced of [false, true]) await test('absolute owned-fixture path is rejected' + (namespaced ? ' with Windows namespace' : ''), async () => {
      const f = fixture(DownloadedUpdateHelper, {cachedHash:hash(SENTINEL),expectedHash:hash(SENTINEL)});
      f.metadata.fileName = namespaced ? path.toNamespacedPath(f.outside) : f.outside;
      fs.writeFileSync(f.metadataPath, JSON.stringify(f.metadata));
      assert.equal(await f.validate(), null);
      assert.ok(f.log.warns.some(value => value.includes('invalid fileName')));
      assert.equal(streamReads.length, 0);
      assert.equal(fs.existsSync(f.metadataPath), false);
      f.preserveSentinel();
    });
    await test('valid basename and actual matching bytes return the cached file', async () => {
      const f = fixture(DownloadedUpdateHelper);
      assert.equal(await f.validate(), f.file);
      assert.deepEqual(streamReads, [f.file]);
      assert.equal(f.helper.file, f.file);
      assert.equal(f.helper.downloadedFileInfo.fileName, 'setup.exe');
      assert.equal(f.helper.downloadedFileInfo.sha512, hash(BODY));
      f.preserveSentinel();
    });
    await test('changed cached bytes refuse and clean only pending', async () => {
      const f = fixture(DownloadedUpdateHelper, {body:Buffer.from('corrupted inert cache bytes')});
      assert.equal(await f.validate(), null);
      assert.deepEqual(streamReads, [f.file]);
      assert.ok(f.log.warns.some(value => value.includes('Sha512')));
      assert.deepEqual(fs.readdirSync(f.pending), []);
      f.preserveSentinel();
    });
    await test('metadata hash disagreement refuses before any binary read', async () => {
      const f = fixture(DownloadedUpdateHelper, {cachedHash:hash(SENTINEL)});
      assert.equal(await f.validate(), null);
      assert.equal(streamReads.length, 0);
      assert.deepEqual(fs.readdirSync(f.pending), []);
      f.preserveSentinel();
    });
    await test('missing cached file reports absence without fabricated success', async () => {
      const f = fixture(DownloadedUpdateHelper, {writeFile:false});
      assert.equal(await f.validate(), null);
      assert.equal(streamReads.length, 0);
      assert.ok(f.log.infos.some(value => value.includes("doesn't exist")));
      f.preserveSentinel();
    });
    await test('missing metadata returns no cached update', async () => {
      const f = fixture(DownloadedUpdateHelper, {writeMetadata:false});
      assert.equal(await f.validate(), null);
      assert.equal(streamReads.length, 0);
      f.preserveSentinel();
    });
    await test('malformed metadata is refused and only pending is cleaned', async () => {
      const f = fixture(DownloadedUpdateHelper);
      fs.writeFileSync(f.metadataPath, '{malformed-json');
      assert.equal(await f.validate(), null);
      assert.equal(streamReads.length, 0);
      assert.deepEqual(fs.readdirSync(f.pending), []);
      f.preserveSentinel();
    });
    assert.deepEqual(attempts, [], 'No forbidden import, network, subprocess or outside binary read is permitted.');
  } finally {
    try {
      if (physicalRoot) {
        // Check the exact resolved absolute target immediately before recursive
        // removal. Only this driver's new fixture directory is removable.
        assert.equal(fs.realpathSync(runRoot), physicalRoot);
        assert.equal(fs.lstatSync(runRoot).isSymbolicLink(), false);
        assert.ok(path.basename(physicalRoot).startsWith('1132-updater-cache-'));
        fs.rmSync(physicalRoot, {recursive:true,force:false});
      }
    } finally { for (const restore of restorers.reverse()) restore(); }
  }
  console.log('updater-cache-smoke: ' + passed + ' passed, ' + failed + ' failed; no network, app or installer execution.');
  if (failed) process.exitCode = 1;
  finished = true;
})().catch(error => {
  console.error('FAIL updater-cache harness: ' + error.message);
  process.exitCode = 1;
  finished = true;
});
