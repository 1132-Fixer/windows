'use strict';

// Exercise the INSTALLED packaging consumers without building/launching an app.
// Run unchanged before and after the scoped minimatch override:
//   node tools/packaging-globs-smoke.js --json
// Candidate run can add --expect-minimatch 11.0.8 to require both scoped users.
// Optional read-only archive comparison:
//   node tools/packaging-globs-smoke.js --asar <baseline> --compare-asar <candidate>
// No package/lock changes, fixture files, archive extraction, native helpers,
// subprocesses, network requests, or filesystem mutations are permitted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const results = [];
const attemptedEffects = [];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readOnlyGuard() {
  function replace(object, key, value) {
    const original = object[key];
    if (typeof original !== 'function') return;
    object[key] = value;
  }
  function denied(name) {
    return () => { attemptedEffects.push(name); throw new Error('Packaging fixture forbids effect: ' + name); };
  }
  const child = require('node:child_process');
  const originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (/^(?:node:)?electron(?:\/|$)/.test(name)) return denied('Electron product import')();
    return originalLoad.call(this, name, ...args);
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) replace(child, name, denied('child_process.' + name));
  for (const [name, object] of [['http', require('node:http')], ['https', require('node:https')], ['net', require('node:net')]]) {
    for (const key of ['request', 'get', 'connect', 'createConnection', 'createServer']) replace(object, key, denied(name + '.' + key));
  }
  replace(globalThis, 'fetch', denied('fetch'));
  replace(process, 'dlopen', denied('process.dlopen'));
  replace(process, 'kill', denied('process.kill'));
  replace(process, 'chdir', denied('process.chdir'));
  replace(process, 'exit', denied('process.exit'));
  const mutations = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'copyFile', 'cp', 'rm', 'rmdir',
    'unlink', 'link', 'symlink', 'truncate', 'chmod', 'chown', 'utimes'];
  for (const name of mutations) {
    replace(fs, name, denied('fs.' + name));
    replace(fs, name + 'Sync', denied('fs.' + name + 'Sync'));
    replace(fs.promises, name, denied('fs.promises.' + name));
  }
  const readFlags = flags => typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) === 0
    : ['r', 'rs', 'sr'].includes(flags);
  for (const [object, key] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) {
    const original = object[key];
    replace(object, key, function (file, flags, ...args) {
      if (!readFlags(flags)) return denied('filesystem open for write')();
      return original.call(this, file, flags, ...args);
    });
  }
  for (const key of ['write', 'writeSync', 'writev', 'writevSync']) {
    const original = fs[key];
    replace(fs, key, function (descriptor, ...args) {
      if (descriptor !== 1 && descriptor !== 2) return denied('filesystem descriptor write')();
      return original.call(this, descriptor, ...args);
    });
  }
}

function packageInfo(entry, expectedName) {
  let directory = path.dirname(entry);
  for (let count = 0; count < 12; count++) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.name === expectedName) return { directory, version: value.version };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Could not identify installed package ' + expectedName);
}

function record(label, actual, expected) {
  assert.equal(actual, expected, label);
  results.push({ label, result: actual });
}
const stat = (directory = false, moduleFullFilePath) => ({
  isDirectory: () => directory,
  ...(moduleFullFilePath === undefined ? {} : { moduleFullFilePath })
});

