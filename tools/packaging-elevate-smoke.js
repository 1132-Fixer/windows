'use strict';

const assert = require('node:assert/strict');
const { CopyElevateHelper } = require('app-builder-lib/out/targets/nsis/nsisUtil');
const { installElevateStrip } = require('../scripts/after-pack-verify-manifest');

async function main() {
  const prototype = CopyElevateHelper.prototype;
  const originalResolve = prototype.resolve;
  const originalAdd = prototype.addToArchive;
  try {
    // Unknown upstream APIs must fail closed, rather than silently shipping
    // an unapproved binary or crashing on a removed method's properties.
    prototype.resolve = undefined;
    assert.throws(installElevateStrip, /Unsupported electron-builder/);
    prototype.resolve = originalResolve;
    prototype.addToArchive = undefined;
    assert.throws(installElevateStrip, /Unsupported electron-builder/);
    prototype.addToArchive = originalAdd;

    // Include instances created before afterPack, as WinPackager does.
    const existing = new CopyElevateHelper();
    existing.elevatePath = Promise.resolve('must-not-be-used.exe');
    assert.equal(installElevateStrip(), true);
    const patched = prototype.resolve;
    assert.equal(installElevateStrip(), true);
    assert.equal(prototype.resolve, patched, 'hook remains idempotent');
    for (const helper of [existing, new CopyElevateHelper()]) {
      assert.equal(await helper.resolve({ options: { perMachine: true } }), null);
      // Real installed consumer must return before accessing target, touching
      // an archive, staging a binary, signing, or scheduling a finalize task.
      const target = new Proxy({}, { get() { throw new Error('Unexpected packaging effect'); } });
      await helper.addToArchive('unused.7z', target, '7z', {}, 'unused');
      assert.equal(helper.stagedUnpackedCopies.size, 0);
    }
  } finally {
    prototype.resolve = originalResolve;
    prototype.addToArchive = originalAdd;
  }
  console.log('packaging-elevate-smoke: API refusal, idempotence, cached/new consumers and archive exclusion passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
