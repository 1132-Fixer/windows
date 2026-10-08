'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));

(async () => {
  const evidenceModule = await import('../scripts/release-evidence.mjs');
  const preflightModule = await import('../scripts/release-preflight.mjs');
  const candidateModule = await import('../scripts/release-candidate.mjs');
  const publishModule = await import('../scripts/publish-release.mjs');
  const { evidenceSha256, validateReleaseEvidence } = evidenceModule;
  const { REQUIRED_CHECKS, verifyReleasePreflight } = preflightModule;
  const { generateCandidateManifest, verifyCandidateManifest } = candidateModule;
  const { publishRelease } = publishModule;

  const sourceHead = '1'.repeat(40);
  const reviewedHead = '2'.repeat(40);
  const reviewedBase = '3'.repeat(40);
  const version = '6.4.1';
  const packageHashes = { setup: '4'.repeat(64), portable: '5'.repeat(64) };
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
  const acceptedPackage = (kind) => ({
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
    supportClearanceSha256: evidenceSha256(support)
  };

  const validEvidence = validateReleaseEvidence(native, support, { expectedHead: sourceHead, expectedVersion: version });
  assert.equal(validEvidence.native.packages.setup.packageSha256, packageHashes.setup);
  assert.equal(validEvidence.support.journeys.length, 6);
  assert.throws(() => validateReleaseEvidence({}, support, { expectedHead: sourceHead, expectedVersion: version }),
    error => error.code === 'native-manifest-shape', 'missing native acceptance evidence fails before API access');
  assert.throws(() => validateReleaseEvidence(native, {}, { expectedHead: sourceHead, expectedVersion: version }),
    error => error.code === 'support-clearance-shape', 'missing support clearance fails before API access');

  for (const [name, mutate, code] of [
    ['missing live journey', value => { value.journeys.pop(); }, 'support-journey-count'],
    ['wrong backend revision', value => { value.backendDeploymentRevision = 'f'.repeat(40); }, 'support-journey-deployment'],
    ['wrong destination fingerprint', value => { value.destinationFingerprint = 'f'.repeat(64); }, 'support-journey-destination'],
    ['wrong acknowledgement fingerprint', value => { value.acknowledgementFingerprint = 'f'.repeat(64); }, 'support-journey-acknowledgement']
  ]) {
    const changed = clone(support);
    mutate(changed);
    assert.throws(() => validateReleaseEvidence(native, changed, { expectedHead: sourceHead, expectedVersion: version }),
      error => error.code === code, name);
  }
  {
    const changed = clone(native);
    changed.packages.setup.packageToRuntime.launchObserved = false;
    assert.throws(() => validateReleaseEvidence(changed, support, { expectedHead: sourceHead, expectedVersion: version }),
      error => error.code === 'native-package-setup-provenance',
    'missing package-to-runtime launch receipt fails closed');
  }
  {
    const changed = clone(native);
    changed.packages.portable.uac.cancelObserved = false;
    assert.throws(() => validateReleaseEvidence(changed, support, { expectedHead: sourceHead, expectedVersion: version }),
      error => error.code === 'native-package-portable-uac',
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
    const setupHash = manifest.assets.find(asset => asset.name.includes('-Setup-')).sha256;
    const portableName = `1132-Fixer-Portable-${version}.exe`;
    const portableHash = manifest.assets.find(asset => asset.name === portableName).sha256;
    verifyCandidateManifest({
      dist: candidateDir, manifest, head: sourceHead, version,
      setupSha256: setupHash, portableSha256: portableHash
    });
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
        require_last_push_approval: true
      }
    }
  ];
  const responses = new Map([
    ['/repos/1132-Fixer/windows', { default_branch: 'main' }],
    ['/repos/1132-Fixer/windows/git/ref/heads/main', { object: { sha: sourceHead } }],
    ['/repos/1132-Fixer/windows/rules/branches/main', rules],
    [`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`, {
      check_runs: REQUIRED_CHECKS.map((check, index) => ({
        id: index + 1, name: check.context, head_sha: sourceHead,
        app: { id: check.integrationId }, status: 'completed', conclusion: 'success'
      }))
    }],
    ['/repos/1132-Fixer/windows/pulls/233', {
      state: 'closed', merged: true, merge_commit_sha: sourceHead,
      base: { ref: 'main' }, head: { sha: reviewedHead }, user: { login: 'author' }
    }],
    [`/repos/1132-Fixer/windows/git/commits/${sourceHead}`, { parents: [{ sha: reviewedBase }] }],
    ['/repos/1132-Fixer/windows/pulls/233/reviews?per_page=100', [{
      id: 1, state: 'APPROVED', commit_id: reviewedHead,
      submitted_at: '2026-10-08T10:00:00Z', user: { login: 'patricktobias86' }
    }]],
    ['/repos/1132-Fixer/windows/actions/runs/1132', {
      id: 1132, head_sha: sourceHead, event: 'push', status: 'completed',
      conclusion: 'success', path: '.github/workflows/ci.yml'
    }],
    ['/repos/1132-Fixer/windows/actions/artifacts/6401', {
      id: 6401, name: `release-candidate-${sourceHead}`, expired: false,
      digest: `sha256:${'e'.repeat(64)}`, workflow_run: { id: 1132, head_sha: sourceHead }
    }]
  ]);
  const makeApi = map => async (method, apiPath) => {
    assert.equal(method, 'GET', 'release preflight is read-only');
    if (!map.has(apiPath)) throw new Error(`unexpected fixture path ${apiPath}`);
    return clone(map.get(apiPath));
  };
  const preflightInput = {
    api: makeApi(responses), repository: '1132-Fixer/windows', tag: `v${version}`,
    sha: sourceHead, version, nativeManifest: native, supportClearance: support,
    codeownersText: '* @JG2547 @patricktobias86\n'
  };
  const preflight = await verifyReleasePreflight(preflightInput);
  assert.equal(preflight.requiredChecks.length, 7);

  {
    const changed = new Map(responses);
    changed.set('/repos/1132-Fixer/windows/git/ref/heads/main', { object: { sha: 'f'.repeat(40) } });
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi(changed) }),
      error => error.code === 'tag-not-current-main', 'off-main tag stops in read-only preflight');
  }
  {
    const changed = new Map(responses);
    const checkState = clone(changed.get(`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`));
    checkState.check_runs[0].conclusion = 'failure';
    changed.set(`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`, checkState);
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi(changed) }),
      error => error.code === 'required-check-not-green', 'stale or failed required check stops before candidate access');
  }
  {
    const changed = new Map(responses);
    const checkState = clone(changed.get(`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`));
    checkState.check_runs[0].head_sha = 'f'.repeat(40);
    changed.set(`/repos/1132-Fixer/windows/commits/${sourceHead}/check-runs?filter=latest&per_page=100`, checkState);
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi(changed) }),
      error => error.code === 'required-check-not-green', 'stale-SHA required check stops before candidate access');
  }
  {
    const changed = new Map(responses);
    changed.set('/repos/1132-Fixer/windows/pulls/233/reviews?per_page=100', []);
    await assert.rejects(verifyReleasePreflight({ ...preflightInput, api: makeApi(changed) }),
      error => error.code === 'independent-codeowner-approval-missing', 'missing exact-head independent review stops');
  }

  const bytes = ['setup', 'portable', 'latest'].map(value => Buffer.from(value));
  const assets = bytes.map((value, index) => ({
    name: ['Setup.exe', 'Portable.exe', 'latest.yml'][index],
    file: `fixture-${index}`,
    size: value.length,
    sha256: crypto.createHash('sha256').update(value).digest('hex'),
    bytes: value
  }));
  const publicationApi = ({ uploadAt = -1, readbackAt = -1, wrongDraftTarget = false } = {}) => {
    const state = { draft: null, public: false, latest: null, assets: [], uploadIndex: 0 };
    return {
      state,
      getReleaseByTag: async () => null,
      createDraft: async ({ tag, head, prerelease }) => (state.draft = {
        id: 44, draft: true, tag_name: tag,
        target_commitish: wrongDraftTarget ? 'f'.repeat(40) : head,
        prerelease
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
      readAsset: async id => {
        const source = state.assets.find(asset => asset.id === id).source;
        const index = id - 100;
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
  for (let index = 0; index < assets.length; index++) {
    const api = publicationApi({ uploadAt: index });
    await assert.rejects(publishRelease({
      api, repository: '1132-Fixer/windows', tag: `v${version}`, head: sourceHead, version, assets
    }));
    assert.equal(api.state.public, false, `asset ${index} failure leaves no public release`);
    assert.equal(api.state.latest, null, `asset ${index} failure leaves latest unchanged`);
    assert.equal(api.state.draft.draft, true, `asset ${index} failure retains only a draft`);
  }
  for (let index = 0; index < assets.length; index++) {
    const api = publicationApi({ readbackAt: index });
    await assert.rejects(publishRelease({
      api, repository: '1132-Fixer/windows', tag: `v${version}`, head: sourceHead, version, assets
    }));
    assert.equal(api.state.public, false, `asset ${index} digest failure leaves no public release`);
    assert.equal(api.state.latest, null, `asset ${index} digest failure leaves latest unchanged`);
  }
  {
    const api = publicationApi({ wrongDraftTarget: true });
    await assert.rejects(publishRelease({
      api, repository: '1132-Fixer/windows', tag: `v${version}`, head: sourceHead, version, assets
    }), error => error.code === 'publication-draft-create');
    assert.equal(api.state.public, false, 'a draft on the wrong commit is never published');
  }
  {
    const api = publicationApi();
    const published = await publishRelease({
      api, repository: '1132-Fixer/windows', tag: `v${version}`, head: sourceHead, version, assets
    });
    assert.equal(published.draft, false);
    assert.equal(api.state.latest.id, 44);
  }

  const releaseYml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const preflightIndex = releaseYml.indexOf('  preflight:');
  const publishIndex = releaseYml.indexOf('  publish:');
  const retainIndex = releaseYml.indexOf('Retain exact release transaction inputs');
  const transactionIndex = releaseYml.indexOf('Draft, verify and publish exact assets');
  assert.ok(preflightIndex >= 0 && publishIndex > preflightIndex && releaseYml.includes('needs: preflight'));
  assert.ok(!releaseYml.includes('electron-builder') && !releaseYml.includes('softprops/action-gh-release'));
  assert.ok(retainIndex > publishIndex && transactionIndex > retainIndex,
    'retention and every prior gate run before the only publication transaction');
  assert.ok(releaseYml.includes('node scripts/release-preflight.mjs') &&
    releaseYml.includes('node scripts/publish-release.mjs'),
  'every tag path uses the read-only preflight and draft-first publisher');

  console.log('release-safety-smoke: evidence, exact-main/check/review preflight, and draft publication negatives passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
