#!/usr/bin/env node
/** Read-only authorization gate for every tag-triggered release path. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseEvidenceJson,
  validateReleaseEvidence
} from './release-evidence.mjs';

export const REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ context: 'Build & Test', integrationId: 15368 }),
  Object.freeze({ context: 'Code Quality', integrationId: 15368 }),
  Object.freeze({ context: 'Support Service', integrationId: 15368 }),
  Object.freeze({ context: 'Dependency audit', integrationId: 15368 }),
  Object.freeze({ context: 'Licence and binary inventory', integrationId: 15368 }),
  Object.freeze({ context: 'CodeQL', integrationId: 15368 }),
  Object.freeze({ context: 'brand-assets', integrationId: 15368 })
]);

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
      params.require_last_push_approval !== true) {
    fail('ruleset-review-policy');
  }
}

export async function verifyReleasePreflight({
  api, repository, tag, sha, version, nativeManifest, supportClearance, codeownersText
}) {
  if (typeof api !== 'function') fail('api-unavailable');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) fail('repository-invalid');
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(tag || '')) fail('tag-invalid');
  if (tag.slice(1) !== version) fail('tag-version-mismatch');
  if (!/^[a-f0-9]{40}$/.test(sha || '')) fail('release-head-invalid');
  const evidence = validateReleaseEvidence(nativeManifest, supportClearance, {
    expectedHead: sha,
    expectedVersion: version
  });
  const [owner, repo] = repository.split('/');
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repositoryState = await api('GET', root);
  if (!repositoryState || repositoryState.default_branch !== 'main') fail('default-branch-not-main');
  const mainRef = await api('GET', `${root}/git/ref/heads/main`);
  if (!mainRef || !mainRef.object || mainRef.object.sha !== sha) fail('tag-not-current-main');

  const rules = await api('GET', `${root}/rules/branches/main`);
  assertReviewRule(rules);
  const required = configuredChecks(rules);
  const checksResponse = await api('GET', `${root}/commits/${sha}/check-runs?filter=latest&per_page=100`);
  const checkRuns = Array.isArray(checksResponse && checksResponse.check_runs) ? checksResponse.check_runs : [];
  for (const requirement of required) {
    const matches = checkRuns.filter(run => run && run.name === requirement.context &&
      Number(run.app && run.app.id) === requirement.integrationId && run.head_sha === sha);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      fail('required-check-not-green');
    }
  }

  const prNumber = evidence.native.review.pullRequest;
  const pr = await api('GET', `${root}/pulls/${prNumber}`);
  if (!pr || pr.merged !== true || pr.state !== 'closed' || pr.merge_commit_sha !== sha ||
      !pr.base || pr.base.ref !== 'main' || !pr.head || pr.head.sha !== evidence.native.review.head) {
    fail('reviewed-pr-not-current-release');
  }
  const releaseCommit = await api('GET', `${root}/git/commits/${sha}`);
  if (!releaseCommit || !Array.isArray(releaseCommit.parents) || !releaseCommit.parents[0] ||
      releaseCommit.parents[0].sha !== evidence.native.review.base) fail('review-base-not-current');
  const owners = codeOwners(codeownersText);
  const reviews = latestReviews(await api('GET', `${root}/pulls/${prNumber}/reviews?per_page=100`));
  const author = String(pr.user && pr.user.login || '').toLowerCase();
  const approved = [...reviews.entries()].some(([login, review]) => owners.has(login) && login !== author &&
    review.state === 'APPROVED' && review.commit_id === evidence.native.review.head);
  if (!approved) fail('independent-codeowner-approval-missing');

  const runId = evidence.native.candidate.workflowRunId;
  const run = await api('GET', `${root}/actions/runs/${runId}`);
  if (!run || run.id !== runId || run.head_sha !== sha || run.event !== 'push' || run.status !== 'completed' ||
      run.conclusion !== 'success' || run.path !== '.github/workflows/ci.yml') fail('candidate-run-invalid');
  const artifactId = evidence.native.candidate.artifactId;
  const artifact = await api('GET', `${root}/actions/artifacts/${artifactId}`);
  if (!artifact || artifact.id !== artifactId || artifact.name !== evidence.native.candidate.artifactName ||
      artifact.expired === true || artifact.digest !== evidence.native.candidate.artifactDigest ||
      !artifact.workflow_run || artifact.workflow_run.id !== runId || artifact.workflow_run.head_sha !== sha) {
    fail('candidate-artifact-invalid');
  }
  return { evidence, requiredChecks: required, artifact };
}

function apiClient(token) {
  return async (method, apiPath) => {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': '1132-fixer-release-preflight',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      redirect: 'error'
    });
    if (!response.ok) fail('github-read-failed');
    return response.json();
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const tag = process.env.GITHUB_REF_NAME || '';
  const sha = process.env.GITHUB_SHA || '';
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) fail('github-token-missing');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const nativeManifest = parseEvidenceJson(process.env.NATIVE_ACCEPTANCE_MANIFEST || '', 'native-manifest-input');
  const supportClearance = parseEvidenceJson(process.env.SUPPORT_RELEASE_CLEARANCE || '', 'support-clearance-input');
  const result = await verifyReleasePreflight({
    api: apiClient(token), repository, tag, sha, version: pkg.version,
    nativeManifest, supportClearance,
    codeownersText: fs.readFileSync(path.join(root, '.github', 'CODEOWNERS'), 'utf8')
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
