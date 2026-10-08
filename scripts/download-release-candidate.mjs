#!/usr/bin/env node
/** Download one preflight-authorized Actions artifact and verify its archive digest. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHubRestClient } from './github-rest.mjs';

export const MAX_CANDIDATE_ARCHIVE_BYTES = 1024 * 1024 * 1024;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code) {
  throw failure(code);
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function declaredContentLength(response) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return Number.NaN;
  const value = response.headers.get('content-length');
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return Number.NaN;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : Number.NaN;
}

async function cancelBody(body) {
  if (!body || typeof body.cancel !== 'function') return;
  try { await body.cancel(); } catch (_) { /* best-effort cancellation after a fixed failure */ }
}

async function removeOwnedPartial(fileSystem, partialPath, fileHandle) {
  let cleanupFailed = false;
  if (fileHandle) {
    try { await fileHandle.close(); } catch (_) { cleanupFailed = true; }
  }
  try {
    await fileSystem.unlink(partialPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') cleanupFailed = true;
  }
  let absent = false;
  try {
    await fileSystem.lstat(partialPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') absent = true;
    else cleanupFailed = true;
  }
  if (cleanupFailed || !absent) fail('candidate-download-cleanup');
}

export async function downloadReleaseCandidate({
  api, repository, artifactId, runId, expectedName, expectedHead, expectedDigest, out,
  partialFileSystem = fs.promises
}) {
  if (!api || typeof api.json !== 'function' || typeof api.request !== 'function' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(artifactId) || artifactId < 1 || !Number.isSafeInteger(runId) || runId < 1 ||
      !/^release-candidate-[a-f0-9]{40}$/.test(expectedName) || !/^[a-f0-9]{40}$/.test(expectedHead) ||
      !/^sha256:[a-f0-9]{64}$/.test(expectedDigest) || typeof out !== 'string' || !out ||
      !partialFileSystem || typeof partialFileSystem.open !== 'function' ||
      typeof partialFileSystem.unlink !== 'function' || typeof partialFileSystem.lstat !== 'function') {
    fail('candidate-download-input');
  }
  const base = `/repos/${repository}`;
  const metadata = await api.json('GET', `${base}/actions/artifacts/${artifactId}`);
  if (!metadata || metadata.id !== artifactId || metadata.name !== expectedName || metadata.expired === true ||
      metadata.digest !== expectedDigest || !metadata.workflow_run || metadata.workflow_run.id !== runId ||
      metadata.workflow_run.head_sha !== expectedHead) fail('candidate-download-identity');
  const expectedSize = metadata.size_in_bytes;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 ||
      expectedSize > MAX_CANDIDATE_ARCHIVE_BYTES) fail('candidate-download-size');
  const temp = `${out}.part-${process.pid}`;
  if (fs.existsSync(out)) fail('candidate-download-output-exists');
  let partialHandle = null;
  let ownsPartial = false;
  try {
    try {
      partialHandle = await partialFileSystem.open(temp, 'wx');
      ownsPartial = true;
    } catch (error) {
      if (error && error.code === 'EEXIST') fail('candidate-download-output-exists');
      fail('candidate-download-partial-open');
    }
    const archive = await api.request('GET', `${base}/actions/artifacts/${artifactId}/zip`, {
      accept: 'application/octet-stream', errorCode: 'candidate-download-failed', followRedirects: true
    });
    if (!archive.body) fail('candidate-download-body');
    const declaredSize = declaredContentLength(archive);
    if (declaredSize !== null && declaredSize !== expectedSize) {
      await cancelBody(archive.body);
      fail('candidate-download-size');
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tee = new Transform({
      transform(chunk, _encoding, callback) {
        const nextSize = size + chunk.length;
        if (nextSize > expectedSize) {
          callback(failure('candidate-download-size'));
          return;
        }
        size = nextSize;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(archive.body), tee,
      partialHandle.createWriteStream({ autoClose: false }));
    if (size !== expectedSize) fail('candidate-download-size');
    const digest = `sha256:${hash.digest('hex')}`;
    if (digest !== expectedDigest) fail('candidate-download-digest');
    await partialHandle.close();
    partialHandle = null;
    fs.renameSync(temp, out);
    ownsPartial = false;
  } catch (error) {
    if (ownsPartial) await removeOwnedPartial(partialFileSystem, temp, partialHandle);
    throw error;
  }
  console.log(`[release-candidate] downloaded verified artifact ${artifactId}`);
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) fail('candidate-download-input');
  await downloadReleaseCandidate({
    api: createGitHubRestClient({ token, userAgent: '1132-fixer-release-candidate' }),
    repository,
    artifactId: Number(argOf('--artifact-id')),
    runId: Number(argOf('--run-id')),
    expectedName: argOf('--name'),
    expectedHead: argOf('--head'),
    expectedDigest: argOf('--digest'),
    out: path.resolve(argOf('--out', 'release-candidate.zip'))
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[release-candidate] ${error && error.code || 'candidate-download-failed'}`);
    process.exitCode = 1;
  });
}
