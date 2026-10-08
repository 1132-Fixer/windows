#!/usr/bin/env node
/** Read-only authorization gate for every tag-triggered release path. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHubRestClient } from './github-rest.mjs';
import {
  fetchAuthoritativeReceipt,
  validateReleaseEvidence
} from './release-evidence.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const SUPPORT_REPOSITORY = '1132-Fixer/support-requests-bug-reporting';
const SUPPORT_ISSUE = 2;

export const REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ context: 'Build & Test', integrationId: 15368 }),
  Object.freeze({ context: 'Code Quality', integrationId: 15368 }),
  Object.freeze({ context: 'Support Service', integrationId: 15368 }),
  Object.freeze({ context: 'Dependency audit', integrationId: 15368 }),
  Object.freeze({ context: 'Licence and binary inventory', integrationId: 15368 }),
  Object.freeze({ context: 'CodeQL', integrationId: 15368 }),
  Object.freeze({ context: 'brand-assets', integrationId: 15368 })
]);

const REVIEW_THREADS_QUERY = `
  query ReleaseReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes { id isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export class ReleasePreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReleasePreflightError';
    this.code = code;
  }
}

function fail(code) {
  throw new ReleasePreflightError(code);
}

function codeOwners(text) {
  const line = String(text || '').split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value && !value.startsWith('#') && value.split(/\s+/)[0] === '*');
  if (!line) fail('codeowners-missing');
  const owners = line.split(/\s+/).slice(1)
    .filter(value => /^@[A-Za-z0-9-]+$/.test(value))
    .map(value => value.slice(1).toLowerCase());
  if (!owners.length) fail('codeowners-missing');
  return new Set(owners);
}

function latestReviews(reviews) {
  const latest = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const login = String(review && review.user && review.user.login || '').toLowerCase();
    if (!login) continue;
    const prior = latest.get(login);
    const time = Date.parse(review.submitted_at || '') || 0;
    const priorTime = prior ? Date.parse(prior.submitted_at || '') || 0 : -1;
    if (!prior || time > priorTime || (time === priorTime && Number(review.id || 0) > Number(prior.id || 0))) {
      latest.set(login, review);
    }
  }
  return latest;
}

function pageItems(value, code) {
  if (!value || value.complete !== true || !Number.isSafeInteger(value.pages) || value.pages < 1 ||
      !Array.isArray(value.items)) fail(code);
  return value.items;
}

function requiredRule(rules, type) {
  const matches = (Array.isArray(rules) ? rules : []).filter(rule => rule && rule.type === type);
  if (matches.length !== 1) fail(`ruleset-${type}`);
  return matches[0];
}

function configuredChecks(rules) {
  const rule = requiredRule(rules, 'required_status_checks');
  const params = rule.parameters || {};
  if (params.strict_required_status_checks_policy !== true || !Array.isArray(params.required_status_checks)) {
    fail('ruleset-required-checks');
  }
  const checks = params.required_status_checks.map(check => ({
    context: String(check && check.context || ''),
    integrationId: Number(check && check.integration_id)
  }));
  if (!checks.length || checks.some(check => !check.context || !Number.isSafeInteger(check.integrationId))) {
    fail('ruleset-required-checks');
  }
  for (const expected of REQUIRED_CHECKS) {
    if (!checks.some(check => check.context === expected.context && check.integrationId === expected.integrationId)) {
      fail('ruleset-required-check-missing');
    }
  }
  return checks;
}

function assertReviewRule(rules) {
  const params = requiredRule(rules, 'pull_request').parameters || {};
  if (Number(params.required_approving_review_count || 0) < 1 ||
      params.require_code_owner_review !== true ||
      params.dismiss_stale_reviews_on_push !== true ||
      params.require_last_push_approval !== true ||
      params.required_review_thread_resolution !== true) {
    fail('ruleset-review-policy');
  }
}

function assertNewTagEvent(event) {
  if (!event || event.created !== true || event.forced !== false || event.before !== ZERO_SHA ||
      !SHA40.test(event.after || '') || !/^[A-Za-z0-9-]+$/.test(event.pusher || '')) {
    fail('tag-event-not-new');
  }
}

async function assertReviewThreadsResolved(api, owner, repo, pullRequest) {
  if (!api || typeof api.graphql !== 'function') fail('review-threads-unavailable');
  let after = null;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await api.graphql(REVIEW_THREADS_QUERY, { owner, repo, number: pullRequest, after });
    const connection = data && data.repository && data.repository.pullRequest &&
      data.repository.pullRequest.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo ||
        typeof connection.pageInfo.hasNextPage !== 'boolean') fail('review-thread-pagination-incomplete');
    if (connection.nodes.some(node => !node || node.isResolved !== true)) fail('review-thread-unresolved');
    if (!connection.pageInfo.hasNextPage) return;
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) fail('review-thread-pagination-incomplete');
    seen.add(cursor);
    after = cursor;
  }
  fail('review-thread-pagination-incomplete');
}

function assertSupportIssueCleared(issue) {
  if (!issue || issue.number !== SUPPORT_ISSUE || issue.pull_request) fail('support-issue-not-cleared');
  if (issue.state === 'closed' && typeof issue.closed_at === 'string' && !Number.isNaN(Date.parse(issue.closed_at))) return;
  const labels = (Array.isArray(issue.labels) ? issue.labels : [])
    .map(label => String(typeof label === 'string' ? label : label && label.name || '').toLowerCase());
  const marker = /^Superseded-by:\s*https:\/\/github\.com\/1132-Fixer\/support-requests-bug-reporting\/issues\/([1-9]\d*)\s*$/im
    .exec(String(issue.body || ''));
  const superseded = labels.includes('superseded') && marker && Number(marker[1]) !== SUPPORT_ISSUE;
  if (!superseded) fail('support-issue-not-cleared');
}

export async function verifyReleasePreflight({
  api, repository, tag, sha, version, nativeArtifactId, supportArtifactId,
  codeownersText, tagEvent
}) {
  if (!api || typeof api.json !== 'function' || typeof api.paginate !== 'function' ||
      typeof api.bytes !== 'function') fail('api-unavailable');
  assertNewTagEvent(tagEvent);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) fail('repository-invalid');
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(tag || '')) fail('tag-invalid');
  if (tag.slice(1) !== version) fail('tag-version-mismatch');
  if (!SHA40.test(sha || '')) fail('release-head-invalid');
  const [owner, repo] = repository.split('/');
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repositoryState = await api.json('GET', root);
  if (!repositoryState || repositoryState.full_name !== repository || repositoryState.default_branch !== 'main') {
    fail('default-branch-not-main');
  }
  const mainRef = await api.json('GET', `${root}/git/ref/heads/main`);
  if (!mainRef || !mainRef.object || mainRef.object.type !== 'commit' || mainRef.object.sha !== sha) {
    fail('tag-not-current-main');
  }
  const tagRef = await api.json('GET', `${root}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!tagRef || !tagRef.object || tagRef.object.type !== 'tag' || tagRef.object.sha !== tagEvent.after) {
    fail('annotated-tag-identity');
  }
  const tagObject = await api.json('GET', `${root}/git/tags/${tagRef.object.sha}`);
  if (!tagObject || tagObject.tag !== tag || !tagObject.object ||
      tagObject.object.type !== 'commit' || tagObject.object.sha !== sha) fail('annotated-tag-identity');

  const rules = pageItems(await api.paginate(`${root}/rules/branches/main?per_page=100`), 'ruleset-pagination-incomplete');
  assertReviewRule(rules);
  const required = configuredChecks(rules);
  const checkRuns = pageItems(await api.paginate(
    `${root}/commits/${sha}/check-runs?filter=latest&per_page=100`, { itemKey: 'check_runs' }
  ), 'check-pagination-incomplete');
  for (const requirement of required) {
    const matches = checkRuns.filter(run => run && run.name === requirement.context &&
      Number(run.app && run.app.id) === requirement.integrationId && run.head_sha === sha);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      fail('required-check-not-green');
    }
  }

  const nativeReceipt = await fetchAuthoritativeReceipt({
    api, repository, artifactId: nativeArtifactId, head: sha, kind: 'native'
  });
  const supportReceipt = await fetchAuthoritativeReceipt({
    api, repository, artifactId: supportArtifactId, head: sha, kind: 'support'
  });
  const evidence = validateReleaseEvidence(nativeReceipt.bytes, supportReceipt.bytes, {
    expectedHead: sha, expectedVersion: version
  });

  const prNumber = evidence.native.review.pullRequest;
  const pr = await api.json('GET', `${root}/pulls/${prNumber}`);
  if (!pr || pr.merged !== true || pr.state !== 'closed' || pr.merge_commit_sha !== sha ||
      !pr.base || pr.base.ref !== 'main' || !pr.head || pr.head.sha !== evidence.native.review.head) {
    fail('reviewed-pr-not-current-release');
  }
  const releaseCommit = await api.json('GET', `${root}/git/commits/${sha}`);
  if (!releaseCommit || !Array.isArray(releaseCommit.parents) || !releaseCommit.parents[0] ||
      releaseCommit.parents[0].sha !== evidence.native.review.base) fail('review-base-not-current');
  const owners = codeOwners(codeownersText);
  const author = String(pr.user && pr.user.login || '').toLowerCase();
  const pusher = String(tagEvent.pusher).toLowerCase();
  for (const receipt of [nativeReceipt, supportReceipt]) {
    if (!owners.has(receipt.issuer.login) || receipt.issuer.login === author || receipt.issuer.login === pusher) {
      fail('receipt-issuer-not-independent');
    }
  }
  const reviewPage = await api.paginate(`${root}/pulls/${prNumber}/reviews?per_page=100`);
  const reviews = latestReviews(pageItems(reviewPage, 'review-pagination-incomplete'));
  if ([...reviews.values()].some(review => review.state === 'CHANGES_REQUESTED')) {
    fail('blocking-review-unresolved');
  }
  const approved = [...reviews.entries()].some(([login, review]) => owners.has(login) &&
    login !== author && login !== pusher && review.state === 'APPROVED' &&
    review.commit_id === evidence.native.review.head);
  if (!approved) fail('independent-codeowner-approval-missing');
  await assertReviewThreadsResolved(api, owner, repo, prNumber);

  const supportIssue = await api.json('GET', `/repos/${SUPPORT_REPOSITORY}/issues/${SUPPORT_ISSUE}`);
  assertSupportIssueCleared(supportIssue);

  // Candidate metadata is intentionally last. Review, thread, issuer, policy,
  // and support clearance failures cannot read accepted package metadata.
  const runId = evidence.native.candidate.workflowRunId;
  const run = await api.json('GET', `${root}/actions/runs/${runId}`);
  if (!run || run.id !== runId || run.head_sha !== sha || run.event !== 'push' || run.status !== 'completed' ||
      run.conclusion !== 'success' || run.path !== '.github/workflows/ci.yml') fail('candidate-run-invalid');
  const artifactId = evidence.native.candidate.artifactId;
  const artifact = await api.json('GET', `${root}/actions/artifacts/${artifactId}`);
  if (!artifact || artifact.id !== artifactId || artifact.name !== evidence.native.candidate.artifactName ||
      artifact.expired === true || artifact.digest !== evidence.native.candidate.artifactDigest ||
      !artifact.workflow_run || artifact.workflow_run.id !== runId || artifact.workflow_run.head_sha !== sha) {
    fail('candidate-artifact-invalid');
  }
  return { evidence, requiredChecks: required, artifact, nativeReceipt, supportReceipt };
}

function envBoolean(name) {
  const value = process.env[name];
  if (value !== 'true' && value !== 'false') fail('tag-event-not-new');
  return value === 'true';
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const tag = process.env.GITHUB_REF_NAME || '';
  const sha = process.env.GITHUB_SHA || '';
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) fail('github-token-missing');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const result = await verifyReleasePreflight({
    api: createGitHubRestClient({ token, userAgent: '1132-fixer-release-preflight' }),
    repository, tag, sha, version: pkg.version,
    nativeArtifactId: Number(process.env.NATIVE_ACCEPTANCE_ARTIFACT_ID || 0),
    supportArtifactId: Number(process.env.SUPPORT_CLEARANCE_ARTIFACT_ID || 0),
    codeownersText: fs.readFileSync(path.join(root, '.github', 'CODEOWNERS'), 'utf8'),
    tagEvent: {
      created: envBoolean('RELEASE_REF_CREATED'),
      forced: envBoolean('RELEASE_REF_FORCED'),
      before: process.env.RELEASE_REF_BEFORE || '',
      after: process.env.RELEASE_REF_AFTER || '',
      pusher: process.env.RELEASE_TAG_PUSHER || ''
    }
  });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) fail('github-output-missing');
  const rows = {
    candidate_run_id: result.evidence.native.candidate.workflowRunId,
    candidate_artifact_id: result.evidence.native.candidate.artifactId,
    candidate_artifact_name: result.evidence.native.candidate.artifactName,
    candidate_artifact_digest: result.evidence.native.candidate.artifactDigest,
    setup_sha256: result.evidence.native.packages.setup.packageSha256,
    portable_sha256: result.evidence.native.packages.portable.packageSha256,
    native_receipt_artifact_id: result.nativeReceipt.artifact.id,
    native_receipt_artifact_digest: result.nativeReceipt.artifact.digest,
    support_receipt_artifact_id: result.supportReceipt.artifact.id,
    support_receipt_artifact_digest: result.supportReceipt.artifact.digest,
    native_manifest_sha256: result.evidence.nativeSha256,
    support_clearance_sha256: result.evidence.supportSha256
  };
  fs.appendFileSync(output, Object.entries(rows).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  console.log(`[release-preflight] PASS head=${sha} requiredChecks=${result.requiredChecks.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[release-preflight] ${error && error.code || 'preflight-failed'}`);
    process.exitCode = 1;
  });
}
