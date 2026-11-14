'use strict';

// Inert synthetic policy tests. Fictional SHAs, verifier and device below are
// NOT release/native evidence. All collectors, verifiers and publishers are
// callbacks held in memory. No network, Git, worker, Windows or file writes.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
let finished = false;
let checks = 0;
process.once('beforeExit', () => {
  if (!finished) { console.error('FAIL release-policy: asynchronous harness did not complete'); process.exitCode = 1; }
});
const copy = value => JSON.parse(JSON.stringify(value));
const S = 'a'.repeat(40), H = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const NOW = 1000000, OBSERVED = 999900, VERSION = '6.4.1';
const hash = value => createHash('sha256').update(value).digest('hex');

async function main() {
  const { REPOSITORY, MAX_FACT_AGE_MS, MIN_REQUIRED_CONTEXTS, NATIVE_CASES,
    assetSetDigest, evaluateReleasePolicy, publishReleaseIfAdmitted } = await import('../scripts/release-policy.mjs');

  function fixture() {
    const assets = [
      '1132-Fixer-Setup-' + VERSION + '.exe', '1132-Fixer-Portable-' + VERSION + '.exe',
      '1132-Fixer-Setup-' + VERSION + '.exe.blockmap',
      'latest.yml', 'checksums-sha256.txt', 'signature-state.json', 'package-inventory.json',
      'sbom.spdx.json', 'provenance.json'
    ].map((name, index) => ({ id: index + 1, name, size: 1024 + index, sha256: hash('fictional-asset:' + name) }));
    const assetSetSha256 = assetSetDigest(assets);
    const snapshot = {
      repository: REPOSITORY, sourceSha: S, tagTargetSha: S, version: VERSION, tag: 'v' + VERSION,
      releaseId: 101, draft: true, prerelease: false, publishedAtMs: null,
      observedAtMs: 920000, assets, assetSetSha256,
      validation: { state: 'verified', method: 'downloaded-bytes', sourceSha: S, assetSetSha256,
        checksums: 'verified', updaterMetadata: 'verified', packageInventory: 'verified', signatureState: 'unsigned-compatible' }
    };
    const facts = {
      schemaVersion: 1, repository: REPOSITORY, observedAtMs: OBSERVED,
      source: { sha: S, mainSha: S, branch: 'main', associatedPullRequestsComplete: true, associatedPullRequestNumbers: [999] },
      versions: { packageJson: VERSION, lockfile: VERSION, lockRoot: VERSION, tag: 'v' + VERSION, latestPublished: '6.4.0' },
      protection: { complete: true, sourceSha: S, requiredContexts: MIN_REQUIRED_CONTEXTS.map(name => ({ name, appId: 15368 })) },
      checks: { complete: true, sourceSha: S, items: MIN_REQUIRED_CONTEXTS.map((name, index) => ({
        name, appId: 15368, id: index + 100, sha: S, latest: true, status: 'completed', conclusion: 'success', completedAtMs: 915000
      })) },
      pullRequest: { number: 999, repository: REPOSITORY, baseBranch: 'main', headSha: H,
        mergeCommitSha: S, merged: true, reviewDecision: 'APPROVED', authorLogin: 'FixtureAuthor',
        lastPusherLogin: 'FixturePusher', lastPushedAtMs: 900000, mergedAtMs: 910000 },
      codeOwners: { complete: true, sourceSha: S, path: '.github/CODEOWNERS', items: [
        { login: 'JG2547', actorType: 'User', permission: 'write' },
        { login: 'patricktobias86', actorType: 'User', permission: 'write' }
      ] },
      reviews: { complete: true, items: [{ id: 55, login: 'patricktobias86', actorType: 'User',
        commitSha: H, state: 'APPROVED', dismissed: false, submittedAtMs: 905000 }] },
      threads: { complete: true, items: [] },
      prepared: copy(snapshot), prepublish: { ...copy(snapshot), observedAtMs: OBSERVED }
    };
    const setup = assets.find(asset => asset.name.includes('-Setup-'));
    const portable = assets.find(asset => asset.name.includes('-Portable-'));
    const native = {
      kind: 'externally-verified-native-acceptance', state: 'verified',
      method: 'authenticated-operator-review', verifierLogin: 'FixtureVerifier',
      evidenceId: 'fictional-evidence-only', evidenceSha256: hash('fictional-report'),
      deviceId: 'FIXTURE-NO-DEVICE', platform: 'win32', mocked: false, testCopy: false,
      sourceSha: S, version: VERSION, assetSetSha256, requirementsComplete: true, verifiedAtMs: 940000,
      cases: NATIVE_CASES.map(name => ({ name, status: 'passed', native: true, mocked: false, testCopy: false,
        artifactSha256: name.startsWith('portable-') ? portable.sha256 : setup.sha256,
        evidenceSha256: hash('fictional-case:' + name), observedAtMs: 930000 }))
    };
    return { facts, native };
  }
  async function attempt(facts, native, options = {}) {
    let collected = 0, verified = 0, published = 0, seen;
    const result = await publishReleaseIfAdmitted({
      collectFacts: async () => {
        collected++;
        if (options.collectFailsAt === collected) throw new Error('private collector detail');
        const selected = copy(facts);
        if (collected === 2 && options.mutateFresh) options.mutateFresh(selected);
        return { facts: selected, nowMs: NOW };
      },
      verifyNativeEvidence: async expected => {
        verified++;
        assert.equal(Object.isFrozen(expected), true);
        assert.equal(expected.repository, REPOSITORY);
        if (options.verifyFails) throw new Error('private native detail');
        return native === undefined ? undefined : copy(native);
      },
      publish: async admission => {
        published++; seen = admission;
        assert.equal(Object.isFrozen(admission), true);
        assert.equal(Object.isFrozen(admission.assets), true);
        if (options.publishFails) throw new Error('private uncertain publication detail');
      }
    });
    return { result, collected, verified, published, seen };
  }
  async function check(name, test) { await test(); checks++; console.log('  ok  ' + name); }
  async function refuse(name, mutate, code, mutateNative) {
    await check(name, async () => {
      const { facts, native } = fixture();
      if (mutate) mutate(facts);
      if (mutateNative) mutateNative(native);
      const before = JSON.stringify({ facts, native });
      const actual = await attempt(facts, native);
      assert.equal(actual.result.ok, false);
      assert.equal(actual.published, 0, 'publication callback must never run after refusal');
      if (code) assert.ok(actual.result.errors.some(error => error.code === code), JSON.stringify(actual.result.errors));
      assert.equal(JSON.stringify({ facts, native }), before, 'policy cannot mutate input records');
    });
  }
  function rehash(snapshot) {
    snapshot.assetSetSha256 = assetSetDigest(snapshot.assets);
    snapshot.validation.assetSetSha256 = snapshot.assetSetSha256;
  }

  await check('valid synthetic facts require separate verifier and publish exactly once after a fresh read', async () => {
    const { facts, native } = fixture();
    const result = await attempt(facts, native);
    assert.equal(result.result.ok, true); assert.equal(result.collected, 2);
    assert.equal(result.verified, 1); assert.equal(result.published, 1);
    assert.equal(result.seen.sourceSha, S);
    assert.equal(result.seen.reviewedHeadSha, H, 'review head differs correctly from squash/merge source');
    assert.equal(result.seen.codeOwnerReviewId, 55);
    assert.equal(result.seen.assets.length, 9, 'only the exact canonical nine-file set is admitted');
    assert.equal(result.seen.assets.filter(asset => asset.name === '1132-Fixer-Setup-' + VERSION + '.exe.blockmap').length, 1);
    assert.equal(result.result.outcome, 'publication-callback-completed');
  });
  await check('same facts produce the same deterministic immutable admission', () => {
    const { facts, native } = fixture();
    const first = evaluateReleasePolicy(facts, { nowMs: NOW, nativeVerification: native });
    assert.deepEqual(first, evaluateReleasePolicy(copy(facts), { nowMs: NOW, nativeVerification: copy(native) }));
    assert.equal(first.ok, true); assert.equal(first.publicationAttempted, false);
    assert.equal(Object.isFrozen(first.admission.assets[0]), true);
    assert.throws(() => { first.admission.assets[0].size = 1; }, TypeError);
  });
  await check('asset digest and comparison ignore input order and object property order', async () => {
    const { facts, native } = fixture();
    facts.prepublish.assets = facts.prepublish.assets.slice().reverse().map(asset => ({
      sha256: asset.sha256, size: asset.size, name: asset.name, id: asset.id
    }));
    assert.equal(assetSetDigest(facts.prepublish.assets), facts.prepared.assetSetSha256);
    assert.equal((await attempt(facts, native)).published, 1);
  });
  await refuse('foreign repository refused', facts => { facts.repository = 'other/windows'; }, 'REPOSITORY_MISMATCH');
  await refuse('unknown schema refused', facts => { facts.schemaVersion = 2; }, 'SCHEMA_UNSUPPORTED');
  await refuse('stale provider snapshot refused', facts => { facts.observedAtMs = NOW - MAX_FACT_AGE_MS - 1; }, 'FACTS_STALE');
  await refuse('future provider snapshot refused', facts => { facts.observedAtMs = NOW + 1; }, 'FACTS_STALE');
  await refuse('source outside main refused', facts => { facts.source.branch = 'feature'; }, 'SOURCE_NOT_EXACT_MAIN');
  await refuse('main advancement refused', facts => { facts.source.mainSha = OTHER; }, 'SOURCE_NOT_EXACT_MAIN');
  await refuse('short source SHA refused', facts => { facts.source.sha = 'aaaa'; }, 'SOURCE_NOT_EXACT_MAIN');
  for (const key of ['lockfile', 'lockRoot']) {
    await refuse(key + ' version drift refused', facts => { facts.versions[key] = '6.4.0'; }, 'VERSION_IDENTITY_MISMATCH');
  }
  await refuse('tag version drift refused', facts => { facts.versions.tag = 'v6.4.2'; }, 'VERSION_IDENTITY_MISMATCH');
  await refuse('prerelease package refused', facts => { facts.versions.packageJson = '6.4.1-rc.1'; }, 'VERSION_IDENTITY_MISMATCH');
  for (const malformed of [{}, [], ['6.4.1']]) {
    await refuse('nonstring version ' + JSON.stringify(malformed) + ' refuses without throwing', facts => {
      facts.versions.packageJson = malformed;
    }, 'VERSION_IDENTITY_MISMATCH');
  }
  await refuse('reused published version refused', facts => { facts.versions.latestPublished = VERSION; }, 'VERSION_NOT_FORWARD_STABLE');
  await refuse('downgrade refused', facts => { facts.versions.latestPublished = '6.5.0'; }, 'VERSION_NOT_FORWARD_STABLE');
  await refuse('unknown published baseline refused', facts => { delete facts.versions.latestPublished; }, 'VERSION_NOT_FORWARD_STABLE');
  await refuse('incomplete required contexts refused', facts => { facts.protection.complete = false; }, 'REQUIRED_CONTEXTS_UNVERIFIED');
  await refuse('foreign required-context source refused', facts => { facts.protection.sourceSha = OTHER; }, 'REQUIRED_CONTEXTS_UNVERIFIED');
  await refuse('unbound expected app identity refused', facts => { facts.protection.requiredContexts[0].appId = null; }, 'REQUIRED_CONTEXT_IDENTITY_INVALID');
  for (const name of MIN_REQUIRED_CONTEXTS) {
    await refuse('omitted required rule ' + name, facts => {
      facts.protection.requiredContexts = facts.protection.requiredContexts.filter(item => item.name !== name);
    }, 'REQUIRED_CONTEXT_OMITTED');
    await refuse('missing required result ' + name, facts => {
      facts.checks.items = facts.checks.items.filter(item => item.name !== name);
    }, 'CHECK_MISSING_OR_AMBIGUOUS');
  }
  await refuse('additional live required context cannot be ignored', facts => {
    facts.protection.requiredContexts.push({ name: 'Additional protection', appId: 15368 });
  }, 'CHECK_MISSING_OR_AMBIGUOUS');
  await refuse('wrong check app cannot satisfy a required name', facts => { facts.checks.items[0].appId = 999; }, 'CHECK_MISSING_OR_AMBIGUOUS');
  await refuse('ambiguous duplicate checks refused', facts => { facts.checks.items.push({ ...facts.checks.items[0], id: 999 }); }, 'CHECK_MISSING_OR_AMBIGUOUS');
  await refuse('one check ID cannot prove two different required contexts', facts => {
    facts.checks.items[1].id = facts.checks.items[0].id;
  }, 'CHECK_ID_REUSED');
  await refuse('old check SHA refused', facts => { facts.checks.items[0].sha = H; }, 'CHECK_NOT_CURRENT_SUCCESS');
  await refuse('non-latest check refused', facts => { facts.checks.items[0].latest = false; }, 'CHECK_NOT_CURRENT_SUCCESS');
  await refuse('pending check refused', facts => { facts.checks.items[0].status = 'in_progress'; }, 'CHECK_NOT_CURRENT_SUCCESS');
  for (const conclusion of ['failure', 'neutral', 'skipped', 'timed_out', 'cancelled', 'action_required', 'stale']) {
    await refuse('check conclusion ' + conclusion + ' refused', facts => { facts.checks.items[0].conclusion = conclusion; }, 'CHECK_NOT_CURRENT_SUCCESS');
  }
  await refuse('incomplete check pagination refused', facts => { facts.checks.complete = false; }, 'CHECK_COLLECTION_UNVERIFIED');
  await refuse('unmerged PR refused', facts => { facts.pullRequest.merged = false; }, 'REVIEWED_MERGE_MAPPING_UNVERIFIED');
  await refuse('wrong merge/source mapping refused', facts => { facts.pullRequest.mergeCommitSha = H; }, 'REVIEWED_MERGE_MAPPING_UNVERIFIED');
  await refuse('wrong base branch refused', facts => { facts.pullRequest.baseBranch = 'other'; }, 'REVIEWED_MERGE_MAPPING_UNVERIFIED');
  await refuse('provider review decision not approved refused', facts => { facts.pullRequest.reviewDecision = 'REVIEW_REQUIRED'; }, 'REVIEWED_MERGE_MAPPING_UNVERIFIED');
  await refuse('incomplete source PR association refused', facts => { facts.source.associatedPullRequestsComplete = false; }, 'SOURCE_PR_ASSOCIATION_UNVERIFIED');
  await refuse('different associated PR refused', facts => { facts.source.associatedPullRequestNumbers = [1000]; }, 'SOURCE_PR_ASSOCIATION_UNVERIFIED');
  await refuse('unknown last pusher refused', facts => { delete facts.pullRequest.lastPusherLogin; }, 'PR_PUSH_IDENTITY_UNVERIFIED');
  await check('bot-authored version PR still requires and accepts independent human owner review', async () => {
    const { facts, native } = fixture();
    facts.pullRequest.authorLogin = 'github-actions[bot]';
    facts.pullRequest.lastPusherLogin = 'github-actions[bot]';
    const actual = await attempt(facts, native);
    assert.equal(actual.published, 1);
    assert.equal(actual.seen.codeOwnerReviewId, 55);
  });
  await refuse('foreign CODEOWNERS source refused', facts => { facts.codeOwners.sourceSha = H; }, 'CODEOWNERS_SCOPE_UNVERIFIED');
  await refuse('invented code owner refused', facts => { facts.codeOwners.items[1].login = 'FixtureVerifier'; }, 'CODEOWNER_IDENTITY_UNVERIFIED');
  await refuse('read-only code owner approval refused', facts => { facts.codeOwners.items[1].permission = 'read'; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('missing approval refused', facts => { facts.reviews.items = []; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('incomplete reviews refused', facts => { facts.reviews.complete = false; }, 'REVIEW_COLLECTION_UNVERIFIED');
  await refuse('self approval refused case-insensitively', facts => { facts.pullRequest.authorLogin = 'PATRICKTOBIAS86'; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('last-pusher approval refused', facts => { facts.pullRequest.lastPusherLogin = 'patricktobias86'; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('dismissed approval refused', facts => { facts.reviews.items[0].dismissed = true; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('stale review head refused', facts => { facts.reviews.items[0].commitSha = OTHER; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('pre-push approval refused', facts => { facts.reviews.items[0].submittedAtMs = 899999; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('post-merge approval cannot replace required pre-merge review', facts => { facts.reviews.items[0].submittedAtMs = 911000; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('bot approval refused', facts => { facts.reviews.items[0].actorType = 'Bot'; }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await refuse('newer changes requested invalidates old approval', facts => {
    facts.reviews.items.push({ ...facts.reviews.items[0], id: 56, state: 'REQUEST_CHANGES', submittedAtMs: 906000 });
  }, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED');
  await check('later comment does not erase a valid opinionated approval', async () => {
    const { facts, native } = fixture();
    facts.reviews.items.push({ ...facts.reviews.items[0], id: 56, state: 'COMMENTED', submittedAtMs: 906000 });
    assert.equal((await attempt(facts, native)).published, 1);
  });
  await check('normal bot comments neither invalidate nor provide human code-owner approval', async () => {
    const { facts, native } = fixture();
    facts.reviews.items.push({ ...facts.reviews.items[0], id: 57,
      login: 'copilot-pull-request-reviewer[bot]', actorType: 'Bot', state: 'COMMENTED', submittedAtMs: 906000 });
    assert.equal((await attempt(facts, native)).published, 1);
    facts.reviews.items = [{ ...facts.reviews.items[1], state: 'APPROVED' }];
    const refused = await attempt(facts, native);
    assert.equal(refused.published, 0);
    assert.ok(refused.result.errors.some(error => error.code === 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED'));
  });
  await refuse('incomplete threads refused', facts => { facts.threads.complete = false; }, 'THREAD_COLLECTION_UNVERIFIED');
  await refuse('unresolved thread refused', facts => { facts.threads.items = [{ id: 'thread-a', resolved: false }]; }, 'REVIEW_THREAD_UNRESOLVED');
  await refuse('missing prepared draft refused', facts => { delete facts.prepared; }, 'DRAFT_SNAPSHOT_REQUIRED');
  await refuse('published release refused', facts => { facts.prepublish.draft = false; facts.prepublish.publishedAtMs = 995000; }, 'DRAFT_IDENTITY_UNVERIFIED');
  await refuse('draft prerelease refused', facts => { facts.prepublish.prerelease = true; }, 'DRAFT_IDENTITY_UNVERIFIED');
  await refuse('wrong tag target refused', facts => { facts.prepublish.tagTargetSha = H; }, 'DRAFT_IDENTITY_UNVERIFIED');
  await refuse('changed draft ID refused', facts => { facts.prepublish.releaseId++; }, 'DRAFT_CHANGED_AFTER_PREPARATION');
  await refuse('stale prepublication read refused', facts => { facts.prepublish.observedAtMs = NOW - MAX_FACT_AGE_MS - 1; }, 'DRAFT_SNAPSHOT_STALE');
  await refuse('asset replacement ID refused even with identical bytes', facts => { facts.prepublish.assets[0].id = 999; }, 'DRAFT_CHANGED_AFTER_PREPARATION');
  await refuse('tampered Portable bytes refused', facts => {
    facts.prepublish.assets.find(asset => asset.name.includes('-Portable-')).sha256 = hash('altered portable');
    rehash(facts.prepublish);
  }, 'DRAFT_CHANGED_AFTER_PREPARATION');
  for (const snapshotName of ['prepared', 'prepublish']) {
    for (const requiredName of fixture().facts.prepared.assets.map(asset => asset.name)) {
      await refuse(snapshotName + ' missing canonical file ' + requiredName + ' never publishes', facts => {
        facts[snapshotName].assets = facts[snapshotName].assets.filter(asset => asset.name !== requiredName);
        rehash(facts[snapshotName]);
      }, 'REQUIRED_ASSET_MISSING');
    }
  }
  await refuse('the former eight-file set without Setup blockmap is refused even when both snapshots agree', facts => {
    for (const snapshotName of ['prepared', 'prepublish']) {
      facts[snapshotName].assets = facts[snapshotName].assets.filter(asset => !asset.name.endsWith('.blockmap'));
      rehash(facts[snapshotName]);
    }
  }, 'ASSET_SET_NOT_EXACT');
  await refuse('Portable blockmap is an extra upload rather than an optional release file', facts => {
    for (const snapshotName of ['prepared', 'prepublish']) {
      facts[snapshotName].assets.push({ id: 999, name: '1132-Fixer-Portable-' + VERSION + '.exe.blockmap',
        size: 256, sha256: hash('fictional extra Portable blockmap') });
      rehash(facts[snapshotName]);
    }
  }, 'ASSET_NOT_ALLOWED');
  await refuse('a Setup blockmap for another version cannot satisfy the canonical file', facts => {
    for (const snapshotName of ['prepared', 'prepublish']) {
      facts[snapshotName].assets.find(asset => asset.name.endsWith('.blockmap')).name = '1132-Fixer-Setup-6.4.0.exe.blockmap';
      rehash(facts[snapshotName]);
    }
  }, 'ASSET_NOT_ALLOWED');
  for (const malformedName of ['LATEST.YML', 'latest.yml ', 'latest.yml.', '../latest.yml', 'latest.yml:stream']) {
    await refuse('noncanonical upload name ' + JSON.stringify(malformedName) + ' never publishes', facts => {
      for (const snapshotName of ['prepared', 'prepublish']) {
        facts[snapshotName].assets.find(asset => asset.name === 'latest.yml').name = malformedName;
        // Path-shaped input is malformed even for digest construction. Other
        // variants get internally consistent digests and must still be refused.
        if (!malformedName.includes('/')) rehash(facts[snapshotName]);
      }
    }, 'ASSET_NOT_ALLOWED');
  }
  await refuse('canonical and differently cased duplicate names are ambiguous', facts => {
    const original = facts.prepublish.assets.find(asset => asset.name === 'latest.yml');
    facts.prepublish.assets.push({ ...original, id: 999, name: 'LATEST.YML' });
  }, 'ASSET_NAME_AMBIGUOUS');
  await check('digest construction refuses case-ambiguous sets before they can receive a digest', () => {
    const assets = fixture().facts.prepared.assets;
    const original = assets.find(asset => asset.name === 'latest.yml');
    assert.throws(() => assetSetDigest([...assets, { ...original, id: 999, name: 'LATEST.YML' }]), /case-ambiguous/);
  });
  for (const [field, malformed] of [['size', 0], ['sha256', 'not-a-digest'], ['id', 0]]) {
    await refuse('malformed canonical asset ' + field + ' never publishes', facts => {
      facts.prepublish.assets[0][field] = malformed;
    }, field === 'id' ? 'ASSET_NOT_ALLOWED' : 'ASSET_IDENTITY_INVALID');
  }
  await refuse('missing required metadata refused', facts => {
    facts.prepublish.assets = facts.prepublish.assets.filter(asset => asset.name !== 'latest.yml');
    rehash(facts.prepublish);
  }, 'REQUIRED_ASSET_MISSING');
  await refuse('unlisted upload refused', facts => {
    facts.prepublish.assets.push({ id: 999, name: 'private-extra.txt', size: 123, sha256: hash('private') }); rehash(facts.prepublish);
  }, 'ASSET_NOT_ALLOWED');
  await refuse('duplicate asset names refused', facts => { facts.prepublish.assets.push({ ...facts.prepublish.assets[0], id: 999 }); }, 'ASSET_IDENTITY_INVALID');
  for (const malformed of [{}, [], 42, null]) {
    await refuse('nonstring asset name ' + JSON.stringify(malformed) + ' refuses without sorting it', facts => {
      facts.prepublish.assets[0].name = malformed;
    }, 'ASSET_IDENTITY_INVALID');
  }
  await refuse('missing actual byte validation refused', facts => { facts.prepublish.validation.method = 'metadata-only'; }, 'ASSET_BYTES_NOT_VERIFIED');
  await refuse('unchecked checksums refused', facts => { facts.prepublish.validation.checksums = 'unknown'; }, 'ASSET_BYTES_NOT_VERIFIED');
  await refuse('unknown inventory refused', facts => { facts.prepublish.validation.packageInventory = 'unknown'; }, 'ASSET_BYTES_NOT_VERIFIED');
  await refuse('wrong signing posture refused', facts => { facts.prepublish.validation.signatureState = 'claimed-signed'; }, 'ASSET_BYTES_NOT_VERIFIED');

  await check('CI totals and fixture-green facts cannot substitute for the separate native verifier', async () => {
    const { facts } = fixture();
    facts.nativeAccepted = true; facts.testTotals = { passed: 9999, failed: 0 };
    const actual = await attempt(facts, undefined);
    assert.equal(actual.published, 0);
    assert.ok(actual.result.errors.some(error => error.code === 'NATIVE_EXTERNAL_VERIFICATION_REQUIRED'));
  });
  await check('bare verifier true is not acceptance evidence', async () => {
    const { facts } = fixture(); const actual = await attempt(facts, true);
    assert.equal(actual.published, 0);
    assert.ok(actual.result.errors.some(error => error.code === 'NATIVE_EXTERNAL_VERIFICATION_REQUIRED'));
  });
  await refuse('native CI-green origin refused', null, 'NATIVE_EVIDENCE_ORIGIN_UNVERIFIED', native => { native.method = 'green-ci-job'; });
  await refuse('mocked native receipt refused', null, 'NATIVE_EVIDENCE_ORIGIN_UNVERIFIED', native => { native.mocked = true; });
  await refuse('altered test-copy native receipt refused', null, 'NATIVE_EVIDENCE_ORIGIN_UNVERIFIED', native => { native.testCopy = true; });
  await refuse('foreign native source refused', null, 'NATIVE_EVIDENCE_IDENTITY_MISMATCH', native => { native.sourceSha = H; });
  await refuse('foreign native version refused', null, 'NATIVE_EVIDENCE_IDENTITY_MISMATCH', native => { native.version = '6.4.0'; });
  await refuse('foreign native asset digest refused', null, 'NATIVE_EVIDENCE_IDENTITY_MISMATCH', native => { native.assetSetSha256 = hash('other assets'); });
  await refuse('incomplete native requirements refused', null, 'NATIVE_EVIDENCE_IDENTITY_MISMATCH', native => { native.requirementsComplete = false; });
  await refuse('native evidence predating the prepared artifacts refused', null, 'NATIVE_EVIDENCE_TIME_UNVERIFIED', native => { native.verifiedAtMs = 919999; });
  await refuse('native evidence after prepublication snapshot refused', null, 'NATIVE_EVIDENCE_TIME_UNVERIFIED', native => { native.verifiedAtMs = NOW + 1; });
  for (const name of NATIVE_CASES) {
    await refuse('missing native case ' + name, null, 'NATIVE_REQUIRED_CASE_MISSING', native => {
      native.cases = native.cases.filter(item => item.name !== name);
    });
  }
  for (const status of ['failed', 'not-run', 'skipped', 'unknown']) {
    await refuse('native status ' + status + ' refused', null, 'NATIVE_CASE_NOT_VERIFIED', native => { native.cases[0].status = status; });
  }
  await refuse('native case for another artifact refused', null, 'NATIVE_CASE_NOT_VERIFIED', native => { native.cases[0].artifactSha256 = hash('different setup'); });
  await refuse('native case without evidence digest refused', null, 'NATIVE_CASE_NOT_VERIFIED', native => { delete native.cases[0].evidenceSha256; });

  await check('facts are recollected and rechecked after external native verification', async () => {
    const { facts, native } = fixture();
    const actual = await attempt(facts, native, { mutateFresh(value) { value.checks.items[0].conclusion = 'failure'; } });
    assert.equal(actual.collected, 2); assert.equal(actual.verified, 1); assert.equal(actual.published, 0);
    assert.ok(actual.result.errors.some(error => error.code === 'CHECK_NOT_CURRENT_SUCCESS'));
  });
  await check('changing both draft snapshots between reads cannot admit a replacement release ID', async () => {
    const { facts, native } = fixture();
    const actual = await attempt(facts, native, { mutateFresh(value) { value.prepared.releaseId++; value.prepublish.releaseId++; } });
    assert.equal(actual.published, 0);
    assert.ok(actual.result.errors.some(error => error.code === 'PUBLICATION_IDENTITY_CHANGED'));
  });
  await check('changing both uploaded asset IDs between reads is refused', async () => {
    const { facts, native } = fixture();
    const actual = await attempt(facts, native, { mutateFresh(value) {
      value.prepared.assets[0].id = 999; value.prepublish.assets[0].id = 999;
    } });
    assert.equal(actual.published, 0);
    assert.ok(actual.result.errors.some(error => error.code === 'PUBLICATION_IDENTITY_CHANGED'));
  });
  for (const collectFailsAt of [1, 2]) {
    await check('collector failure at read ' + collectFailsAt + ' never publishes', async () => {
      const { facts, native } = fixture(); const actual = await attempt(facts, native, { collectFailsAt });
      assert.equal(actual.published, 0); assert.equal(actual.result.errors[0].code, 'FACT_COLLECTION_FAILED');
      assert.ok(!JSON.stringify(actual.result).includes('private collector'));
    });
  }
  await check('external verifier failure never publishes or leaks details', async () => {
    const { facts, native } = fixture(); const actual = await attempt(facts, native, { verifyFails: true });
    assert.equal(actual.published, 0); assert.equal(actual.result.errors[0].code, 'NATIVE_EXTERNAL_VERIFICATION_FAILED');
    assert.ok(!JSON.stringify(actual.result).includes('private native'));
  });
  await check('publication exception is uncertain and is never retried', async () => {
    const { facts, native } = fixture(); const actual = await attempt(facts, native, { publishFails: true });
    assert.equal(actual.published, 1); assert.equal(actual.result.publicationAttempted, true);
    assert.equal(actual.result.outcome, 'uncertain');
    assert.equal(actual.result.errors[0].code, 'PUBLICATION_OUTCOME_UNCERTAIN');
    assert.ok(!JSON.stringify(actual.result).includes('private uncertain'));
  });
  await check('missing effect adapters refuse without executing anything', async () => {
    assert.equal((await publishReleaseIfAdmitted()).errors[0].code, 'PUBLICATION_ADAPTER_REQUIRED');
    assert.equal((await publishReleaseIfAdmitted(null)).errors[0].code, 'PUBLICATION_ADAPTER_REQUIRED');
  });
  await check('accessor collector envelopes are refused without executing getters or publication', async () => {
    let accessed = false, published = 0, verified = 0;
    const envelope = { nowMs: NOW };
    Object.defineProperty(envelope, 'facts', { enumerable: true, get() { accessed = true; return fixture().facts; } });
    const result = await publishReleaseIfAdmitted({
      collectFacts: async () => envelope,
      verifyNativeEvidence: async () => { verified++; return fixture().native; },
      publish: async () => { published++; }
    });
    assert.equal(result.errors[0].code, 'FACT_COLLECTION_FAILED');
    assert.equal(accessed, false); assert.equal(verified, 0); assert.equal(published, 0);
  });
  await check('malformed facts, accessors, sparse arrays and cycles refuse without reading getters', () => {
    const { facts, native } = fixture();
    for (const value of [null, [], true, 'green']) assert.equal(evaluateReleasePolicy(value, { nowMs: NOW, nativeVerification: native }).ok, false);
    let accessed = false;
    const withGetter = { ...facts };
    Object.defineProperty(withGetter, 'source', { get() { accessed = true; return facts.source; }, enumerable: true });
    assert.equal(evaluateReleasePolicy(withGetter, { nowMs: NOW, nativeVerification: native }).errors[0].code, 'FACTS_NOT_NORMALIZED_DATA');
    assert.equal(accessed, false);
    const sparse = copy(facts); sparse.threads.items = Array(1);
    assert.equal(evaluateReleasePolicy(sparse, { nowMs: NOW, nativeVerification: native }).ok, false);
    const cycle = copy(facts); cycle.cycle = cycle;
    assert.equal(evaluateReleasePolicy(cycle, { nowMs: NOW, nativeVerification: native }).ok, false);
    assert.equal(evaluateReleasePolicy(facts, null).errors[0].code, 'POLICY_OPTIONS_REQUIRED');
  });
  console.log('release-policy: ' + checks + ' synthetic checks passed; no product/native acceptance executed');
}
main().then(() => { finished = true; }, error => {
  finished = true; console.error('FAIL release-policy:', error && error.stack || error); process.exitCode = 1;
});
