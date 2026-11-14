// Pure admission for 1132-Fixer/windows. No environment, filesystem, network,
// Git, native process or clock reads occur here. Facts MUST come from an
// authenticated, pagination-complete normalizer, never workflow inputs/report
// totals. This module does not authenticate GitHub or prove a physical run.
//
// evaluateReleasePolicy(facts, { nowMs, nativeVerification }) is deterministic.
// publishReleaseIfAdmitted injects all IO: collectFacts -> native verifier ->
// fresh collectFacts -> publish. A verifier is a trusted production adapter,
// not a boolean/fixture switch. Smoke tests simulate it; they prove no native
// acceptance. Publication callback failures have uncertain effects: no retry.
// This unit supplies no production authenticated normalizer, native verifier
// or publisher. Those adapters remain required, unimplemented delivery work;
// a nonpublishing draft workflow is not completed release automation.
//
// Schema 1: {repository,observedAtMs,source,versions,protection,checks,
// pullRequest,codeOwners,reviews,threads,prepared,prepublish}. See the inert
// fixture in tools/release-policy-smoke.js for every required normalized field.
// Collection complete flags mean authenticated pagination was EXHAUSTED.
// checks.items contains one provider-normalized LATEST result per required
// context/expected app; do not infer the expected app from the result itself.
// tagTargetSha is the resolved tag commit, not raw release.target_commitish.
import { createHash } from 'node:crypto';