function loadConsumers() {
  const builderFile = require.resolve('app-builder-lib/out/fileMatcher.js');
  const builderRequire = Module.createRequire(builderFile);
  const builder = packageInfo(builderFile, 'app-builder-lib');
  assert.equal(builder.version, '26.18.0', 'Review fixtures when app-builder-lib consumer changes');
  const builderMatchPath = builderRequire.resolve('minimatch');
  const builderMatch = packageInfo(builderMatchPath, 'minimatch');
  assert.ok(['10.2.6', '11.0.8'].includes(builderMatch.version), 'Expected current baseline or proposed scoped builder minimatch');
  const api = builderRequire(builderFile);
  assert.equal(typeof api.FileMatcher, 'function');
  assert.equal(typeof api.getMainFileMatchers, 'function');

  // Resolve through electron-builder's consumer scope, not a potentially
  // unrelated hoisted package visible from this test file.
  const universalEntry = builderRequire.resolve('@electron/universal');
  const universalRequire = Module.createRequire(universalEntry);
  const universal = packageInfo(universalEntry, '@electron/universal');
  assert.equal(universal.version, '2.0.3', 'Review private consumer extraction when universal changes');
  const universalMatchPath = universalRequire.resolve('minimatch');
  const universalMatch = packageInfo(universalMatchPath, 'minimatch');
  assert.ok(['9.0.9', '11.0.8'].includes(universalMatch.version), 'Expected current baseline or proposed scoped universal minimatch');
  const dependency = universalRequire('minimatch');
  const asarEntry = builderRequire.resolve('@electron/asar');
  const asarRequire = Module.createRequire(asarEntry);
  const legacyMatch = asarRequire('minimatch');
  const legacyVersion = packageInfo(asarRequire.resolve('minimatch'), 'minimatch').version;
  assert.equal(typeof legacyMatch, 'function', 'ASAR legacy callable minimatch must not receive the global major override');
  assert.match(legacyVersion, /^3\./, 'ASAR legacy dependency stays on its supported major');
  const universalAsarRequire = Module.createRequire(universalRequire.resolve('@electron/asar'));
  const universalLegacy = universalAsarRequire('minimatch');
  const universalLegacyVersion = packageInfo(universalAsarRequire.resolve('minimatch'), 'minimatch').version;
  assert.equal(typeof universalLegacy, 'function', 'Universal ASAR legacy callable minimatch must also remain intact');
  assert.match(universalLegacyVersion, /^3\./, 'Universal ASAR dependency stays on its supported major');

  // checkSingleArch is a private PURE function. Compile its actual installed
  // body, not a rewritten equivalent or the native mergeASARs entry point.
  const asarUtils = fs.readFileSync(path.join(universal.directory, 'dist', 'cjs', 'asar-utils.js'), 'utf8');
  const start = asarUtils.indexOf('function checkSingleArch(');
  assert.ok(start >= 0, 'Installed checkSingleArch exists');
  const end = asarUtils.indexOf('\n}', start);
  assert.ok(end > start);
  const context = vm.createContext({ minimatch_1: dependency });
  const singleArch = vm.runInContext(asarUtils.slice(start, end + 2) + '\ncheckSingleArch;', context);
  const universalSource = fs.readFileSync(universalEntry, 'utf8');
  function expression(pattern, label) {
    const matches = [...universalSource.matchAll(pattern)];
    assert.equal(matches.length, 1, 'Installed ' + label + ' match call must be unambiguous');
    return vm.runInContext('(function(opts, machOFile, plistFile) { return ' + matches[0][0] + '; })', context);
  }
  const rejectSameMachO = expression(/opts\.x64ArchFiles === undefined\s*\|\|\s*!\(0,\s*minimatch_1\.minimatch\)\(machOFile\.relativePath,\s*opts\.x64ArchFiles,\s*\{\s*matchBase:\s*true\s*\}\)/g, 'x64ArchFiles');
  // Preserve the installed surrounding boolean, even though the option name
  // suggests a different interpretation. This result means INJECT integrity.
  const injectIntegrity = expression(/!opts\.infoPlistsToIgnore\s*\|\|\s*\(0,\s*minimatch_1\.minimatch\)\(plistFile\.relativePath,\s*opts\.infoPlistsToIgnore,\s*\{\s*matchBase:\s*true\s*\}\)/g, 'infoPlistsToIgnore');
  return { ...api, builderRequire, asarEntry, singleArch, rejectSameMachO, injectIntegrity,
    versions: {
      node: process.version, appBuilder: builder.version, builderMinimatch: builderMatch.version,
      builderMinimatchPath: path.relative(ROOT, builderMatchPath).replace(/\\/g, '/'),
      universal: universal.version, universalMinimatch: universalMatch.version,
      universalMinimatchPath: path.relative(ROOT, universalMatchPath).replace(/\\/g, '/'),
      asarMinimatch: legacyVersion, universalAsarMinimatch: universalLegacyVersion
    } };
}

