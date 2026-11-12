#!/usr/bin/env node
/** Fetch, validate, and materialize immutable non-secret release receipts. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createGitHubRestClient } from './github-rest.mjs';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const IMMUTABLE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PACKAGE_KINDS = Object.freeze(['setup', 'portable']);
const JOURNEYS = Object.freeze(['bug-report', 'user-rating', 'contact']);
const RECEIPT_WORKFLOW = '.github/workflows/release-evidence.yml';
const RECEIPT_POLICIES = Object.freeze({
  native: Object.freeze({ entryName: 'native-acceptance.json', name: head => `native-acceptance-receipt-${head}` }),
  support: Object.freeze({ entryName: 'support-clearance.json', name: head => `support-clearance-receipt-${head}` })
});
const RECEIPT_ARCHIVE_LIMIT = 2 * 1024 * 1024;
const RECEIPT_BYTES_LIMIT = 64 * 1024;

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

function asReceiptBytes(value, code, limit = RECEIPT_BYTES_LIMIT) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(code);
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > limit) fail(code);
  return bytes;
}

export function receiptSha256(value) {
  return crypto.createHash('sha256')
    .update(asReceiptBytes(value, 'evidence-bytes-required', RECEIPT_ARCHIVE_LIMIT))
    .digest('hex');
}

// Existing callers keep the old export name, but objects and environment JSON
// are no longer accepted. The digest always covers exact retrieved bytes.
export const evidenceSha256 = receiptSha256;

export function parseEvidenceBytes(value, code) {
  const bytes = asReceiptBytes(value, code);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    fail(code);
  }
  if (!text.trim() || text.charCodeAt(0) === 0xfeff) fail(code);
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

export function validateReleaseEvidence(nativeBytesInput, supportBytesInput, options = {}) {
  const nativeBytes = asReceiptBytes(nativeBytesInput, 'native-receipt-bytes-required');
  const supportBytes = asReceiptBytes(supportBytesInput, 'support-receipt-bytes-required');
  const native = validateNativeAcceptanceManifest(parseEvidenceBytes(nativeBytes, 'native-manifest-input'), options);
  const support = validateSupportClearance(parseEvidenceBytes(supportBytes, 'support-clearance-input'), {
    expectedHead: options.expectedHead,
    packages: native.packages
  });
  const supportHash = receiptSha256(supportBytes);
  if (native.supportClearanceSha256 !== supportHash) fail('support-clearance-hash-mismatch');
  for (const kind of PACKAGE_KINDS) {
    if (native.packages[kind].supportConfigRevision !== support.endpointConfigRevision) {
      fail('support-config-package-mismatch');
    }
  }
  return {
    native, support, nativeBytes, supportBytes,
    nativeSha256: receiptSha256(nativeBytes), supportSha256: supportHash
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractReceiptArchive(value, expectedEntry) {
  const archive = Buffer.from(value || []);
  if (!archive.length || archive.length > RECEIPT_ARCHIVE_LIMIT ||
      typeof expectedEntry !== 'string' || !/^[a-z0-9-]+\.json$/.test(expectedEntry)) {
    fail('receipt-archive-invalid');
  }
  const minimum = Math.max(0, archive.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minimum; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 + archive.readUInt16LE(eocd + 20) !== archive.length ||
      archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0 ||
      archive.readUInt16LE(eocd + 8) !== 1 || archive.readUInt16LE(eocd + 10) !== 1) {
    fail('receipt-archive-invalid');
  }
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd || centralSize < 46 ||
      archive.readUInt32LE(centralOffset) !== 0x02014b50) fail('receipt-archive-invalid');
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const expectedCrc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const centralEnd = centralOffset + 46 + nameLength + extraLength + commentLength;
  if ((flags & 1) !== 0 || ![0, 8].includes(method) || uncompressedSize > RECEIPT_BYTES_LIMIT ||
      centralEnd !== eocd || localOffset + 30 > centralOffset ||
      archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8') !== expectedEntry ||
      archive.readUInt32LE(localOffset) !== 0x04034b50) fail('receipt-archive-invalid');
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localMethod = archive.readUInt16LE(localOffset + 8);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + compressedSize;
  if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset ||
      archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8') !== expectedEntry) {
    fail('receipt-archive-invalid');
  }
  let receipt;
  try {
    const compressed = archive.subarray(dataOffset, dataEnd);
    receipt = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: RECEIPT_BYTES_LIMIT });
  } catch (_) {
    fail('receipt-archive-invalid');
  }
  if (receipt.length !== uncompressedSize || crc32(receipt) !== expectedCrc) fail('receipt-archive-invalid');
  return receipt;
}

export async function fetchAuthoritativeReceipt({ api, repository, artifactId, head, kind }) {
  if (!api || typeof api.json !== 'function' || typeof api.bytes !== 'function' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !SHA40.test(head || '') ||
      !Number.isSafeInteger(artifactId) || artifactId < 1 || !RECEIPT_POLICIES[kind]) {
    fail('receipt-reference-invalid');
  }
  const root = `/repos/${repository}`;
  const policy = RECEIPT_POLICIES[kind];
  const artifact = await api.json('GET', `${root}/actions/artifacts/${artifactId}`);
  if (!artifact || artifact.id !== artifactId || artifact.name !== policy.name(head) || artifact.expired === true ||
      typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
      !artifact.workflow_run || !Number.isSafeInteger(artifact.workflow_run.id) ||
      artifact.workflow_run.head_sha !== head) fail('receipt-artifact-invalid');
  const run = await api.json('GET', `${root}/actions/runs/${artifact.workflow_run.id}`);
  const actor = String(run && run.actor && run.actor.login || '').toLowerCase();
  const triggeringActor = String(run && run.triggering_actor && run.triggering_actor.login || '').toLowerCase();
  if (!run || run.id !== artifact.workflow_run.id || run.head_sha !== head || run.head_branch !== 'main' ||
      run.event !== 'workflow_dispatch' || run.path !== RECEIPT_WORKFLOW || run.status !== 'completed' ||
      run.conclusion !== 'success' || !run.repository || run.repository.full_name !== repository ||
      !actor || triggeringActor !== actor) fail('receipt-issuer-run');
  const archive = await api.bytes(`${root}/actions/artifacts/${artifactId}/zip`, {
    accept: 'application/octet-stream', maxBytes: RECEIPT_ARCHIVE_LIMIT,
    errorCode: 'receipt-download-failed', sizeCode: 'receipt-archive-invalid',
    followRedirects: true
  });
  const archiveSha256 = receiptSha256(archive);
  if (`sha256:${archiveSha256}` !== artifact.digest) fail('receipt-archive-digest');
  const bytes = extractReceiptArchive(archive, policy.entryName);
  return Object.freeze({
    kind, bytes, sha256: receiptSha256(bytes), archiveSha256,
    artifact: Object.freeze({ id: artifact.id, name: artifact.name, digest: artifact.digest }),
    issuer: Object.freeze({ login: actor, workflowRunId: run.id, workflowPath: run.path })
  });
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const head = argOf('--head', process.env.GITHUB_SHA || '');
  const version = argOf('--version', '');
  const out = path.resolve(argOf('--out', 'dist'));
  const nativeArtifactId = Number(argOf('--native-artifact-id'));
  const supportArtifactId = Number(argOf('--support-artifact-id'));
  if (!token) fail('github-token-missing');
  const api = createGitHubRestClient({ token, userAgent: '1132-fixer-release-evidence' });
  const nativeReceipt = await fetchAuthoritativeReceipt({ api, repository, artifactId: nativeArtifactId, head, kind: 'native' });
  const supportReceipt = await fetchAuthoritativeReceipt({ api, repository, artifactId: supportArtifactId, head, kind: 'support' });
  if (nativeReceipt.artifact.digest !== argOf('--native-artifact-digest') ||
      supportReceipt.artifact.digest !== argOf('--support-artifact-digest') ||
      nativeReceipt.sha256 !== argOf('--native-evidence-sha256') ||
      supportReceipt.sha256 !== argOf('--support-clearance-sha256')) fail('receipt-readback-mismatch');
  const evidence = validateReleaseEvidence(nativeReceipt.bytes, supportReceipt.bytes, {
    expectedHead: head, expectedVersion: version
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'native-acceptance.json'), evidence.nativeBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'support-clearance.json'), evidence.supportBytes, { flag: 'wx' });
  console.log(`[release-evidence] wrote immutable receipts; native=${evidence.nativeSha256} support=${evidence.supportSha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[release-evidence] ${error && error.code || 'evidence-invalid'}`);
    process.exitCode = 1;
  });
}
