'use strict';

// Real temporary-file transactions and injected IO failures. No repository
// version change, native application, network, Git or release operation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FILES, nextVersion, planVersionBump, bumpVersion } = require('../scripts/bump-version');

let checks = 0;
function check(name, run) {
  run();
  checks++;
  console.log('  ok  ' + name);
}
const DATE = '2026-11-05';
function fixture(version = '6.4.0', lockfileVersion = 3) {
  const rootPackage = { name: '1132-fixer', version, description: 'Preserve identity and data', dependencies: { example: '^1.0.0' } };
  return {
    'package.json': JSON.stringify(rootPackage, null, 2) + '\n',
    'package-lock.json': JSON.stringify({
      name: rootPackage.name, version, lockfileVersion, requires: true,
      packages: {
        '': { name: rootPackage.name, version, dependencies: rootPackage.dependencies },
        'node_modules/example': { version: '6.4.0', resolved: 'https://example.invalid/example.tgz', integrity: 'unchanged' }
      }
    }, null, 2) + '\n',
    'CHANGELOG.md': '# Changelog\n\nExisting introduction.\n\n## [Unreleased]\n\n### Fixed\n\n- Stop repair when required evidence is unavailable.\n\n## [' + version + '] - 2026-09-05\n\nExisting release evidence.\n\n## [6.3.3] - 2026-08-10\n\nOlder notes.\n'
  };
}
function changeJson(contents, file, mutate) {
  const value = JSON.parse(contents[file]);
  mutate(value);
  contents[file] = JSON.stringify(value, null, 2) + '\n';
}
function expectRefusal(mutator, pattern) {
  const contents = fixture();
  mutator(contents);
  const before = JSON.stringify(contents);
  assert.throws(() => planVersionBump(contents, 'patch', DATE), pattern);
  assert.strictEqual(JSON.stringify(contents), before, 'planning failures must not mutate input');
}