function runFixtures(consumer) {
  assert.equal(process.platform, 'win32', 'Run these actual Windows consumer fixtures on Windows; no skipped pass');
  const { FileMatcher, getMainFileMatchers, getNodeModuleFileMatcher } = consumer;
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build;
  const destination = path.join(ROOT, 'dist', 'fixture-unpacked', 'resources', 'app');
  const identity = value => value;
  const packager = { info: {
    projectDir: ROOT, buildResourcesDir: config.directories.buildResources, config,
    isPrepackedAppAsar: false, debugLogger: { isEnabled: false }
  } };
  function mainMatcher(build = config) {
    const localPackager = { info: { ...packager.info, config: build } };
    const matchers = getMainFileMatchers(ROOT, destination, identity, {}, localPackager, path.join(ROOT, 'dist'), false);
    assert.equal(matchers.length, 1, 'Current app uses one main FileMatcher');
    return matchers[0];
  }
  const main = mainMatcher(), mainFilter = main.createFilter();
  // Packaging walkers filter directories before visiting descendants. Exercise
  // those real partial-directory calls too, so ".git/config" cannot bypass a
  // pruned ".git" directory in a flat file-only test.
  function admits(filter, relative, directory = false) {
    const parts = relative.split('/');
    for (let length = 1; length < parts.length; length++) {
      if (!filter(path.join(ROOT, ...parts.slice(0, length)), stat(true))) return false;
    }
    return filter(path.join(ROOT, ...parts), stat(directory));
  }
  for (const file of ['package.json', 'main.js', 'preload.js', 'renderer.js', 'index.html', 'run-verdict.js',
    'src/main/helper-reset-controller.js', 'src/preload/compact-shell.js', 'assets/brand/app-mark.png',
    'assets/explore/make-it-gif.png', '.runtime-config', '.config/settings.json', 'assets/.hidden-icon.png']) {
    record('main includes ' + file, admits(mainFilter, file), true);
  }
  for (const file of ['tools/packaging-globs-smoke.js', 'docs/development/notes.txt', 'scripts/native.ps1',
    'nested/deep/native.ps1', 'nested/deep/launch.bat', 'notes.md', 'nested/readme.md', 'debug.log',
    'dist/win-unpacked/app.exe', 'build/icon.ico', 'legacy/old.js', 'feedback-proxy/index.js',
    'design-system/tokens/windows.json', '.git/config', '.github/workflows/release.yml', '.gitignore',
    '.claude/settings.json', '.cursor/rules.json', '.clinerules/rules.json', 'node_modules/.cache/blob',
    'node_modules/runtime/index.js', 'assets/social-preview.png', 'social-preview.png', 'archive.zip',
    'test-fixture/result.json', 'CleanZoom-fixture/run.exe', 'update-acceptance/report.json']) {
    record('main excludes ' + file, admits(mainFilter, file), false);
  }
  record('root itself remains traversable', mainFilter(ROOT, stat(true)), true);

  const onlyIgnores = mainMatcher({ ...config, files: ['!docs/**'] }).createFilter();
  record('main implicit include with exclude-only config', admits(onlyIgnores, 'main.js'), true);
  record('main exclude-only config still prunes docs', admits(onlyIgnores, 'docs/notes.txt'), false);

  const partial = new FileMatcher(ROOT, destination, identity, ['src/main/*.js']).createFilter();
  record('partial admits src directory', partial(path.join(ROOT, 'src'), stat(true)), true);
  record('partial admits src/main directory', partial(path.join(ROOT, 'src', 'main'), stat(true)), true);
  record('partial rejects same name as regular file', partial(path.join(ROOT, 'src'), stat(false)), false);
  record('partial rejects unrelated directory', partial(path.join(ROOT, 'assets'), stat(true)), false);
  record('partial selects requested leaf', admits(partial, 'src/main/worker.js'), true);
  record('partial rejects a deeper leaf outside one star', admits(partial, 'src/main/deep/worker.js'), false);
  const excludedLeaf = new FileMatcher(ROOT, destination, identity, ['**/*', '!src/main/*.js']).createFilter();
  record('negative patterns do not use partial matching on directories', excludedLeaf(path.join(ROOT, 'src', 'main'), stat(true)), true);
  record('negative leaf actually excluded', admits(excludedLeaf, 'src/main/worker.js'), false);

  const windows = new FileMatcher(ROOT, destination, identity, ['.\\src\\**\\*.js']).createFilter();
  record('Windows pattern separators normalize', admits(windows, 'src/main/worker.js'), true);
  record('Windows nested dotfiles use consumer dot:true', admits(windows, 'src/.hidden/worker.js'), true);
  record('Windows doubled root separator normalizes', windows(ROOT + '\\\\src\\main\\worker.js', stat(false)), true);
  record('Windows patterns retain current case-sensitive matching', admits(windows, 'src/main/WORKER.JS'), false);
  const literal = new FileMatcher(ROOT, destination, identity, ['assets']).createFilter();
  record('literal directory automatically includes children', admits(literal, 'assets/nested/icon.png'), true);
  record('literal directory automatically includes dotfiles', admits(literal, 'assets/.icon.png'), true);
  record('literal directory does not include a sibling', admits(literal, 'assets-other/icon.png'), false);
  const selected = new FileMatcher(ROOT, destination, identity, ['**/*', '!assets/**', 'assets/allowed.json']).createFilter();
  record('later include keeps required parent traversable', selected(path.join(ROOT, 'assets'), stat(true)), true);
  record('later include restores selected leaf', admits(selected, 'assets/allowed.json'), true);
  record('later include does not restore other excluded files', admits(selected, 'assets/blocked.json'), false);
  const braces = new FileMatcher(ROOT, destination, identity, ['**/*.{js,json}', '!**/test-@(one|two).js']).createFilter();
  record('brace expansion selects JS', admits(braces, 'src/main.js'), true);
  record('brace expansion selects JSON dotfile', admits(braces, 'src/.settings.json'), true);
  record('brace expansion rejects other extensions', admits(braces, 'src/main.txt'), false);
  record('extglob exclusion selects first alternative', admits(braces, 'src/test-one.js'), false);
  record('extglob exclusion selects second alternative', admits(braces, 'src/test-two.js'), false);
  record('extglob exclusion preserves nonalternative', admits(braces, 'src/test-three.js'), true);
  const archToken = '$' + '{arch}';
  const macro = new FileMatcher(ROOT, destination, value => value.replace(archToken, 'x64'), ['bin/' + archToken + '/**/*.node']).createFilter();
  record('architecture macro expands before glob compilation', admits(macro, 'bin/x64/deep/addon.node'), true);
  record('architecture macro excludes other architecture', admits(macro, 'bin/arm64/addon.node'), false);

  const moduleFilter = getNodeModuleFileMatcher(ROOT, destination, identity, {}, packager.info).createFilter();
  for (const [file, expected] of [['node_modules/runtime/lib/index.js', true], ['node_modules/runtime/README.md', false],
    ['node_modules/.cache/generated.js', false], ['node_modules/runtime/lib/.config.json', true]]) {
    record('runtime dependency filter ' + file, moduleFilter(path.join(ROOT, 'virtual-module-file'), stat(false, file)), expected);
  }

  function unique(file, rule, expected) {
    let admitted = true;
    try { consumer.singleArch('inert-fixture.asar', file, rule); }
    catch (error) { assert.match(error.message, /not covered/); admitted = false; }
    record('universal singleArch ' + file + ' rule=' + String(rule), admitted, expected);
  }
  unique('node_modules/native/binding.node', undefined, false);
  unique('node_modules/native/binding.node', '*.node', true);
  unique('node_modules/native/binding.node', '*.{node,dylib}', true);
  unique('node_modules/native/library.dylib', '*.node', false);
  unique('node_modules/native/.binding.node', '*.node', false);
  unique('node_modules/native/.binding.node', '**/.binding.node', true);
  unique('node_modules/.private/binding.node', '**/*.node', false);
  unique('node_modules/native/binding.node', '**/*.@(node|dylib)', true);
  const macho = { relativePath: 'Contents/Frameworks/library.dylib' };
  record('universal rejects equal MachO without x64 allowlist', consumer.rejectSameMachO({}, macho, {}), true);
  record('universal matchBase admits x64 dylib', consumer.rejectSameMachO({ x64ArchFiles: '*.dylib' }, macho, {}), false);
  record('universal x64 globstar preserves path match', consumer.rejectSameMachO({ x64ArchFiles: '**/Frameworks/*.dylib' }, macho, {}), false);
  record('universal x64 nonmatch remains rejected', consumer.rejectSameMachO({ x64ArchFiles: '*.node' }, macho, {}), true);
  const plist = { relativePath: 'Contents/Frameworks/Helper.app/Contents/Info.plist' };
  record('universal injects integrity when option absent', consumer.injectIntegrity({}, {}, plist), true);
  record('universal installed option match injects integrity', consumer.injectIntegrity({ infoPlistsToIgnore: '*.plist' }, {}, plist), true);
  record('universal installed option nonmatch omits integrity', consumer.injectIntegrity({ infoPlistsToIgnore: '*.json' }, {}, plist), false);
  return config.files;
}

