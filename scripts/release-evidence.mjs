#!/usr/bin/env node
/** Validate and materialize non-secret release evidence without logging values. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const IMMUTABLE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PACKAGE_KINDS = Object.freeze(['setup', 'portable']);
const JOURNEYS = Object.freeze(['bug-report', 'user-rating', 'contact']);

export class ReleaseEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReleaseEvidenceError';
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseEvidenceError(code);
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, keys, code) {
  object(value, code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function exactSha(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function evidenceSha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function parseEvidenceJson(text, code) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 65536) fail(code);
  try {
    return JSON.parse(text);
  } catch (_) {
    fail(code);
  }
}

function packageNamePattern(kind, version) {
  const escaped = String(version || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = kind === 'setup' ? 'Setup' : 'Portable';
  return new RegExp(`^1132-Fixer-${label}-${escaped}\\.exe$`);
}

function validateAcceptedPackage(value, kind, version) {
  const code = `native-package-${kind}`;
  exactKeys(value, [
    'acceptanceReportSha256', 'fileName', 'kind', 'packageSha256',
    'packageToRuntime', 'runtimeExecutableSha256', 'supportConfigRevision', 'uac'
  ], code);
  if (value.kind !== kind || !packageNamePattern(kind, version).test(value.fileName)) fail(`${code}-identity`);
  exactSha(value.packageSha256, SHA64, `${code}-hash`);
  exactSha(value.runtimeExecutableSha256, SHA64, `${code}-runtime-hash`);
  exactSha(value.acceptanceReportSha256, SHA64, `${code}-report`);
  exactSha(value.supportConfigRevision, SHA64, `${code}-support-config`);
  exactKeys(value.packageToRuntime, ['launchObserved', 'operation', 'runtimeSource'], `${code}-provenance`);
  const operation = kind === 'setup' ? 'install' : 'extract';
  const runtimeSource = kind === 'setup' ? 'installed-package' : 'extracted-package';
  if (value.packageToRuntime.operation !== operation || value.packageToRuntime.runtimeSource !== runtimeSource ||
      value.packageToRuntime.launchObserved !== true) fail(`${code}-provenance`);
  exactKeys(value.uac, [
    'acceptObserved', 'cancelObserved', 'disposableWindowsBoundary', 'enabled',
    'unmodifiedRequireAdministrator'
  ], `${code}-uac`);
  if (value.uac.enabled !== true || value.uac.acceptObserved !== true || value.uac.cancelObserved !== true ||
      value.uac.disposableWindowsBoundary !== true || value.uac.unmodifiedRequireAdministrator !== true) {
    fail(`${code}-uac`);
  }
  return value;
}

export function validateNativeAcceptanceManifest(value, { expectedHead, expectedVersion } = {}) {
  exactKeys(value, [
    'candidate', 'packages', 'review', 'schemaVersion', 'sourceHead', 'supportClearanceSha256'
  ], 'native-manifest-shape');
  if (value.schemaVersion !== 2) fail('native-manifest-version');
  exactSha(value.sourceHead, SHA40, 'native-manifest-head');
  if (expectedHead && value.sourceHead !== expectedHead) fail('native-manifest-head');
  if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(expectedVersion)) {
    fail('native-manifest-version-input');
  }
  exactSha(value.supportClearanceSha256, SHA64, 'native-support-clearance-hash');
  exactKeys(value.candidate, ['artifactDigest', 'artifactId', 'artifactName', 'workflowRunId'], 'native-candidate');
  positiveInteger(value.candidate.workflowRunId, 'native-candidate-run');
  positiveInteger(value.candidate.artifactId, 'native-candidate-artifact');
  if (value.candidate.artifactName !== `release-candidate-${value.sourceHead}`) fail('native-candidate-name');
  if (typeof value.candidate.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.candidate.artifactDigest)) {
    fail('native-candidate-digest');
  }
  exactKeys(value.review, ['base', 'head', 'pullRequest'], 'native-review');
  exactSha(value.review.base, SHA40, 'native-review-base');
  exactSha(value.review.head, SHA40, 'native-review-head');
  positiveInteger(value.review.pullRequest, 'native-review-pr');
  exactKeys(value.packages, PACKAGE_KINDS, 'native-packages');
  for (const kind of PACKAGE_KINDS) validateAcceptedPackage(value.packages[kind], kind, expectedVersion);
  if (value.packages.setup.packageSha256 === value.packages.portable.packageSha256) fail('native-package-hashes-not-distinct');
  return value;
}

export function validateSupportClearance(value, { expectedHead, packages } = {}) {
  exactKeys(value, [
    'acknowledgementFingerprint', 'backendDeploymentRevision', 'destinationFingerprint',
    'endpointConfigRevision', 'journeys', 'schemaVersion', 'sourceHead'
  ], 'support-clearance-shape');
  if (value.schemaVersion !== 1) fail('support-clearance-version');
  exactSha(value.sourceHead, SHA40, 'support-clearance-head');
  if (expectedHead && value.sourceHead !== expectedHead) fail('support-clearance-head');
  exactSha(value.endpointConfigRevision, SHA64, 'support-config-revision');
  exactSha(value.backendDeploymentRevision, IMMUTABLE_REVISION, 'support-deployment-revision');
  exactSha(value.destinationFingerprint, SHA64, 'support-destination-fingerprint');
  exactSha(value.acknowledgementFingerprint, SHA64, 'support-acknowledgement-fingerprint');
  if (!Array.isArray(value.journeys) || value.journeys.length !== PACKAGE_KINDS.length * JOURNEYS.length) {
    fail('support-journey-count');
  }
  const seen = new Set();
  for (const receipt of value.journeys) {
    exactKeys(receipt, [
      'acknowledgementFingerprint', 'backendDeploymentRevision', 'destinationFingerprint',
      'journey', 'kind', 'packageSha256', 'receiptSha256', 'success'
    ], 'support-journey-shape');
    if (!PACKAGE_KINDS.includes(receipt.kind) || !JOURNEYS.includes(receipt.journey)) fail('support-journey-identity');
    const identity = `${receipt.kind}:${receipt.journey}`;
    if (seen.has(identity)) fail('support-journey-duplicate');
    seen.add(identity);
    if (receipt.success !== true) fail('support-journey-failed');
    exactSha(receipt.packageSha256, SHA64, 'support-journey-package');
    exactSha(receipt.receiptSha256, SHA64, 'support-journey-receipt');
    if (packages && (!packages[receipt.kind] || receipt.packageSha256 !== packages[receipt.kind].packageSha256)) {
      fail('support-journey-package');
    }
    if (receipt.backendDeploymentRevision !== value.backendDeploymentRevision) fail('support-journey-deployment');
    if (receipt.destinationFingerprint !== value.destinationFingerprint) fail('support-journey-destination');
    if (receipt.acknowledgementFingerprint !== value.acknowledgementFingerprint) fail('support-journey-acknowledgement');
  }
  for (const kind of PACKAGE_KINDS) {
    for (const journey of JOURNEYS) if (!seen.has(`${kind}:${journey}`)) fail('support-journey-missing');
  }
  return value;
}

export function validateReleaseEvidence(nativeValue, supportValue, options = {}) {
  const native = validateNativeAcceptanceManifest(nativeValue, options);
  const support = validateSupportClearance(supportValue, {
    expectedHead: options.expectedHead,
    packages: native.packages
  });
  const supportHash = evidenceSha256(support);
  if (native.supportClearanceSha256 !== supportHash) fail('support-clearance-hash-mismatch');
  for (const kind of PACKAGE_KINDS) {
    if (native.packages[kind].supportConfigRevision !== support.endpointConfigRevision) {
      fail('support-config-package-mismatch');
    }
  }
  return { native, support, nativeSha256: evidenceSha256(native), supportSha256: supportHash };
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const head = argOf('--head', process.env.GITHUB_SHA || '');
  const version = argOf('--version', '');
  const out = path.resolve(argOf('--out', 'dist'));
  const native = parseEvidenceJson(process.env.NATIVE_ACCEPTANCE_MANIFEST || '', 'native-manifest-input');
  const support = parseEvidenceJson(process.env.SUPPORT_RELEASE_CLEARANCE || '', 'support-clearance-input');
  const evidence = validateReleaseEvidence(native, support, { expectedHead: head, expectedVersion: version });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'native-acceptance.json'), JSON.stringify(evidence.native, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'support-clearance.json'), JSON.stringify(evidence.support, null, 2) + '\n');
  console.log(`[release-evidence] wrote validated evidence; native=${evidence.nativeSha256} support=${evidence.supportSha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[release-evidence] ${error && error.code || 'evidence-invalid'}`);
    process.exitCode = 1;
  });
}