console.log('version-bump: version and release-note planning');
for (const [type, expected] of [['patch', '6.4.1'], ['minor', '6.5.0'], ['major', '7.0.0']]) {
  check(type + ' updates all three version records and one release section', () => {
    const contents = fixture();
    const original = JSON.stringify(contents);
    const planned = planVersionBump(contents, type, DATE);
    assert.strictEqual(planned.current, '6.4.0');
    assert.strictEqual(planned.next, expected);
    const pkg = JSON.parse(planned.files['package.json']);
    const lock = JSON.parse(planned.files['package-lock.json']);
    assert.strictEqual(pkg.version, expected);
    assert.strictEqual(lock.version, expected);
    assert.strictEqual(lock.packages[''].version, expected);
    assert.deepStrictEqual(pkg.dependencies, { example: '^1.0.0' });
    assert.strictEqual(pkg.name, '1132-fixer');
    assert.strictEqual(pkg.description, 'Preserve identity and data');
    assert.deepStrictEqual(lock.packages['node_modules/example'], JSON.parse(contents['package-lock.json']).packages['node_modules/example']);
    const notes = planned.files['CHANGELOG.md'];
    assert.ok(notes.includes('## [Unreleased]\n\n## [' + expected + '] - ' + DATE));
    assert.strictEqual(notes.split('- Stop repair when required evidence is unavailable.').length, 2);
    assert.ok(notes.endsWith(contents['CHANGELOG.md'].slice(contents['CHANGELOG.md'].indexOf('## [6.4.0]'))));
    assert.strictEqual(JSON.stringify(contents), original);
  });
}
check('default type is patch and lockfile version 2 remains supported', () => {
  const planned = planVersionBump(fixture('6.4.0', 2), undefined, DATE);
  assert.strictEqual(planned.next, '6.4.1');
  assert.strictEqual(JSON.parse(planned.files['package-lock.json']).lockfileVersion, 2);
});
check('minor and major reset lower components', () => {
  assert.strictEqual(nextVersion('6.9.8', 'minor'), '6.10.0');
  assert.strictEqual(nextVersion('6.9.8', 'major'), '7.0.0');
});
check('CRLF documents retain their line endings', () => {
  const contents = fixture();
  for (const file of FILES) contents[file] = contents[file].replace(/\n/g, '\r\n');
  const planned = planVersionBump(contents, 'patch', DATE);
  for (const file of FILES) assert.ok(!/(?<!\r)\n/.test(planned.files[file]), file);
});
check('invalid bump types and unsafe version numbers fail', () => {
  for (const type of ['', 'PATCH', 'patc', '--help', null]) assert.throws(() => nextVersion('6.4.0', type), /Bump type/);
  for (const version of ['6.4', 'v6.4.0', '06.4.0', '6.4.0-rc.1', '6.4.0+build', '6.4.NaN', null, '9007199254740992.0.0']) {
    assert.throws(() => nextVersion(version, 'patch'), /stable version|safe integer/);
  }
  assert.throws(() => nextVersion('6.4.9007199254740991', 'patch'), /safe integer/);
});
for (const file of FILES) {
  check('missing ' + file + ' is refused', () => expectRefusal((contents) => { delete contents[file]; }, /Missing required file/));
}
check('malformed package JSON is refused', () => expectRefusal((contents) => { contents['package.json'] = '{'; }, /valid JSON/));
check('malformed lock JSON is refused', () => expectRefusal((contents) => { contents['package-lock.json'] = '['; }, /valid JSON/));
check('non-object JSON is refused', () => expectRefusal((contents) => { contents['package-lock.json'] = '[]'; }, /JSON object/));
check('top-level lock mismatch is refused', () => expectRefusal((contents) => changeJson(contents, 'package-lock.json', (lock) => { lock.version = '6.3.3'; }), /versions must agree/));
check('lock packages root mismatch is refused', () => expectRefusal((contents) => changeJson(contents, 'package-lock.json', (lock) => { lock.packages[''].version = '6.3.3'; }), /versions must agree/));
check('missing lock packages root is refused', () => expectRefusal((contents) => changeJson(contents, 'package-lock.json', (lock) => { delete lock.packages['']; }), /contain packages/));
check('obsolete lockfile shape is refused', () => expectRefusal((contents) => changeJson(contents, 'package-lock.json', (lock) => { lock.lockfileVersion = 1; }), /lockfileVersion 2 or 3/));
check('identity mismatch is refused', () => expectRefusal((contents) => changeJson(contents, 'package-lock.json', (lock) => { lock.packages[''].name = 'another-app'; }), /identity must agree/));
check('missing changelog title is refused', () => expectRefusal((contents) => { contents['CHANGELOG.md'] = contents['CHANGELOG.md'].replace('# Changelog', '# Notes'); }, /Changelog heading/));
check('missing Unreleased section is refused', () => expectRefusal((contents) => { contents['CHANGELOG.md'] = contents['CHANGELOG.md'].replace('## [Unreleased]', '## Pending'); }, /exactly one/));
check('duplicate Unreleased section is refused', () => expectRefusal((contents) => { contents['CHANGELOG.md'] += '\n## [Unreleased]\n'; }, /exactly one/));
check('changelog current release mismatch is refused', () => expectRefusal((contents) => { contents['CHANGELOG.md'] = contents['CHANGELOG.md'].replace('## [6.4.0]', '## [6.3.9]'); }, /latest release must match/));
check('duplicate historical release is refused', () => expectRefusal((contents) => { contents['CHANGELOG.md'] += '\n## [6.3.3]\n'; }, /duplicate release/));
check('already present next version is refused', () => expectRefusal((contents) => { contents['CHANGELOG.md'] += '\n## [6.4.1]\n'; }, /already contains/));
check('empty or comment-only notes cannot invent a release', () => {
  for (const notes of ['', '### Fixed\n\n<!-- add evidence -->']) {
    expectRefusal((contents) => { contents['CHANGELOG.md'] = contents['CHANGELOG.md'].replace('### Fixed\n\n- Stop repair when required evidence is unavailable.', notes); }, /Add release notes/);
  }
});
check('invalid release dates are refused', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-1', 'tomorrow', null]) {
    assert.throws(() => planVersionBump(fixture(), 'patch', date), /valid UTC date/);
  }
});

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1132-version-bump-'));
let fixtureCount = 0;
function withDirectory(run) {
  const directory = path.join(temporaryRoot, String(++fixtureCount));
  fs.mkdirSync(directory);
  const originals = fixture();
  for (const file of FILES) fs.writeFileSync(path.join(directory, file), originals[file]);
  fs.writeFileSync(path.join(directory, 'unrelated.txt'), 'keep me');
  run(directory, originals);
}
function readSources(directory) {
  return Object.fromEntries(FILES.map((file) => [file, fs.readFileSync(path.join(directory, file), 'utf8')]));
}
function assertNoTransactionFiles(directory) {
  assert.deepStrictEqual(fs.readdirSync(directory).sort(), [...FILES, 'unrelated.txt'].sort());
  assert.strictEqual(fs.readFileSync(path.join(directory, 'unrelated.txt'), 'utf8'), 'keep me');
}
try {
  console.log('version-bump: isolated file transactions and recovery');
  check('actual transaction changes every record and preserves unrelated data', () => withDirectory((directory) => {
    const result = bumpVersion({ root: directory, date: DATE });
    assert.strictEqual(result.next, '6.4.1');
    const written = readSources(directory);
    assert.strictEqual(JSON.parse(written['package.json']).version, '6.4.1');
    assert.strictEqual(JSON.parse(written['package-lock.json']).version, '6.4.1');
    assert.strictEqual(JSON.parse(written['package-lock.json']).packages[''].version, '6.4.1');
    assert.ok(written['CHANGELOG.md'].includes('## [6.4.1] - ' + DATE));
    assertNoTransactionFiles(directory);
    assert.throws(() => bumpVersion({ root: directory, date: DATE }), /Add release notes/, 'retry must not create another empty release');
  }));
  check('validation failure writes none of the required files', () => withDirectory((directory, originals) => {
    const bad = JSON.parse(originals['package-lock.json']);
    bad.version = '6.3.3';
    fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(bad));
    const before = readSources(directory);
    assert.throws(() => bumpVersion({ root: directory, date: DATE }), /versions must agree/);
    assert.deepStrictEqual(readSources(directory), before);
    assertNoTransactionFiles(directory);
  }));
  check('missing required file cannot partially bump the remaining files', () => withDirectory((directory, originals) => {
    fs.unlinkSync(path.join(directory, 'CHANGELOG.md'));
    assert.throws(() => bumpVersion({ root: directory, date: DATE }), /ENOENT/);
    for (const file of FILES.slice(0, 2)) assert.strictEqual(fs.readFileSync(path.join(directory, file), 'utf8'), originals[file]);
    assert.ok(!fs.existsSync(path.join(directory, '.version-bump.lock')));
  }));
  check('existing writer lock is preserved and prevents any change', () => withDirectory((directory, originals) => {
    const locked = path.join(directory, '.version-bump.lock');
    fs.writeFileSync(locked, 'another owner');
    assert.throws(() => bumpVersion({ root: directory, date: DATE }), /lock already exists/);
    assert.deepStrictEqual(readSources(directory), originals);
    assert.strictEqual(fs.readFileSync(locked, 'utf8'), 'another owner');
  }));
  check('linked required files are refused without needing link privileges', () => withDirectory((directory, originals) => {
    const io = Object.assign({}, fs, { lstatSync() { return { isFile: () => true, isSymbolicLink: () => true }; } });
    assert.throws(() => bumpVersion({ root: directory, date: DATE, io }), /regular file, not a link/);
    assert.deepStrictEqual(readSources(directory), originals);
    assertNoTransactionFiles(directory);
  }));
  check('staging failure leaves original records intact', () => withDirectory((directory, originals) => {
    const io = Object.assign({}, fs, {
      writeFileSync(target, ...args) {
        if (typeof target === 'string' && target.endsWith('.tmp')) throw new Error('simulated disk full');
        return fs.writeFileSync(target, ...args);
      }
    });
    assert.throws(() => bumpVersion({ root: directory, date: DATE, io }), /simulated disk full/);
    assert.deepStrictEqual(readSources(directory), originals);
    assertNoTransactionFiles(directory);
  }));
  check('second replacement failure restores the first replacement', () => withDirectory((directory, originals) => {
    const io = Object.assign({}, fs, {
      renameSync(from, to) {
        if (from.endsWith('.tmp') && path.basename(to) === 'package-lock.json') throw new Error('simulated rename failure');
        return fs.renameSync(from, to);
      }
    });
    assert.throws(() => bumpVersion({ root: directory, date: DATE, io }), /original files restored.*simulated rename failure/);
    assert.deepStrictEqual(readSources(directory), originals);
    assertNoTransactionFiles(directory);
  }));
  check('concurrent edits detected after staging are preserved', () => withDirectory((directory, originals) => {
    const edited = JSON.parse(originals['package.json']);
    edited.description = 'new work by another writer';
    const changed = JSON.stringify(edited);
    const io = Object.assign({}, fs, {
      writeFileSync(target, ...args) {
        const result = fs.writeFileSync(target, ...args);
        if (typeof target === 'string' && path.basename(target).startsWith('CHANGELOG.md.version-bump-') && target.endsWith('.bak')) {
          fs.writeFileSync(path.join(directory, 'package.json'), changed);
        }
        return result;
      }
    });
    assert.throws(() => bumpVersion({ root: directory, date: DATE, io }), /changed during preparation/);
    assert.strictEqual(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'), changed);
    assert.strictEqual(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'), originals['package-lock.json']);
    assertNoTransactionFiles(directory);
  }));
  check('rollback failure retains original backups and reports unfinished recovery', () => withDirectory((directory, originals) => {
    const io = Object.assign({}, fs, {
      renameSync(from, to) {
        if (path.basename(to) === 'package-lock.json' || from.endsWith('.bak')) throw new Error('simulated recovery failure');
        return fs.renameSync(from, to);
      }
    });
    assert.throws(() => bumpVersion({ root: directory, date: DATE, io }), /automatic rollback could not restore package.json.*Preserve/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version, '6.4.1');
    assert.strictEqual(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'), originals['package-lock.json']);
    const backup = fs.readdirSync(directory).find((file) => file.startsWith('package.json.version-bump-') && file.endsWith('.bak'));
    assert.ok(backup);
    assert.strictEqual(fs.readFileSync(path.join(directory, backup), 'utf8'), originals['package.json']);
    assert.ok(!fs.existsSync(path.join(directory, '.version-bump.lock')));
  }));
  check('another writer is not overwritten during rollback', () => withDirectory((directory) => {
    const io = Object.assign({}, fs, {
      renameSync(from, to) {
        if (from.endsWith('.tmp') && path.basename(to) === 'package-lock.json') {
          const edited = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
          edited.description = 'new edit after first replacement';
          fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(edited));
          throw new Error('second write failed');
        }
        return fs.renameSync(from, to);
      }
    });
    assert.throws(() => bumpVersion({ root: directory, date: DATE, io }), /automatic rollback could not restore/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).description, 'new edit after first replacement');
    assert.ok(fs.readdirSync(directory).some((file) => file.endsWith('.bak')));
  }));
} finally {
  // This directory is generated by this test under the OS temporary directory.
  // Verify the absolute containment before recursive cleanup on Windows.
  const physicalTemporaryRoot = fs.realpathSync(temporaryRoot);
  const physicalParent = fs.realpathSync(os.tmpdir());
  const relative = path.relative(physicalParent, physicalTemporaryRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      fs.lstatSync(temporaryRoot).isSymbolicLink() ||
      !path.basename(physicalTemporaryRoot).startsWith('1132-version-bump-')) {
    throw new Error('Refusing unsafe fixture cleanup path.');
  }
  fs.rmSync(physicalTemporaryRoot, { recursive: true, force: true });
}