function physicalReadPath(input) {
  assert.ok(path.isAbsolute(input), 'Archive path must be absolute');
  const resolved = path.resolve(input);
  assert.ok(/^C:\\src(?:\\|$)/i.test(resolved), 'Archive reads stay under C:\\src');
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'Archive path must not traverse a link');
    assert.equal(fs.realpathSync.native(current).toLowerCase(), current.toLowerCase(), 'Archive path must remain physical');
  }
  return resolved;
}
function inventoryAsar(consumer, input) {
  const archive = physicalReadPath(input), asar = consumer.builderRequire(consumer.asarEntry);
  const records = [], seen = new Set();
  let totalBytes = 0;
  try {
    for (const raw of asar.listPackage(archive)) {
      const name = raw.replace(/\\/g, '/').replace(/^\/+/, '');
      assert.ok(name && !/[\x00-\x1f:]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Safe archive entry path required');
      assert.equal(seen.has(name), false, 'Duplicate ASAR entry: ' + name); seen.add(name);
      const info = asar.statFile(archive, name, false);
      if ('files' in info) records.push({ path: name, type: 'directory', unpacked: info.unpacked === true });
      else if ('link' in info) records.push({ path: name, type: 'link', link: info.link });
      else {
        assert.ok(Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= 128 * 1024 * 1024, 'Bounded archive entry size');
        totalBytes += info.size; assert.ok(totalBytes <= 512 * 1024 * 1024, 'Bounded archive inventory size');
        if (info.unpacked) physicalReadPath(path.join(archive + '.unpacked', ...name.split('/')));
        const bytes = asar.extractFile(archive, name, false);
        assert.equal(bytes.length, info.size, 'Archive entry length readback');
        records.push({ path: name, type: 'file', size: info.size, executable: info.executable === true,
          unpacked: info.unpacked === true, sha256: sha256(bytes), integrity: info.integrity || null });
      }
    }
  } finally { asar.uncache(archive); }
  records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { archive, entries: records.length, inventorySha256: sha256(Buffer.from(JSON.stringify(records), 'utf8')), records };
}

function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') { assert.equal(options.json, undefined); options.json = true; }
    else if (['--asar', '--compare-asar', '--expect-minimatch'].includes(args[index])) {
      const key = args[index].slice(2); assert.equal(options[key], undefined); assert.ok(args[index + 1]); options[key] = args[++index];
    } else throw new Error('Use --json, --expect-minimatch 11.0.8, or --asar <baseline> --compare-asar <candidate>');
  }
  assert.ok(!options['compare-asar'] || options.asar, '--compare-asar requires --asar');
  // Standalone CLI: retain guards through process exit, including callbacks
  // that an installed dependency might schedule while loading.
  readOnlyGuard();
  process.once('beforeExit', () => {
    if (attemptedEffects.length) {
      console.error('FAIL packaging-globs-smoke: forbidden effect attempted, including late callbacks');
      process.exitCode = 1;
    }
  });
  {
    const consumer = loadConsumers(), patterns = runFixtures(consumer);
    if (options['expect-minimatch']) {
      assert.equal(options['expect-minimatch'], '11.0.8', 'Only the reviewed scoped candidate is supported');
      assert.equal(consumer.versions.builderMinimatch, options['expect-minimatch'], 'Builder must resolve scoped candidate');
      assert.equal(consumer.versions.universalMinimatch, options['expect-minimatch'], 'Universal must resolve scoped candidate');
    }
    const archives = [];
    if (options.asar) archives.push(inventoryAsar(consumer, options.asar));
    if (options['compare-asar']) {
      archives.push(inventoryAsar(consumer, options['compare-asar']));
      const before = new Map(archives[0].records.map(entry => [entry.path, entry]));
      const after = new Map(archives[1].records.map(entry => [entry.path, entry]));
      const differences = [...new Set([...before.keys(), ...after.keys()])].sort()
        .filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)));
      assert.equal(differences.length, 0, 'ASAR inventory mismatch at: ' + differences.slice(0, 20).join(', '));
    }
    assert.deepEqual(attemptedEffects, [], 'No native/network/filesystem effects occurred');
    const report = {
      schemaVersion: 1, versions: consumer.versions, checks: results.length,
      decisionsSha256: sha256(Buffer.from(JSON.stringify(results), 'utf8')),
      buildPatternsSha256: sha256(Buffer.from(JSON.stringify(patterns), 'utf8')), decisions: results,
      archives, archiveComparison: archives.length === 2 ? 'identical' : 'not-requested',
      scope: 'Installed matcher/consumer calls only; no app build, native merge, product launch or UI proof'
    };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const result of results) console.log('  ok  ' + result.label);
      console.log('packaging-globs-smoke: ' + results.length + ' checks passed; decisions=' + report.decisionsSha256);
      console.log('consumers: ' + JSON.stringify(consumer.versions));
      for (const archive of archives) console.log('ASAR inventory: ' + archive.entries + ' entries, sha256=' + archive.inventorySha256 + ', ' + archive.archive);
      if (archives.length === 2) console.log('ASAR comparison: identical');
    }
  }
}

try { main(); }
catch (error) { console.error('FAIL packaging-globs-smoke:', error.message); process.exitCode = 1; }