export const REPOSITORY = '1132-Fixer/windows';
export const MAX_FACT_AGE_MS = 5 * 60 * 1000;
export const MIN_REQUIRED_CONTEXTS = Object.freeze([
  'Build & Test', 'Code Quality', 'Support Service', 'Dependency audit',
  'Licence and binary inventory', 'CodeQL', 'brand-assets'
]);
export const CODE_OWNER_LOGINS = Object.freeze(['JG2547', 'patricktobias86']);
export const NATIVE_CASES = Object.freeze([
  'installed-startup', 'repair-workflow', 'useful-failure-handling',
  'setup-update-handoff', 'setup-update-relaunch', 'setup-update-persistence',
  'portable-startup', 'portable-manual-update', 'legacy-manual-recovery'
]);
const portableCases = new Set(['portable-startup', 'portable-manual-update']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const login = value => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
const botLogin = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?$/.test(value);
const actorLogin = value => login(value) || (typeof value === 'string' && value.endsWith('[bot]') && botLogin(value));
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const knownOwners = new Set(CODE_OWNER_LOGINS.map(lower));

function normalizedData(value, depth = 0, count = { n: 0 }, active = new Set()) {
  if (++count.n > 20000 || depth > 16) throw new TypeError('Unbounded normalized data');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 4096) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || active.has(value)) throw new TypeError('Normalized data required');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Plain data required');
  const names = Object.getOwnPropertyNames(value);
  if ((Array.isArray(value) && value.length > 4096) || (!Array.isArray(value) && names.length > 64)
      || Object.getOwnPropertySymbols(value).length) throw new TypeError('Bounded plain data required');
  if (Array.isArray(value) && (names.length !== value.length + 1
      || names.some(name => name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= value.length)))) {
    throw new TypeError('Sparse or decorated arrays are not normalized facts');
  }
  active.add(value);
  const copy = Array.isArray(value) ? [] : Object.create(null);
  for (const name of names) {
    if (Array.isArray(value) && name === 'length') continue;
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new TypeError('Reserved data key');
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Accessors are not normalized facts');
    copy[name] = normalizedData(descriptor.value, depth + 1, count, active);
  }
  active.delete(value);
  return copy;
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function stable(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function laterVersion(left, right) {
  const a = stable(left), b = stable(right);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
function failure(code, path) { return { code, path }; }
function denied(errors, publicationAttempted = false, outcome = 'not-attempted') {
  return freeze({ ok: false, errors, admission: null, publicationAttempted, outcome });
}

// Digest is SHA256(UTF8(JSON.stringify(sorted [{name,size,sha256}]) + LF)).
// Provider asset IDs are compared separately: identical replacement bytes still
// do not authorize changing an already admitted draft's asset identity.
export function assetSetDigest(assets) {
  if (!Array.isArray(assets) || !assets.length || assets.length > 256) throw new TypeError('Bounded assets required');
  const names = new Set(), foldedNames = new Set();
  const rows = assets.map(asset => {
    if (!record(asset) || typeof asset.name !== 'string' || !asset.name || /[\\/\x00-\x1f\x7f]/.test(asset.name)
        || !positive(asset.size) || !digest(asset.sha256) || names.has(asset.name)
        || foldedNames.has(asset.name.toLowerCase())) throw new TypeError('Invalid or case-ambiguous asset identity');
    names.add(asset.name); foldedNames.add(asset.name.toLowerCase());
    return { name: asset.name, size: asset.size, sha256: asset.sha256 };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(rows) + '\n', 'utf8').digest('hex');
}
function sourcePolicy(raw, nowMs) {
  const errors = [];
  const need = (condition, code, path) => { if (!condition) errors.push(failure(code, path)); return !!condition; };
  let facts;
  try { facts = normalizedData(raw); }
  catch (_) { return { errors: [failure('FACTS_NOT_NORMALIZED_DATA', 'facts')] }; }
  if (!record(facts)) return { errors: [failure('FACTS_NOT_NORMALIZED_DATA', 'facts')] };
  const recent = time => positive(time) && positive(nowMs) && time <= nowMs && nowMs - time <= MAX_FACT_AGE_MS;
  need(positive(nowMs), 'CLOCK_REQUIRED', 'nowMs');
  need(facts.schemaVersion === 1, 'SCHEMA_UNSUPPORTED', 'schemaVersion');
  need(facts.repository === REPOSITORY, 'REPOSITORY_MISMATCH', 'repository');
  need(recent(facts.observedAtMs), 'FACTS_STALE', 'observedAtMs');

  const source = record(facts.source) ? facts.source : {};
  const versions = record(facts.versions) ? facts.versions : {};
  const version = versions.packageJson;
  need(sha(source.sha) && source.branch === 'main' && source.mainSha === source.sha,
    'SOURCE_NOT_EXACT_MAIN', 'source');
  need(stable(version) !== null && versions.lockfile === version && versions.lockRoot === version
    && versions.tag === 'v' + version, 'VERSION_IDENTITY_MISMATCH', 'versions');
  need(laterVersion(version, versions.latestPublished), 'VERSION_NOT_FORWARD_STABLE', 'versions.latestPublished');

  const protection = record(facts.protection) ? facts.protection : {};
  const required = Array.isArray(protection.requiredContexts) ? protection.requiredContexts : [];
  need(protection.complete === true && protection.sourceSha === source.sha && required.length > 0,
    'REQUIRED_CONTEXTS_UNVERIFIED', 'protection');
  const requiredNames = new Set();
  for (const item of required) {
    if (!record(item) || typeof item.name !== 'string' || !item.name || !positive(item.appId)
        || requiredNames.has(item.name)) {
      need(false, 'REQUIRED_CONTEXT_IDENTITY_INVALID', 'protection.requiredContexts');
    } else requiredNames.add(item.name);
  }
  for (const name of MIN_REQUIRED_CONTEXTS) need(requiredNames.has(name), 'REQUIRED_CONTEXT_OMITTED', 'protection.' + name);
  const checks = record(facts.checks) ? facts.checks : {};
  const checkItems = Array.isArray(checks.items) ? checks.items : [];
  const selectedCheckIds = new Set();
  need(checks.complete === true && checks.sourceSha === source.sha && Array.isArray(checks.items),
    'CHECK_COLLECTION_UNVERIFIED', 'checks');
  for (const requiredCheck of required) {
    if (!record(requiredCheck) || typeof requiredCheck.name !== 'string') continue;
    const matches = checkItems.filter(item => record(item) && item.name === requiredCheck.name && item.appId === requiredCheck.appId);
    if (!need(matches.length === 1, 'CHECK_MISSING_OR_AMBIGUOUS', 'checks.' + requiredCheck.name)) continue;
    const item = matches[0];
    need(!selectedCheckIds.has(item.id), 'CHECK_ID_REUSED', 'checks.items');
    selectedCheckIds.add(item.id);
    need(positive(item.id) && item.sha === source.sha && item.latest === true
      && item.status === 'completed' && item.conclusion === 'success'
      && positive(item.completedAtMs) && item.completedAtMs <= facts.observedAtMs,
    'CHECK_NOT_CURRENT_SUCCESS', 'checks.' + requiredCheck.name);
  }

  const pr = record(facts.pullRequest) ? facts.pullRequest : {};
  need(positive(pr.number) && pr.repository === REPOSITORY && pr.baseBranch === 'main'
    && pr.merged === true && sha(pr.headSha) && pr.mergeCommitSha === source.sha
    && pr.reviewDecision === 'APPROVED', 'REVIEWED_MERGE_MAPPING_UNVERIFIED', 'pullRequest');
  need(source.associatedPullRequestsComplete === true && Array.isArray(source.associatedPullRequestNumbers)
    && source.associatedPullRequestNumbers.includes(pr.number),
  'SOURCE_PR_ASSOCIATION_UNVERIFIED', 'source.associatedPullRequestNumbers');
  need(actorLogin(pr.authorLogin) && actorLogin(pr.lastPusherLogin) && positive(pr.lastPushedAtMs)
    && positive(pr.mergedAtMs) && pr.lastPushedAtMs < pr.mergedAtMs && pr.mergedAtMs <= facts.observedAtMs,
  'PR_PUSH_IDENTITY_UNVERIFIED', 'pullRequest.lastPusherLogin');

  const owners = record(facts.codeOwners) ? facts.codeOwners : {};
  const ownerItems = Array.isArray(owners.items) ? owners.items : [];
  const ownerNames = new Set();
  need(owners.complete === true && owners.sourceSha === source.sha
    && owners.path === '.github/CODEOWNERS' && ownerItems.length === CODE_OWNER_LOGINS.length,
  'CODEOWNERS_SCOPE_UNVERIFIED', 'codeOwners');
  for (const owner of ownerItems) {
    const name = record(owner) ? lower(owner.login) : '';
    need(record(owner) && login(owner.login) && knownOwners.has(name) && !ownerNames.has(name)
      && owner.actorType === 'User' && ['read', 'triage', 'write', 'maintain', 'admin'].includes(owner.permission),
    'CODEOWNER_IDENTITY_UNVERIFIED', 'codeOwners.items');
    ownerNames.add(name);
  }
  const eligibleOwners = new Set(ownerItems.filter(owner => record(owner)
    && owner.actorType === 'User' && knownOwners.has(lower(owner.login))
    && ['write', 'maintain', 'admin'].includes(owner.permission)).map(owner => lower(owner.login)));
  const reviews = record(facts.reviews) ? facts.reviews : {};
  const reviewItems = Array.isArray(reviews.items) ? reviews.items : [];
  need(reviews.complete === true && Array.isArray(reviews.items), 'REVIEW_COLLECTION_UNVERIFIED', 'reviews');
  const latest = new Map();
  const reviewIds = new Set();
  for (const review of reviewItems) {
    if (!need(record(review) && positive(review.id) && !reviewIds.has(review.id)
        && (review.actorType === 'Bot' ? botLogin(review.login) : login(review.login))
        && ['User', 'Bot'].includes(review.actorType) && sha(review.commitSha)
        && ['APPROVED', 'REQUEST_CHANGES', 'COMMENTED', 'DISMISSED'].includes(review.state)
        && typeof review.dismissed === 'boolean' && positive(review.submittedAtMs)
        && review.submittedAtMs <= facts.observedAtMs, 'REVIEW_FACT_INVALID', 'reviews.items')) continue;
    reviewIds.add(review.id);
    if (review.state === 'COMMENTED' && !review.dismissed) continue;
    const key = lower(review.login), previous = latest.get(key);
    if (previous && review.submittedAtMs === previous.submittedAtMs) {
      need(false, 'REVIEW_ORDER_AMBIGUOUS', 'reviews.items'); continue;
    }
    if (!previous || review.submittedAtMs > previous.submittedAtMs) latest.set(key, review);
  }
  const approval = [...latest.values()].find(review => review.state === 'APPROVED' && review.dismissed === false
    && review.actorType === 'User' && eligibleOwners.has(lower(review.login))
    && lower(review.login) !== lower(pr.authorLogin) && lower(review.login) !== lower(pr.lastPusherLogin)
    && review.commitSha === pr.headSha && review.submittedAtMs > pr.lastPushedAtMs
    && review.submittedAtMs <= pr.mergedAtMs);
  need(!!approval, 'INDEPENDENT_FINAL_HEAD_CODEOWNER_APPROVAL_REQUIRED', 'reviews');
  const threads = record(facts.threads) ? facts.threads : {};
  need(threads.complete === true && Array.isArray(threads.items), 'THREAD_COLLECTION_UNVERIFIED', 'threads');
  for (const thread of Array.isArray(threads.items) ? threads.items : []) {
    need(record(thread) && typeof thread.id === 'string' && !!thread.id && thread.resolved === true,
      'REVIEW_THREAD_UNRESOLVED', 'threads.items');
  }

  const requiredAssets = stable(version) ? [
    '1132-Fixer-Setup-' + version + '.exe', '1132-Fixer-Portable-' + version + '.exe',
    '1132-Fixer-Setup-' + version + '.exe.blockmap',
    'latest.yml', 'checksums-sha256.txt', 'signature-state.json', 'package-inventory.json',
    'sbom.spdx.json', 'provenance.json'
  ] : [];
  const permitted = new Set(requiredAssets);
  function snapshot(value, name, fresh) {
    if (!need(record(value), 'DRAFT_SNAPSHOT_REQUIRED', name)) return null;
    need(value.repository === REPOSITORY && value.sourceSha === source.sha && value.tagTargetSha === source.sha
      && value.version === version && value.tag === versions.tag && positive(value.releaseId)
      && value.draft === true && value.prerelease === false && value.publishedAtMs === null,
    'DRAFT_IDENTITY_UNVERIFIED', name);
    need(positive(value.observedAtMs) && value.observedAtMs <= facts.observedAtMs
      && (!fresh || recent(value.observedAtMs)), 'DRAFT_SNAPSHOT_STALE', name + '.observedAtMs');
    const assets = Array.isArray(value.assets) ? value.assets : [];
    need(Array.isArray(value.assets) && assets.length === requiredAssets.length,
      'ASSET_SET_NOT_EXACT', name + '.assets');
    let calculated = null;
    try { calculated = assetSetDigest(assets); } catch (_) { need(false, 'ASSET_IDENTITY_INVALID', name + '.assets'); }
    const names = new Set(), foldedNames = new Set(), ids = new Set();
    for (const asset of assets) {
      if (!record(asset)) continue;
      if (typeof asset.name === 'string') {
        const folded = asset.name.toLowerCase();
        need(!foldedNames.has(folded), 'ASSET_NAME_AMBIGUOUS', name + '.assets');
        foldedNames.add(folded);
      }
      need(permitted.has(asset.name) && positive(asset.id) && !ids.has(asset.id), 'ASSET_NOT_ALLOWED', name + '.assets');
      names.add(asset.name); ids.add(asset.id);
    }
    for (const asset of requiredAssets) need(names.has(asset), 'REQUIRED_ASSET_MISSING', name + '.' + asset);
    need(digest(value.assetSetSha256) && calculated === value.assetSetSha256,
      'ASSET_SET_DIGEST_MISMATCH', name + '.assetSetSha256');
    const validation = record(value.validation) ? value.validation : {};
    need(validation.state === 'verified' && validation.method === 'downloaded-bytes'
      && validation.sourceSha === source.sha && validation.assetSetSha256 === calculated
      && validation.checksums === 'verified' && validation.updaterMetadata === 'verified'
      && validation.packageInventory === 'verified' && validation.signatureState === 'unsigned-compatible',
    'ASSET_BYTES_NOT_VERIFIED', name + '.validation');
    return { ...value, assets: assets.filter(asset => record(asset) && typeof asset.name === 'string'
      && positive(asset.id) && positive(asset.size) && digest(asset.sha256)).map(asset => ({
      id: asset.id, name: asset.name, size: asset.size, sha256: asset.sha256
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
  }
  const prepared = snapshot(facts.prepared, 'prepared', false);
  const prepublish = snapshot(facts.prepublish, 'prepublish', true);
  if (prepared && prepublish) {
    need(prepared.releaseId === prepublish.releaseId && prepared.assetSetSha256 === prepublish.assetSetSha256
      && prepared.observedAtMs <= prepublish.observedAtMs
      && JSON.stringify(prepared.assets) === JSON.stringify(prepublish.assets),
    'DRAFT_CHANGED_AFTER_PREPARATION', 'prepublish');
  }
  return { errors, facts, prepared, prepublish, summary: {
    repository: REPOSITORY, sourceSha: source.sha, reviewedHeadSha: pr.headSha,
    pullRequestNumber: pr.number, codeOwnerReviewId: approval && approval.id,
    version, tag: versions.tag, releaseId: prepublish && prepublish.releaseId,
    assetSetSha256: prepublish && prepublish.assetSetSha256,
    assets: prepublish && prepublish.assets,
    expiresAtMs: positive(facts.observedAtMs) && prepublish
      ? Math.min(facts.observedAtMs, prepublish.observedAtMs) + MAX_FACT_AGE_MS : null
  } };
}
function nativePolicy(value, core, nowMs) {
  const errors = [], need = (condition, code, path) => { if (!condition) errors.push(failure(code, path)); };
  let proof;
  try { proof = normalizedData(value); }
  catch (_) { return { errors: [failure('NATIVE_EXTERNAL_VERIFICATION_REQUIRED', 'nativeVerification')] }; }
  if (!record(proof)) return { errors: [failure('NATIVE_EXTERNAL_VERIFICATION_REQUIRED', 'nativeVerification')] };
  const expected = core.summary;
  need(proof.kind === 'externally-verified-native-acceptance' && proof.state === 'verified'
    && ['authenticated-operator-review', 'trusted-native-runner-attestation'].includes(proof.method)
    && login(proof.verifierLogin) && typeof proof.evidenceId === 'string' && !!proof.evidenceId
    && digest(proof.evidenceSha256) && typeof proof.deviceId === 'string' && !!proof.deviceId
    && proof.platform === 'win32' && proof.mocked === false && proof.testCopy === false,
  'NATIVE_EVIDENCE_ORIGIN_UNVERIFIED', 'nativeVerification');
  need(proof.sourceSha === expected.sourceSha && proof.version === expected.version
    && proof.assetSetSha256 === expected.assetSetSha256 && proof.requirementsComplete === true,
  'NATIVE_EVIDENCE_IDENTITY_MISMATCH', 'nativeVerification');
  need(positive(proof.verifiedAtMs) && proof.verifiedAtMs >= core.prepared.observedAtMs
    && proof.verifiedAtMs <= core.prepublish.observedAtMs && proof.verifiedAtMs <= nowMs,
  'NATIVE_EVIDENCE_TIME_UNVERIFIED', 'nativeVerification.verifiedAtMs');
  const cases = Array.isArray(proof.cases) ? proof.cases : [];
  need(Array.isArray(proof.cases) && cases.length > 0 && cases.length <= 64,
    'NATIVE_CASES_REQUIRED', 'nativeVerification.cases');
  const names = new Set();
  const setup = core.prepublish.assets.find(asset => asset.name === '1132-Fixer-Setup-' + expected.version + '.exe');
  const portable = core.prepublish.assets.find(asset => asset.name === '1132-Fixer-Portable-' + expected.version + '.exe');
  for (const item of cases) {
    const expectedArtifact = portableCases.has(item && item.name) ? portable : setup;
    need(record(item) && typeof item.name === 'string' && !!item.name && !names.has(item.name)
      && item.status === 'passed' && item.native === true && item.mocked === false && item.testCopy === false
      && expectedArtifact && item.artifactSha256 === expectedArtifact.sha256 && digest(item.evidenceSha256)
      && positive(item.observedAtMs) && item.observedAtMs >= core.prepared.observedAtMs
      && item.observedAtMs <= proof.verifiedAtMs,
    'NATIVE_CASE_NOT_VERIFIED', 'nativeVerification.cases');
    if (record(item)) names.add(item.name);
  }
  for (const name of NATIVE_CASES) need(names.has(name), 'NATIVE_REQUIRED_CASE_MISSING', 'nativeVerification.' + name);
  return { errors, proof };
}

export function evaluateReleasePolicy(facts, options = {}) {
  if (!record(options)) return denied([failure('POLICY_OPTIONS_REQUIRED', 'options')]);
  const { nowMs, nativeVerification } = options;
  const core = sourcePolicy(facts, nowMs);
  if (core.errors.length) return denied(core.errors);
  const native = nativePolicy(nativeVerification, core, nowMs);
  if (native.errors.length) return denied(native.errors);
  return freeze({ ok: true, errors: [], admission: {
    ...core.summary,
    nativeEvidenceId: native.proof.evidenceId,
    nativeEvidenceSha256: native.proof.evidenceSha256
  }, publicationAttempted: false, outcome: 'admitted-not-published' });
}

// collectFacts returns {facts,nowMs} from a FRESH authenticated read each time.
// verifyNativeEvidence(expected) must independently authenticate real acceptance;
// returning true or report totals is refused. It must not execute acceptance.
// publish receives only the frozen admitted identity and must enforce that same
// draft/tag identity, refuse replacement and verify the provider result. This
// module calls it once at most and never interprets unit-test success as release.
export async function publishReleaseIfAdmitted(adapters = {}) {
  if (!record(adapters)) return denied([failure('PUBLICATION_ADAPTER_REQUIRED', 'adapters')]);
  const { collectFacts, verifyNativeEvidence, publish } = adapters;
  if (typeof collectFacts !== 'function' || typeof verifyNativeEvidence !== 'function' || typeof publish !== 'function') {
    return denied([failure('PUBLICATION_ADAPTER_REQUIRED', 'adapters')]);
  }
  let first;
  try { first = normalizedData(await collectFacts()); }
  catch (_) { return denied([failure('FACT_COLLECTION_FAILED', 'collectFacts')]); }
  const initial = sourcePolicy(first && first.facts, first && first.nowMs);
  if (initial.errors.length) return denied(initial.errors);
  let nativeVerification;
  try { nativeVerification = await verifyNativeEvidence(freeze({ ...initial.summary })); }
  catch (_) { return denied([failure('NATIVE_EXTERNAL_VERIFICATION_FAILED', 'verifyNativeEvidence')]); }
  let fresh;
  try { fresh = normalizedData(await collectFacts()); }
  catch (_) { return denied([failure('FACT_COLLECTION_FAILED', 'collectFacts')]); }
  const admitted = evaluateReleasePolicy(fresh && fresh.facts, { nowMs: fresh && fresh.nowMs, nativeVerification });
  if (!admitted.ok) return admitted;
  const before = initial.summary, after = admitted.admission;
  if (['repository', 'sourceSha', 'reviewedHeadSha', 'pullRequestNumber', 'version', 'tag', 'releaseId', 'assetSetSha256']
    .some(key => before[key] !== after[key]) || JSON.stringify(before.assets) !== JSON.stringify(after.assets)) {
    return denied([failure('PUBLICATION_IDENTITY_CHANGED', 'collectFacts')]);
  }
  try { await publish(admitted.admission); }
  catch (_) { return denied([failure('PUBLICATION_OUTCOME_UNCERTAIN', 'publish')], true, 'uncertain'); }
  return freeze({ ...admitted, publicationAttempted: true, outcome: 'publication-callback-completed' });
}