console.log('version-bump: release preparation policy');
const repository = path.resolve(__dirname, '..');
check('release automation keeps patch semantics and existing tag identity', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repository, '.release-please-config.json'), 'utf8'));
  assert.strictEqual(config['release-type'], 'node');
  assert.strictEqual(config.versioning, 'always-bump-patch');
  assert.strictEqual(config['include-component-in-tag'], false);
  assert.strictEqual(config['include-v-in-tag'], true);
  assert.deepStrictEqual(Object.keys(config.packages), ['.']);
  assert.ok(!Object.hasOwn(config, 'release-as'), 'a fixed release-as must not trap later releases');
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, '.release-please-manifest.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(manifest), ['.']);
  assert.ok(/^\d+\.\d+\.\d+$/.test(manifest['.']));
});
check('preparation workflow has no publication or approval step', () => {
  const workflow = fs.readFileSync(path.join(repository, '.github/workflows/release-prepare.yml'), 'utf8')
    .split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /github\.repository == '1132-Fixer\/windows' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /uses: googleapis\/release-please-action@[a-f0-9]{40}\b/);
  assert.match(workflow, /token: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /skip-github-release: true/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.strictEqual((workflow.match(/^\s+- name:/gm) || []).length, 1);
  assert.doesNotMatch(workflow, /RELEASES_PAT|DESIGN_SYSTEM_TOKEN|auto-merge|approve|^\s+run:/m);
});
console.log('version-bump: ' + checks + ' checks passed');
