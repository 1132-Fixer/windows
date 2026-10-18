'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipReceipt(name, value) {
  const fileName = Buffer.from(name, 'utf8');
  const bytes = Buffer.from(value);
  const crc = crc32(bytes);
  const local = Buffer.alloc(30 + fileName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  fileName.copy(local, 30);
  const central = Buffer.alloc(46 + fileName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  fileName.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + bytes.length, 16);
  return Buffer.concat([local, bytes, central, eocd]);
}

function response({ status = 200, json, bytes = Buffer.alloc(0), headers = {}, body = null }) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        return Object.hasOwn(normalized, key) ? normalized[key] : null;
      }
    },
    json: async () => clone(json),
    arrayBuffer: async () => Buffer.from(bytes),
    body
  };
}

function closedByteStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    }
  });
}

function openByteStream(chunk, state) {
  return new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(chunk)); },
    cancel() { state.cancelled = true; }
  });
}

function cleanupExactFiles(filePaths, directory) {
  for (const filePath of filePaths) {
    try { fs.unlinkSync(filePath); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
  fs.rmdirSync(directory);
}

(async () => {
  const evidenceModule = await import('../scripts/release-evidence.mjs');
  const preflightModule = await import('../scripts/release-preflight.mjs');
  const candidateModule = await import('../scripts/release-candidate.mjs');
  const downloadModule = await import('../scripts/download-release-candidate.mjs');
  const publishModule = await import('../scripts/publish-release.mjs');
  const restModule = await import('../scripts/github-rest.mjs');
  const {
    receiptSha256, validateReleaseEvidence, fetchAuthoritativeReceipt
  } = evidenceModule;
  const { REQUIRED_CHECKS, verifyReleasePreflight } = preflightModule;
  const { generateCandidateManifest, verifyCandidateManifest } = candidateModule;
  const { downloadReleaseCandidate, MAX_CANDIDATE_ARCHIVE_BYTES } = downloadModule;
  const { exactAssets, publishRelease, githubReleaseApi } = publishModule;
  const { createGitHubRestClient, GITHUB_API_VERSION } = restModule;

  const sourceHead = '1'.repeat(40);
  const reviewedHead = '2'.repeat(40);
  const reviewedBase = '3'.repeat(40);
  const tagObjectSha = 'a'.repeat(40);
  const version = '6.4.1';
  const packageHashes = { setup: '4'.repeat(64), portable: '5'.repeat(64) };

  const candidateArtifactId = 7101;
  const candidateRunId = 8101;
  const candidateName = `release-candidate-${sourceHead}`;
  const candidateMetadata = (size, digest) => ({
    id: candidateArtifactId,
    name: candidateName,
    expired: false,
    digest,
    size_in_bytes: size,
    workflow_run: { id: candidateRunId, head_sha: sourceHead }
  });
  const candidateApi = ({ metadata, archive, beforeRequest = null }) => {
    const state = { requests: 0, requestOptions: null };
    return {
      state,
      async json(method, apiPath) {
        assert.equal(method, 'GET');
        assert.equal(apiPath, `/repos/1132-Fixer/windows/actions/artifacts/${candidateArtifactId}`);
        return clone(metadata);
      },
      async request(method, apiPath, options) {
        state.requests++;
        state.requestOptions = options;
        assert.equal(method, 'GET');
        assert.equal(apiPath, `/repos/1132-Fixer/windows/actions/artifacts/${candidateArtifactId}/zip`);
        if (beforeRequest) await beforeRequest();
        return archive;
      }
    };
  };
  const candidateInput = (api, out, digest, extra = {}) => ({
    api,
    repository: '1132-Fixer/windows',
    artifactId: candidateArtifactId,
    runId: candidateRunId,
    expectedName: candidateName,
    expectedHead: sourceHead,
    expectedDigest: digest,
    out,
    ...extra
  });
  {
    const bytes = Buffer.from('bounded-candidate-archive');
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-bounded-'));
    const out = path.join(dir, 'candidate.zip');
    try {
      const api = candidateApi({
        metadata: candidateMetadata(bytes.length, digest),
        archive: response({
          body: closedByteStream([bytes.subarray(0, 5), bytes.subarray(5)]),
          headers: { 'content-length': String(bytes.length) }
        })
      });
      await downloadReleaseCandidate(candidateInput(api, out, digest));
      assert.deepEqual(fs.readFileSync(out), bytes, 'bounded candidate bytes are retained only after exact verification');
      assert.equal(api.state.requests, 1);
      assert.equal(api.state.requestOptions.followRedirects, true,
        'the bounded candidate download keeps the authorized redirect route');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const [name, change] of [
    ['missing candidate size', value => { delete value.size_in_bytes; }],
    ['non-numeric candidate size', value => { value.size_in_bytes = '12'; }],
    ['zero candidate size', value => { value.size_in_bytes = 0; }],
    ['negative candidate size', value => { value.size_in_bytes = -1; }],
    ['over-cap candidate size', value => { value.size_in_bytes = MAX_CANDIDATE_ARCHIVE_BYTES + 1; }]
  ]) {
    const bytes = Buffer.from('size-fixture');
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const metadata = candidateMetadata(bytes.length, digest);
    change(metadata);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-metadata-'));
    const out = path.join(dir, 'candidate.zip');
    try {
      const api = candidateApi({ metadata, archive: null });
      await assert.rejects(downloadReleaseCandidate(candidateInput(api, out, digest)),
        error => error.code === 'candidate-download-size', name);
      assert.equal(api.state.requests, 0, `${name} stops before byte download`);
      assert.equal(fs.existsSync(out), false, `${name} retains no candidate`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    const bytes = Buffer.from('competing-partial-archive');
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-competing-'));
    const out = path.join(dir, 'candidate.zip');
    const partial = `${out}.part-${process.pid}`;
    const competingBytes = Buffer.from('competing-file');
    fs.writeFileSync(partial, competingBytes, { flag: 'wx' });
    try {
      const api = candidateApi({
        metadata: candidateMetadata(bytes.length, digest),
        archive: response({ body: closedByteStream([bytes]) })
      });
      await assert.rejects(downloadReleaseCandidate(candidateInput(api, out, digest)),
        error => error.code === 'candidate-download-output-exists',
        'atomic partial open rejects a competing file');
      assert.equal(api.state.requests, 0, 'a competing partial stops before archive download');
      assert.deepEqual(fs.readFileSync(partial), competingBytes,
        'a partial that this process did not create is not deleted');
      assert.equal(fs.existsSync(out), false, 'a competing partial cannot produce a final candidate');
    } finally {
      fs.unlinkSync(partial);
      fs.rmdirSync(dir);
    }
  }
  {
    const expected = Buffer.from('abc');
    const replacement = Buffer.from('foreign-partial');
    const digest = `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`;
    const streamState = { cancelled: false };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-replaced-failure-'));
    const out = path.join(dir, 'candidate.zip');
    const partial = `${out}.part-${process.pid}`;
    const moved = `${partial}.owned`;
    try {
      const api = candidateApi({
        metadata: candidateMetadata(expected.length, digest),
        archive: response({ body: openByteStream(Buffer.from('abcd'), streamState) }),
        async beforeRequest() {
          await fs.promises.rename(partial, moved);
          await fs.promises.writeFile(partial, replacement, { flag: 'wx' });
        }
      });
      await assert.rejects(downloadReleaseCandidate(candidateInput(api, out, digest)),
        error => error.code === 'candidate-download-cleanup' && error.message === 'candidate-download-cleanup',
        'a replaced partial turns the original stream failure into a stable custody failure');
      assert.equal(streamState.cancelled, true, 'the failed response is still cancelled');
      assert.deepEqual(fs.readFileSync(partial), replacement,
        'failure cleanup preserves a replacement that is not the opened file');
      assert.equal(fs.existsSync(moved), true, 'identity loss closes but does not delete the opened file alias');
      assert.equal(fs.existsSync(out), false, 'identity loss cannot produce a final candidate');
    } finally {
      cleanupExactFiles([partial, moved, out], dir);
    }
  }
  {
    const expected = Buffer.from('verified-candidate');
    const replacement = Buffer.from('foreign-candidate');
    const digest = `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-promotion-race-'));
    const out = path.join(dir, 'candidate.zip');
    const partial = `${out}.part-${process.pid}`;
    const moved = `${partial}.owned`;
    const partialFileSystem = {
      open: (...args) => fs.promises.open(...args),
      unlink: (...args) => fs.promises.unlink(...args),
      lstat: (...args) => fs.promises.lstat(...args),
      async link(source, target) {
        assert.equal(source, partial);
        assert.equal(target, out);
        await fs.promises.rename(source, moved);
        await fs.promises.writeFile(source, replacement, { flag: 'wx' });
        await fs.promises.link(source, target);
      }
    };
    try {
      const api = candidateApi({
        metadata: candidateMetadata(expected.length, digest),
        archive: response({ body: closedByteStream([expected]) })
      });
      await assert.rejects(
        downloadReleaseCandidate(candidateInput(api, out, digest, { partialFileSystem })),
        error => error.code === 'candidate-download-cleanup' && error.message === 'candidate-download-cleanup',
        'a source swap inside promotion cannot turn foreign bytes into an accepted final');
      assert.deepEqual(fs.readFileSync(partial), replacement,
        'promotion custody loss preserves the replacement partial');
      assert.deepEqual(fs.readFileSync(out), replacement,
        'promotion custody loss preserves the foreign final directory entry');
      assert.deepEqual(fs.readFileSync(moved), expected,
        'the bytes hashed through the opened handle remain separate from the foreign paths');
    } finally {
      cleanupExactFiles([out, partial, moved], dir);
    }
  }
  {
    const expected = Buffer.from('late-final-source');
    const competing = Buffer.from('late-final-competitor');
    const digest = `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-late-final-'));
    const out = path.join(dir, 'candidate.zip');
    const partial = `${out}.part-${process.pid}`;
    try {
      const api = candidateApi({
        metadata: candidateMetadata(expected.length, digest),
        archive: response({ body: closedByteStream([expected]) }),
        async beforeRequest() {
          await fs.promises.writeFile(out, competing, { flag: 'wx' });
        }
      });
      await assert.rejects(downloadReleaseCandidate(candidateInput(api, out, digest)),
        error => error.code === 'candidate-download-output-exists',
        'atomic hard-link promotion refuses a final created after the early check');
      assert.deepEqual(fs.readFileSync(out), competing, 'late final competitor survives byte-identical');
      assert.equal(fs.existsSync(partial), false, 'owned partial is removed after no-replace promotion fails');
    } finally {
      cleanupExactFiles([partial, out], dir);
    }
  }
  {
    const expected = Buffer.from('abcd');
    const changed = Buffer.from('wxyz');
    const digest = `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-final-digest-'));
    const out = path.join(dir, 'candidate.zip');
    const partial = `${out}.part-${process.pid}`;
    const partialFileSystem = {
      open: (...args) => fs.promises.open(...args),
      unlink: (...args) => fs.promises.unlink(...args),
      lstat: (...args) => fs.promises.lstat(...args),
      async link(source, target) {
        await fs.promises.link(source, target);
        await fs.promises.writeFile(target, changed);
      }
    };
    try {
      const api = candidateApi({
        metadata: candidateMetadata(expected.length, digest),
        archive: response({ body: closedByteStream([expected]) })
      });
      await assert.rejects(
        downloadReleaseCandidate(candidateInput(api, out, digest, { partialFileSystem })),
        error => error.code === 'candidate-download-digest',
        'the promoted final is rehashed before success');
      assert.equal(fs.existsSync(out), false, 'digest-mismatched promoted final is removed');
      assert.equal(fs.existsSync(partial), false, 'digest-mismatched partial alias is removed');
    } finally {
      cleanupExactFiles([partial, out], dir);
    }
  }
  {
    const bytes = Buffer.from('length-fixture');
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const streamState = { cancelled: false };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-length-'));
    const out = path.join(dir, 'candidate.zip');
    try {
      const api = candidateApi({
        metadata: candidateMetadata(bytes.length, digest),
        archive: response({
          body: openByteStream(bytes, streamState),
          headers: { 'content-length': String(bytes.length + 1) }
        })
      });
      await assert.rejects(downloadReleaseCandidate(candidateInput(api, out, digest)),
        error => error.code === 'candidate-download-size',
        'candidate Content-Length mismatch fails before retention');
      assert.equal(streamState.cancelled, true, 'mismatched candidate response is cancelled');
      assert.equal(fs.existsSync(out), false);
      assert.equal(fs.existsSync(`${out}.part-${process.pid}`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    const expected = Buffer.from('abc');
    const digest = `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`;
    const streamState = { cancelled: false };
    const fileState = { opens: 0, unlinks: 0, readbacks: 0, links: 0 };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-overflow-'));
    const out = path.join(dir, 'candidate.zip');
    const partialFileSystem = {
      open(...args) {
        fileState.opens++;
        return fs.promises.open(...args);
      },
      unlink(...args) {
        fileState.unlinks++;
        return fs.promises.unlink(...args);
      },
      lstat(...args) {
        fileState.readbacks++;
        return fs.promises.lstat(...args);
      },
      link(...args) {
        fileState.links++;
        return fs.promises.link(...args);
      }
    };
    try {
      const api = candidateApi({
        metadata: candidateMetadata(expected.length, digest),
        archive: response({ body: openByteStream(Buffer.from('abcd'), streamState) })
      });
      await assert.rejects(downloadReleaseCandidate(candidateInput(api, out, digest, { partialFileSystem })),
        error => error.code === 'candidate-download-size',
        'chunked candidate overflow fails on its first over-bound chunk');
      assert.equal(streamState.cancelled, true, 'chunked candidate overflow cancels the response');
      assert.equal(fs.existsSync(out), false, 'chunked candidate overflow retains no final file');
      assert.equal(fs.existsSync(`${out}.part-${process.pid}`), false,
        'chunked candidate overflow removes its exact owned partial');
      assert.deepEqual(fileState, { opens: 2, unlinks: 1, readbacks: 2, links: 0 },
        'owned-partial cleanup proves identity, unlinks once, and reads back exact absence');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    const expected = Buffer.from('abc');
    const digest = `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`;
    const streamState = { cancelled: false };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-candidate-cleanup-failure-'));
    const out = path.join(dir, 'candidate.zip');
    const partial = `${out}.part-${process.pid}`;
    const partialFileSystem = {
      open: (...args) => fs.promises.open(...args),
      async unlink(target) {
        assert.equal(target, partial);
        const error = new Error('simulated cleanup failure');
        error.code = 'EACCES';
        throw error;
      },
      lstat: (...args) => fs.promises.lstat(...args),
      link: (...args) => fs.promises.link(...args)
    };
    try {
      const api = candidateApi({
        metadata: candidateMetadata(expected.length, digest),
        archive: response({ body: openByteStream(Buffer.from('abcd'), streamState) })
      });
      await assert.rejects(
        downloadReleaseCandidate(candidateInput(api, out, digest, { partialFileSystem })),
        error => error.code === 'candidate-download-cleanup' && error.message === 'candidate-download-cleanup',
        'a non-ENOENT owned-partial cleanup failure surfaces a stable error');
      assert.equal(streamState.cancelled, true, 'cleanup failure does not mask response cancellation');
      assert.equal(fs.existsSync(out), false, 'cleanup failure cannot produce a final candidate');
      assert.equal(fs.existsSync(partial), true,
        'cleanup failure cannot be reported as clean or residue-free');
    } finally {
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
      fs.rmdirSync(dir);
    }
  }

  const support = {
    schemaVersion: 1,
    sourceHead,
    endpointConfigRevision: '6'.repeat(64),
    backendDeploymentRevision: '7'.repeat(40),
    destinationFingerprint: '8'.repeat(64),
    acknowledgementFingerprint: '9'.repeat(64),
    journeys: []
  };
  for (const kind of ['setup', 'portable']) {
    for (const journey of ['bug-report', 'user-rating', 'contact']) {
      support.journeys.push({
        kind, journey, packageSha256: packageHashes[kind], success: true,
        backendDeploymentRevision: support.backendDeploymentRevision,
        destinationFingerprint: support.destinationFingerprint,
        acknowledgementFingerprint: support.acknowledgementFingerprint,
        receiptSha256: crypto.createHash('sha256').update(`${kind}:${journey}`).digest('hex')
      });
    }
  }
  const supportBytes = Buffer.from(JSON.stringify(support));
  const acceptedPackage = kind => ({
    kind,
    fileName: `1132-Fixer-${kind === 'setup' ? 'Setup' : 'Portable'}-${version}.exe`,
    packageSha256: packageHashes[kind],
    runtimeExecutableSha256: (kind === 'setup' ? 'a' : 'b').repeat(64),
    packageToRuntime: {
      operation: kind === 'setup' ? 'install' : 'extract',
      runtimeSource: kind === 'setup' ? 'installed-package' : 'extracted-package',
      launchObserved: true
    },
    uac: {
      enabled: true, acceptObserved: true, cancelObserved: true,
      disposableWindowsBoundary: true, unmodifiedRequireAdministrator: true
    },
    acceptanceReportSha256: (kind === 'setup' ? 'c' : 'd').repeat(64),
    supportConfigRevision: support.endpointConfigRevision
  });
  const native = {
    schemaVersion: 2,
    sourceHead,
    review: { pullRequest: 233, head: reviewedHead, base: reviewedBase },
    candidate: {
      workflowRunId: 1132,
      artifactId: 6401,
      artifactName: `release-candidate-${sourceHead}`,
      artifactDigest: `sha256:${'e'.repeat(64)}`
    },
    packages: { setup: acceptedPackage('setup'), portable: acceptedPackage('portable') },
    supportClearanceSha256: receiptSha256(supportBytes)
  };
  const nativeBytes = Buffer.from(JSON.stringify(native));
  const validEvidence = validateReleaseEvidence(nativeBytes, supportBytes, {
    expectedHead: sourceHead, expectedVersion: version
  });
  assert.equal(validEvidence.native.packages.setup.packageSha256, packageHashes.setup);
  assert.equal(validEvidence.support.journeys.length, 6);
  assert.throws(() => validateReleaseEvidence(native, supportBytes, {
    expectedHead: sourceHead, expectedVersion: version
  }), error => error.code === 'native-receipt-bytes-required',
  'bare self-authored evidence objects are not release evidence');
  assert.throws(() => validateReleaseEvidence(Buffer.alloc(0), supportBytes, {
    expectedHead: sourceHead, expectedVersion: version
  }), error => error.code === 'native-receipt-bytes-required',
  'missing native receipt bytes fail closed');

  for (const [name, mutate, code] of [
    ['missing live journey', value => { value.journeys.pop(); }, 'support-journey-count'],
    ['wrong backend revision', value => { value.backendDeploymentRevision = 'f'.repeat(40); }, 'support-journey-deployment'],
    ['wrong destination fingerprint', value => { value.destinationFingerprint = 'f'.repeat(64); }, 'support-journey-destination'],
    ['wrong acknowledgement fingerprint', value => { value.acknowledgementFingerprint = 'f'.repeat(64); }, 'support-journey-acknowledgement']
  ]) {
    const changed = clone(support);
    mutate(changed);
    assert.throws(() => validateReleaseEvidence(nativeBytes, Buffer.from(JSON.stringify(changed)), {
      expectedHead: sourceHead, expectedVersion: version
    }), error => error.code === code, name);
  }
  {
    const changed = clone(native);
    changed.packages.setup.packageToRuntime.launchObserved = false;
    assert.throws(() => validateReleaseEvidence(Buffer.from(JSON.stringify(changed)), supportBytes, {
      expectedHead: sourceHead, expectedVersion: version
    }), error => error.code === 'native-package-setup-provenance',
    'missing package-to-runtime launch receipt fails closed');
  }
  {
    const changed = clone(native);
    changed.packages.portable.uac.cancelObserved = false;
    assert.throws(() => validateReleaseEvidence(Buffer.from(JSON.stringify(changed)), supportBytes, {
      expectedHead: sourceHead, expectedVersion: version
    }), error => error.code === 'native-package-portable-uac',
    'missing unmodified UAC cancel evidence fails closed');
  }

  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-release-candidate-'));
  try {
    const candidateNames = [
      `1132-Fixer-Setup-${version}.exe`, `1132-Fixer-Portable-${version}.exe`,
      'checksums-sha256.txt', 'latest.yml', `1132-Fixer-Setup-${version}.exe.blockmap`,
      'signature-state.json', 'package-inventory.json', 'sbom.spdx.json', 'provenance.json'
    ];
    for (const [index, name] of candidateNames.entries()) {
      fs.writeFileSync(path.join(candidateDir, name), Buffer.from(`candidate-${index}`));
    }
    const manifest = generateCandidateManifest({ dist: candidateDir, head: sourceHead, version });
    const setupHash = manifest.assets.find(asset => asset.name.includes('-Setup-') && asset.name.endsWith('.exe')).sha256;
    const portableName = `1132-Fixer-Portable-${version}.exe`;
    const portableHash = manifest.assets.find(asset => asset.name === portableName).sha256;
    verifyCandidateManifest({
      dist: candidateDir, manifest, head: sourceHead, version,
      setupSha256: setupHash, portableSha256: portableHash
    });
    fs.writeFileSync(path.join(candidateDir, 'release-candidate.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(candidateDir, 'native-acceptance.json'), nativeBytes);
    fs.writeFileSync(path.join(candidateDir, 'support-clearance.json'), supportBytes);
    const publisherNames = exactAssets(candidateDir, manifest).map(asset => asset.name);
    const releaseDoc = fs.readFileSync(path.join(ROOT, 'docs', 'development', 'release-process.md'), 'utf8');
    const assetBlock = /<!-- release-assets:start -->([\s\S]*?)<!-- release-assets:end -->/.exec(releaseDoc);
    assert.ok(assetBlock, 'release documentation has a machine-checked asset inventory');
    const documented = [...assetBlock[1].matchAll(/`([^`]+)`/g)].map(match => match[1]).sort();
    const normalized = [...new Set(publisherNames.map(name => name.endsWith('.blockmap')
      ? '*.blockmap'
      : name.replaceAll(version, '<version>')))].sort();
    assert.deepEqual(documented, normalized, 'documented assets exactly match exactAssets()');
    assert.match(releaseDoc,
      /Ordinary JSON and metadata REST calls reject redirects\.[\s\S]*Only bounded artifact-archive and release-asset byte downloads follow redirects/,
      'release documentation distinguishes rejected metadata redirects from bounded byte downloads');
    fs.appendFileSync(path.join(candidateDir, portableName), 'changed');
    assert.throws(() => verifyCandidateManifest({
      dist: candidateDir, manifest, head: sourceHead, version,
      setupSha256: setupHash, portableSha256: portableHash
    }), error => error.code === 'candidate-asset-digest',
    'a changed retained package fails exact candidate verification');
  } finally {
    fs.rmSync(candidateDir, { recursive: true, force: true });
  }

  const rules = [
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: REQUIRED_CHECKS.map(check => ({
          context: check.context, integration_id: check.integrationId
        }))
      }
    },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: true,
        required_review_thread_resolution: true
      }
    }
  ];
  const nativeArchive = zipReceipt('native-acceptance.json', nativeBytes);
  const supportArchive = zipReceipt('support-clearance.json', supportBytes);
  const artifact = (id, runId, name, archive) => ({
    id, name, expired: false,
    digest: `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`,
    workflow_run: { id: runId, head_sha: sourceHead }
  });
  const issuerRun = id => ({
    id, head_sha: sourceHead, head_branch: 'main', event: 'workflow_dispatch',
    path: '.github/workflows/release-evidence.yml', status: 'completed', conclusion: 'success',
    repository: { full_name: '1132-Fixer/windows' },
    actor: { login: 'patricktobias86' }, triggering_actor: { login: 'patricktobias86' }
  });
  const supportIssue = (number, overrides = {}) => ({
    number,
    url: `https://api.github.com/repos/1132-Fixer/support-requests-bug-reporting/issues/${number}`,
    repository_url: 'https://api.github.com/repos/1132-Fixer/support-requests-bug-reporting',
    state: 'closed', closed_at: '2026-10-08T12:00:00Z', labels: [], body: '',
    ...overrides
  });
  const jsonResponses = new Map([
    ['/repos/1132-Fixer/windows', { full_name: '1132-Fixer/windows', default_branch: 'main' }],
    ['/repos/1132-Fixer/windows/git/ref/heads/main', { object: { type: 'commit', sha: sourceHead } }],
    [`/repos/1132-Fixer/windows/git/ref/tags/v${version}`, { object: { type: 'tag', sha: tagObjectSha } }],
    [`/repos/1132-Fixer/windows/git/tags/${tagObjectSha}`, {
      tag: `v${version}`, object: { type: 'commit', sha: sourceHead }
    }],
    ['/repos/1132-Fixer/windows/immutable-releases', { enabled: true, enforced_by_owner: false }],
    ['/repos/1132-Fixer/windows/actions/artifacts/7001', artifact(
      7001, 8001, `native-acceptance-receipt-${sourceHead}`, nativeArchive
    )],
    ['/repos/1132-Fixer/windows/actions/runs/8001', issuerRun(8001)],
    ['/repos/1132-Fixer/windows/actions/artifacts/7002', artifact(
      7002, 8002, `support-clearance-receipt-${sourceHead}`, supportArchive
    )],
    ['/repos/1132-Fixer/windows/actions/runs/8002', issuerRun(8002)],
    ['/repos/1132-Fixer/windows/pulls/233', {
      state: 'closed', merged: true, merge_commit_sha: sourceHead,
      base: { ref: 'main' }, head: { sha: reviewedHead }, user: { login: 'author' }
    }],
    [`/repos/1132-Fixer/windows/git/commits/${sourceHead}`, { parents: [{ sha: reviewedBase }] }],
    ['/repos/1132-Fixer/support-requests-bug-reporting/issues/2', supportIssue(2)],
    ['/repos/1132-Fixer/windows/actions/runs/1132', {
      id: 1132, head_sha: sourceHead, event: 'push', status: 'completed',
      conclusion: 'success', path: '.github/workflows/ci.yml'
    }],
    ['/repos/1132-Fixer/windows/actions/artifacts/6401', {
      id: 6401, name: `release-candidate-${sourceHead}`, expired: false,
      digest: `sha256:${'e'.repeat(64)}`, workflow_run: { id: 1132, head_sha: sourceHead }
    }]
  ]);
  const pageResponses = new Map([
    ['/repos/1132-Fixer/windows/rules/branches/main?per_page=100', { items: rules, pages: 1, complete: true }],
    [`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`, {
      items: REQUIRED_CHECKS.map((check, index) => ({
        id: index + 1, name: check.context, head_sha: sourceHead,
        app: { id: check.integrationId }, status: 'completed', conclusion: 'success'
      })), pages: 1, complete: true
    }],
    ['/repos/1132-Fixer/windows/pulls/233/reviews?per_page=100', {
      items: [{
        id: 1, state: 'APPROVED', commit_id: reviewedHead,
        submitted_at: '2026-10-08T10:00:00Z', user: { login: 'patricktobias86' }
      }], pages: 2, complete: true
    }]
  ]);
  const byteResponses = new Map([
    ['/repos/1132-Fixer/windows/actions/artifacts/7001/zip', nativeArchive],
    ['/repos/1132-Fixer/windows/actions/artifacts/7002/zip', supportArchive]
  ]);
  const resolvedThreads = (after) => after === null
    ? { nodes: [{ id: 'T1', isResolved: true }], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } }
    : { nodes: [{ id: 'T2', isResolved: true }], pageInfo: { hasNextPage: false, endCursor: 'cursor-2' } };
  const makeApi = ({
    jsonMap = jsonResponses, pageMap = pageResponses, byteMap = byteResponses,
    threads = resolvedThreads, reviewDecision = 'APPROVED'
  } = {}) => {
    const calls = [];
    return {
      calls,
      async json(method, apiPath) {
        assert.equal(method, 'GET', 'release preflight is read-only');
        calls.push(`json ${apiPath}`);
        if (!jsonMap.has(apiPath)) throw new Error(`unexpected fixture path ${apiPath}`);
        const value = jsonMap.get(apiPath);
        return value === null ? null : clone(value);
      },
      async paginate(apiPath) {
        calls.push(`paginate ${apiPath}`);
        if (!pageMap.has(apiPath)) throw new Error(`unexpected fixture page ${apiPath}`);
        return clone(pageMap.get(apiPath));
      },
      async bytes(apiPath) {
        calls.push(`bytes ${apiPath}`);
        if (!byteMap.has(apiPath)) throw new Error(`unexpected fixture bytes ${apiPath}`);
        return Buffer.from(byteMap.get(apiPath));
      },
      async graphql(_query, variables) {
        calls.push(`graphql ${variables.after || 'first'}`);
        return {
          repository: {
            pullRequest: { reviewDecision, reviewThreads: clone(threads(variables.after)) }
          }
        };
      }
    };
  };
  const tagEvent = {
    created: true, forced: false, before: '0'.repeat(40), after: tagObjectSha, pusher: 'releasepusher'
  };
  const preflightInput = {
    repository: '1132-Fixer/windows', tag: `v${version}`, sha: sourceHead, version,
    nativeArtifactId: 7001, supportArtifactId: 7002,
    codeownersText: '* @JG2547 @patricktobias86\n', tagEvent
  };
  const api = makeApi();
  const preflight = await verifyReleasePreflight({ ...preflightInput, api });
  assert.equal(preflight.requiredChecks.length, 7);
  assert.equal(preflight.nativeReceipt.issuer.login, 'patricktobias86');
  assert.ok(api.calls.indexOf('json /repos/1132-Fixer/support-requests-bug-reporting/issues/2') <
    api.calls.indexOf('json /repos/1132-Fixer/windows/actions/runs/1132'),
  'support issue clearance is authoritative and precedes candidate access');
  assert.equal(api.calls.filter(call => call.startsWith('graphql ')).length, 2,
    'review threads paginate to exhaustion');

  for (const [name, changedEvent] of [
    ['forced tag update', { ...tagEvent, forced: true, before: 'f'.repeat(40) }],
    ['reused annotated tag', { ...tagEvent, created: false, before: tagObjectSha }]
  ]) {
    const eventApi = makeApi();
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: eventApi, tagEvent: changedEvent }),
      error => error.code === 'tag-event-not-new', name);
    assert.equal(eventApi.calls.length, 0, `${name} stops before repository access`);
  }
  {
    const changed = new Map(jsonResponses);
    changed.set('/repos/1132-Fixer/windows/git/ref/heads/main', { object: { type: 'commit', sha: 'f'.repeat(40) } });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ jsonMap: changed }) }),
      error => error.code === 'tag-not-current-main', 'off-main tag stops in read-only preflight');
  }
  {
    const changed = new Map(jsonResponses);
    changed.set(`/repos/1132-Fixer/windows/git/ref/tags/v${version}`, {
      object: { type: 'commit', sha: sourceHead }
    });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ jsonMap: changed }) }),
      error => error.code === 'annotated-tag-identity', 'lightweight or reused tag identity is rejected');
  }
  for (const [name, state] of [
    ['disabled immutable releases', { enabled: false, enforced_by_owner: false }],
    ['missing immutable-release endpoint', null]
  ]) {
    const changed = new Map(jsonResponses);
    changed.set('/repos/1132-Fixer/windows/immutable-releases', state);
    const immutableApi = makeApi({ jsonMap: changed });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: immutableApi }),
      error => error.code === 'immutable-releases-required', `${name} fails closed`);
    assert.equal(immutableApi.calls.includes('json /repos/1132-Fixer/windows/actions/runs/1132'), false,
      `${name} stops before candidate metadata`);
  }
  {
    const changed = new Map(pageResponses);
    const checkState = clone(changed.get(`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`));
    checkState.items[0].conclusion = 'failure';
    changed.set(`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`, checkState);
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ pageMap: changed }) }),
      error => error.code === 'required-check-not-green', 'failed required check stops before receipt access');
  }
  {
    const changed = new Map(pageResponses);
    const changedRules = clone(rules);
    changedRules[1].parameters.required_review_thread_resolution = false;
    changed.set('/repos/1132-Fixer/windows/rules/branches/main?per_page=100', {
      items: changedRules, pages: 1, complete: true
    });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ pageMap: changed }) }),
      error => error.code === 'ruleset-review-policy', 'provider thread-resolution policy must remain active');
  }
  {
    const changed = new Map(pageResponses);
    changed.set('/repos/1132-Fixer/windows/pulls/233/reviews?per_page=100', {
      items: [], pages: 1, complete: false
    });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ pageMap: changed }) }),
      error => error.code === 'review-pagination-incomplete', 'incomplete review pagination fails closed');
  }
  {
    const changed = new Map(pageResponses);
    changed.set('/repos/1132-Fixer/windows/pulls/233/reviews?per_page=100', {
      items: [{
        id: 2, state: 'CHANGES_REQUESTED', commit_id: reviewedHead,
        submitted_at: '2026-10-08T11:00:00Z', user: { login: 'patricktobias86' }
      }], pages: 1, complete: true
    });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ pageMap: changed }) }),
      error => error.code === 'blocking-review-unresolved', 'current blocking review prevents release');
  }
  await assert.rejects(verifyReleasePreflight({
    ...preflightInput, api: makeApi({ reviewDecision: 'REVIEW_REQUIRED' })
  }), error => error.code === 'provider-review-decision-not-approved',
  'an exact-head REST approval cannot bypass the provider last-push review decision');
  await assert.rejects(verifyReleasePreflight({
    ...preflightInput,
    api: makeApi({ threads: () => ({ nodes: [{ id: 'T1', isResolved: false }], pageInfo: { hasNextPage: false, endCursor: null } }) })
  }), error => error.code === 'review-thread-unresolved', 'unresolved review thread prevents release');
  await assert.rejects(verifyReleasePreflight({
    ...preflightInput,
    api: makeApi({ threads: () => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: null } }) })
  }), error => error.code === 'review-thread-pagination-incomplete', 'incomplete thread pagination fails closed');
  {
    const changed = new Map(jsonResponses);
    const run = clone(changed.get('/repos/1132-Fixer/windows/actions/runs/8001'));
    run.actor.login = 'outsider';
    run.triggering_actor.login = 'outsider';
    changed.set('/repos/1132-Fixer/windows/actions/runs/8001', run);
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ jsonMap: changed }) }),
      error => error.code === 'receipt-issuer-not-independent', 'wrong receipt issuer fails closed');
  }
  {
    const changed = new Map(jsonResponses);
    changed.set('/repos/1132-Fixer/windows/actions/artifacts/7001', null);
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ jsonMap: changed }) }),
      error => error.code === 'receipt-artifact-invalid', 'missing immutable receipt fails closed');
  }
  {
    const changed = new Map(byteResponses);
    const tampered = Buffer.from(nativeArchive);
    tampered[10] ^= 1;
    changed.set('/repos/1132-Fixer/windows/actions/artifacts/7001/zip', tampered);
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi({ byteMap: changed }) }),
      error => error.code === 'receipt-archive-digest', 'tampered receipt archive fails digest verification');
  }
  {
    const wrongNative = clone(native);
    wrongNative.packages.setup.packageSha256 = 'f'.repeat(64);
    const wrongBytes = Buffer.from(JSON.stringify(wrongNative));
    const wrongArchive = zipReceipt('native-acceptance.json', wrongBytes);
    const changedJson = new Map(jsonResponses);
    changedJson.set('/repos/1132-Fixer/windows/actions/artifacts/7001', artifact(
      7001, 8001, `native-acceptance-receipt-${sourceHead}`, wrongArchive
    ));
    const changedBytes = new Map(byteResponses);
    changedBytes.set('/repos/1132-Fixer/windows/actions/artifacts/7001/zip', wrongArchive);
    await assert.rejects(verifyReleasePreflight({
      ...preflightInput, api: makeApi({ jsonMap: changedJson, byteMap: changedBytes })
    }), error => error.code === 'support-journey-package', 'wrong package identity fails receipt cross-binding');
  }
  {
    const changed = new Map(jsonResponses);
    changed.set('/repos/1132-Fixer/support-requests-bug-reporting/issues/2',
      supportIssue(2, { state: 'open', closed_at: null }));
    const issueApi = makeApi({ jsonMap: changed });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: issueApi }),
      error => error.code === 'support-issue-not-cleared', 'open support issue blocks candidate access');
    assert.equal(issueApi.calls.includes('json /repos/1132-Fixer/windows/actions/runs/1132'), false);
  }
  {
    const changed = new Map(jsonResponses);
    changed.set('/repos/1132-Fixer/support-requests-bug-reporting/issues/2', supportIssue(2, {
      state: 'open', closed_at: null, labels: [{ name: 'superseded' }],
      body: 'Superseded-by: https://github.com/1132-Fixer/support-requests-bug-reporting/issues/3'
    }));
    changed.set('/repos/1132-Fixer/support-requests-bug-reporting/issues/3', supportIssue(3));
    const issueApi = makeApi({ jsonMap: changed });
    const superseded = await verifyReleasePreflight({ ...preflightInput, api: issueApi });
    assert.equal(superseded.artifact.id, 6401,
      'a fetched terminal issue in the expected repository permits candidate readback');
    assert.ok(issueApi.calls.indexOf('json /repos/1132-Fixer/support-requests-bug-reporting/issues/3') <
      issueApi.calls.indexOf('json /repos/1132-Fixer/windows/actions/runs/1132'),
    'the terminal supersession target is validated before candidate metadata');
  }
  const supersessionFixture = (issue2, issue3) => {
    const changed = new Map(jsonResponses);
    changed.set('/repos/1132-Fixer/support-requests-bug-reporting/issues/2', issue2);
    if (issue3 !== undefined) {
      changed.set('/repos/1132-Fixer/support-requests-bug-reporting/issues/3', issue3);
    }
    return changed;
  };
  const supersededTo = target => supportIssue(2, {
    state: 'open', closed_at: null, labels: [{ name: 'superseded' }],
    body: `Superseded-by: https://github.com/1132-Fixer/support-requests-bug-reporting/issues/${target}`
  });
  for (const [name, changed, code] of [
    ['missing supersession target', supersessionFixture(supersededTo(3), null), 'support-issue-target-invalid'],
    ['open unresolved supersession target', supersessionFixture(
      supersededTo(3), supportIssue(3, { state: 'open', closed_at: null })
    ), 'support-issue-not-cleared'],
    ['pull request supersession target', supersessionFixture(
      supersededTo(3), supportIssue(3, { pull_request: { url: 'fixture' } })
    ), 'support-issue-target-invalid'],
    ['unrelated returned issue target', supersessionFixture(
      supersededTo(3), supportIssue(3, {
        repository_url: 'https://api.github.com/repos/1132-Fixer/windows'
      })
    ), 'support-issue-target-invalid'],
    ['same issue supersession', supersessionFixture(supersededTo(2)), 'support-supersession-cycle'],
    ['unrelated repository target', supersessionFixture(supportIssue(2, {
      state: 'open', closed_at: null, labels: [{ name: 'superseded' }],
      body: 'Superseded-by: https://github.com/1132-Fixer/windows/issues/3'
    })), 'support-supersession-invalid'],
    ['multiple supersession markers', supersessionFixture(supportIssue(2, {
      state: 'open', closed_at: null, labels: [{ name: 'superseded' }],
      body: [
        'Superseded-by: https://github.com/1132-Fixer/support-requests-bug-reporting/issues/3',
        'Superseded-by: https://github.com/1132-Fixer/support-requests-bug-reporting/issues/4'
      ].join('\n')
    })), 'support-supersession-ambiguous']
  ]) {
    const issueApi = makeApi({ jsonMap: changed });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: issueApi }),
      error => error.code === code, name);
    assert.equal(issueApi.calls.includes('json /repos/1132-Fixer/windows/actions/runs/1132'), false,
      `${name} stops before candidate metadata`);
  }
  {
    const changed = supersessionFixture(supersededTo(3), supportIssue(3, {
      state: 'open', closed_at: null, labels: [{ name: 'superseded' }],
      body: 'Superseded-by: https://github.com/1132-Fixer/support-requests-bug-reporting/issues/2'
    }));
    const issueApi = makeApi({ jsonMap: changed });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: issueApi }),
      error => error.code === 'support-supersession-cycle', 'supersession cycles fail closed');
    assert.equal(issueApi.calls.includes('json /repos/1132-Fixer/windows/actions/runs/1132'), false);
  }
  {
    const changed = new Map(jsonResponses);
    for (let issue = 2; issue <= 9; issue++) {
      changed.set(`/repos/1132-Fixer/support-requests-bug-reporting/issues/${issue}`, supportIssue(issue, {
        state: 'open', closed_at: null, labels: [{ name: 'superseded' }],
        body: `Superseded-by: https://github.com/1132-Fixer/support-requests-bug-reporting/issues/${issue + 1}`
      }));
    }
    const issueApi = makeApi({ jsonMap: changed });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: issueApi }),
      error => error.code === 'support-supersession-depth', 'supersession traversal is bounded');
    assert.equal(issueApi.calls.includes('json /repos/1132-Fixer/windows/actions/runs/1132'), false);
  }
  {
    const changedJson = new Map(jsonResponses);
    const run = clone(changedJson.get('/repos/1132-Fixer/windows/actions/runs/8001'));
    run.actor.login = 'JG2547';
    run.triggering_actor.login = 'JG2547';
    changedJson.set('/repos/1132-Fixer/windows/actions/runs/8001', run);
    const supportRun = clone(changedJson.get('/repos/1132-Fixer/windows/actions/runs/8002'));
    supportRun.actor.login = 'JG2547';
    supportRun.triggering_actor.login = 'JG2547';
    changedJson.set('/repos/1132-Fixer/windows/actions/runs/8002', supportRun);
    const approved = await verifyReleasePreflight({
      ...preflightInput, tagEvent: { ...tagEvent, pusher: 'patricktobias86' },
      api: makeApi({ jsonMap: changedJson })
    });
    assert.equal(approved.artifact.id, 6401,
      'the tag pusher is not substituted for the provider-authoritative last PR pusher');
  }

  const headersSeen = [];
  const restFetch = async (url, options) => {
    headersSeen.push(options.headers);
    if (url.endsWith('/items?page=2')) return response({ json: [{ id: 2 }] });
    if (url.endsWith('/items?per_page=1')) return response({
      json: [{ id: 1 }],
      headers: { link: '<https://api.github.com/items?page=2>; rel="next"' }
    });
    if (url.endsWith('/broken')) return response({
      json: [], headers: { link: 'not-a-link' }
    });
    if (url.endsWith('/graphql')) return response({ json: { data: null, errors: [{ type: 'fixture' }] } });
    throw new Error(`unexpected REST fixture URL ${url}`);
  };
  const rest = createGitHubRestClient({ token: 'fixture-token', userAgent: 'fixture-agent', fetchImpl: restFetch });
  const paginated = await rest.paginate('/items?per_page=1');
  assert.deepEqual(paginated.items, [{ id: 1 }, { id: 2 }]);
  assert.equal(paginated.complete, true);
  assert.ok(headersSeen.every(headers => headers['X-GitHub-Api-Version'] === GITHUB_API_VERSION));
  await assert.rejects(rest.paginate('/broken'), error => error.code === 'github-pagination-link');
  await assert.rejects(rest.graphql('query Fixture { viewer { login } }', {}),
    error => error.code === 'github-graphql-failed');

  {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({
        url, method: options.method, redirect: options.redirect,
        version: options.headers['X-GitHub-Api-Version']
      });
      return response({ json: { enabled: true, enforced_by_owner: false } });
    };
    try {
      const state = await githubReleaseApi({
        repository: '1132-Fixer/windows', token: 'fixture-token'
      }).getImmutableReleaseState();
      assert.equal(state.enabled, true);
      assert.deepEqual(calls, [{
        url: 'https://api.github.com/repos/1132-Fixer/windows/immutable-releases',
        method: 'GET', redirect: 'error', version: GITHUB_API_VERSION
      }], 'the publisher uses the versioned ordinary-REST immutable-release endpoint');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const receiptOnlyApi = makeApi();
  const fetched = await fetchAuthoritativeReceipt({
    api: receiptOnlyApi, repository: '1132-Fixer/windows', artifactId: 7001,
    head: sourceHead, kind: 'native'
  });
  assert.deepEqual(fetched.bytes, nativeBytes);

  const bytes = ['setup', 'portable', 'latest'].map(value => Buffer.from(value));
  const assets = bytes.map((value, index) => ({
    name: ['Setup.exe', 'Portable.exe', 'latest.yml'][index],
    file: `fixture-${index}`,
    size: value.length,
    sha256: crypto.createHash('sha256').update(value).digest('hex'),
    bytes: value
  }));
  const publicationApi = ({
    uploadAt = -1, readbackAt = -1, wrongTagTarget = false,
    immutableState = { enabled: true, enforced_by_owner: false }
  } = {}) => {
    const state = { draft: null, public: false, latest: null, assets: [], uploadIndex: 0, tagReads: 0 };
    return {
      state,
      resolveTag: async tag => {
        state.tagReads++;
        return { tag, tagObjectSha, targetSha: wrongTagTarget ? 'f'.repeat(40) : sourceHead };
      },
      getImmutableReleaseState: async () => immutableState,
      getReleaseByTag: async () => null,
      createDraft: async ({ tag, prerelease }) => (state.draft = {
        id: 44, draft: true, tag_name: tag, prerelease
      }),
      uploadAsset: async (_releaseId, asset) => {
        const index = state.uploadIndex++;
        if (uploadAt === index) throw Object.assign(new Error('fixture-upload'), { code: 'fixture-upload' });
        const source = assets.find(item => item.name === asset.name);
        const created = { id: 100 + index, name: asset.name, size: asset.size, state: 'uploaded', source };
        state.assets.push(created);
        return created;
      },
      getAsset: async id => state.assets.find(asset => asset.id === id),
      readAsset: async (id, expectedSize) => {
        const source = state.assets.find(asset => asset.id === id).source;
        const index = id - 100;
        assert.equal(expectedSize, source.size, 'publisher binds readback to the exact local asset size');
        return { size: source.size, sha256: readbackAt === index ? 'f'.repeat(64) : source.sha256 };
      },
      listAssets: async () => state.assets,
      publishDraft: async (_id, { makeLatest }) => {
        state.public = true;
        state.draft = { ...state.draft, draft: false };
        if (makeLatest) state.latest = state.draft;
        return state.draft;
      },
      getLatestRelease: async () => state.latest
    };
  };
  {
    const originalFetch = globalThis.fetch;
    const payload = Buffer.from('bounded-release-asset');
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      return response({ body: closedByteStream([payload.subarray(0, 4), payload.subarray(4)]) });
    };
    try {
      const readback = await githubReleaseApi({
        repository: '1132-Fixer/windows', token: 'fixture-token'
      }).readAsset(100, payload.length);
      assert.equal(readback.size, payload.length);
      assert.equal(readback.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
      assert.deepEqual(calls, [{
        url: 'https://api.github.com/repos/1132-Fixer/windows/releases/assets/100',
        redirect: 'follow'
      }], 'an exact bounded asset read keeps the authorized redirect route');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  {
    const originalFetch = globalThis.fetch;
    const payload = Buffer.from('length-bound-release-asset');
    const streamState = { cancelled: false };
    globalThis.fetch = async () => response({
      body: openByteStream(payload, streamState),
      headers: { 'content-length': String(payload.length + 1) }
    });
    try {
      await assert.rejects(githubReleaseApi({
        repository: '1132-Fixer/windows', token: 'fixture-token'
      }).readAsset(100, payload.length), error => error.code === 'publication-asset-readback',
      'release asset Content-Length mismatch fails before stream consumption');
      assert.equal(streamState.cancelled, true, 'mismatched release asset response is cancelled');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  {
    const originalFetch = globalThis.fetch;
    const publication = publicationApi();
    const streamState = { cancelled: false };
    globalThis.fetch = async () => response({
      body: openByteStream(Buffer.alloc(assets[0].size + 1), streamState)
    });
    publication.readAsset = githubReleaseApi({
      repository: '1132-Fixer/windows', token: 'fixture-token'
    }).readAsset;
    try {
      await assert.rejects(publishRelease({
        api: publication, repository: '1132-Fixer/windows', tag: `v${version}`,
        head: sourceHead, version, assets
      }), error => error.code === 'publication-asset-readback',
      'chunked release asset overflow fails at the exact local-size boundary');
      assert.equal(streamState.cancelled, true, 'chunked release asset overflow cancels the response');
      assert.equal(publication.state.public, false, 'stream overflow leaves no public release');
      assert.equal(publication.state.latest, null, 'stream overflow leaves latest unchanged');
      assert.equal(publication.state.draft.draft, true, 'stream overflow retains only a draft');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  for (let index = 0; index < assets.length; index++) {
    const publication = publicationApi({ uploadAt: index });
    await assert.rejects(publishRelease({
      api: publication, repository: '1132-Fixer/windows', tag: `v${version}`,
      head: sourceHead, version, assets
    }));
    assert.equal(publication.state.public, false, `asset ${index} failure leaves no public release`);
    assert.equal(publication.state.latest, null, `asset ${index} failure leaves latest unchanged`);
    assert.equal(publication.state.draft.draft, true, `asset ${index} failure retains only a draft`);
  }
  for (let index = 0; index < assets.length; index++) {
    const publication = publicationApi({ readbackAt: index });
    await assert.rejects(publishRelease({
      api: publication, repository: '1132-Fixer/windows', tag: `v${version}`,
      head: sourceHead, version, assets
    }));
    assert.equal(publication.state.public, false, `asset ${index} digest failure leaves no public release`);
    assert.equal(publication.state.latest, null, `asset ${index} digest failure leaves latest unchanged`);
  }
  {
    const publication = publicationApi({ wrongTagTarget: true });
    await assert.rejects(publishRelease({
      api: publication, repository: '1132-Fixer/windows', tag: `v${version}`,
      head: sourceHead, version, assets
    }), error => error.code === 'publication-tag-identity');
    assert.equal(publication.state.draft, null, 'wrong annotated-tag target stops before draft creation');
  }
  for (const [name, immutableState] of [
    ['disabled immutable releases', { enabled: false, enforced_by_owner: false }],
    ['missing immutable-release endpoint', null]
  ]) {
    const publication = publicationApi({ immutableState });
    await assert.rejects(publishRelease({
      api: publication, repository: '1132-Fixer/windows', tag: `v${version}`,
      head: sourceHead, version, assets
    }), error => error.code === 'publication-immutable-releases-required', name);
    assert.equal(publication.state.draft, null, `${name} stops before draft creation`);
    assert.equal(publication.state.public, false, `${name} cannot publish`);
  }
  {
    const publication = publicationApi();
    const published = await publishRelease({
      api: publication, repository: '1132-Fixer/windows', tag: `v${version}`,
      head: sourceHead, version, assets
    });
    assert.equal(published.draft, false);
    assert.equal(publication.state.latest.id, 44);
    assert.equal(publication.state.tagReads, 3, 'annotated tag is read before draft, after draft and after publication');
  }

  const releaseYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const evidenceYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-evidence.yml'), 'utf8');
  const preflightIndex = releaseYml.indexOf('  preflight:');
  const publishIndex = releaseYml.indexOf('  publish:');
  const retainIndex = releaseYml.indexOf('Retain exact release transaction inputs');
  const transactionIndex = releaseYml.indexOf('Draft, verify and publish exact assets');
  assert.ok(preflightIndex >= 0 && publishIndex > preflightIndex && releaseYml.includes('needs: preflight'));
  assert.ok(!releaseYml.includes('electron-builder') && !releaseYml.includes('softprops/action-gh-release'));
  assert.ok(retainIndex > publishIndex && transactionIndex > retainIndex,
    'retention and every prior gate run before the only publication transaction');
  assert.ok(releaseYml.includes('node scripts/release-preflight.mjs') &&
    releaseYml.includes('node scripts/publish-release.mjs') &&
    releaseYml.includes('RELEASE_REF_CREATED: ${{ github.event.created }}') &&
    releaseYml.includes('RELEASE_REF_FORCED: ${{ github.event.forced }}') &&
    releaseYml.includes('RELEASE_REF_BEFORE: ${{ github.event.before }}'),
  'every tag path binds the new-ref event before draft publication');
  assert.ok(releaseYml.includes('NATIVE_ACCEPTANCE_ARTIFACT_ID') &&
    releaseYml.includes('SUPPORT_CLEARANCE_ARTIFACT_ID') &&
    !releaseYml.includes('NATIVE_ACCEPTANCE_MANIFEST') &&
    !releaseYml.includes('SUPPORT_RELEASE_CLEARANCE'),
  'release consumes immutable receipt identifiers, never self-authored JSON variables');
  assert.ok(evidenceYml.includes('workflow_dispatch:') &&
    evidenceYml.includes('node scripts/issue-release-evidence.mjs') &&
    evidenceYml.includes('overwrite: false'),
  'receipt issuer validates bytes on protected main before immutable upload');

  console.log('release-safety-smoke: immutable receipts, new-tag identity, complete authorization and draft publication negatives passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
