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

function custodyFailure() {
  const error = failure('candidate-download-cleanup');
  error.preserveEntries = true;
  return error;
}

function failCustody() {
  throw custodyFailure();
}

function hasIdentity(stat, identity) {
  return stat && typeof stat.isFile === 'function' && stat.isFile() &&
    stat.dev === identity.dev && stat.ino === identity.ino;
}

async function closeHandles(handles) {
  let ok = true;
  for (const handle of handles.filter(Boolean)) {
    try { await handle.close(); } catch (_) { ok = false; }
  }
  return ok;
}

async function readIdentity(fileHandle) {
  let stat;
  try { stat = await fileHandle.stat({ bigint: true }); } catch (_) { failCustody(); }
  if (!stat.isFile() || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.ino <= 0n) {
    failCustody();
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function openOwnedEntry(fileSystem, entryPath, identity) {
  let handle = null;
  try {
    const entryStat = await fileSystem.lstat(entryPath, { bigint: true });
    if (!hasIdentity(entryStat, identity)) failCustody();
    handle = await fileSystem.open(entryPath, 'r');
    const handleStat = await handle.stat({ bigint: true });
    if (!hasIdentity(handleStat, identity)) failCustody();
    return handle;
  } catch (_) {
    if (handle) await closeHandles([handle]);
    failCustody();
  }
}

async function verifyOwnedEntry(fileSystem, entryPath, identity) {
  const handle = await openOwnedEntry(fileSystem, entryPath, identity);
  if (!await closeHandles([handle])) failCustody();
}

async function removeOwnedEntries(fileSystem, entryPaths, identity) {
  const proofs = [];
  try {
    for (const entryPath of entryPaths) proofs.push(await openOwnedEntry(fileSystem, entryPath, identity));
  } catch (_) {
    await closeHandles(proofs);
    failCustody();
  }
  let cleanupFailed = false;
  for (const entryPath of entryPaths) {
    try {
      await fileSystem.unlink(entryPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') cleanupFailed = true;
    }
  }
  for (const entryPath of entryPaths) {
    try {
      await fileSystem.lstat(entryPath, { bigint: true });
      cleanupFailed = true;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') cleanupFailed = true;
    }
  }
  if (!await closeHandles(proofs)) cleanupFailed = true;
  if (cleanupFailed) failCustody();
}

async function verifyPromotedFinal(fileSystem, finalPath, identity, expectedSize, expectedDigest) {
  const handle = await openOwnedEntry(fileSystem, finalPath, identity);
  let verifyError = null;
  try {
    const before = await handle.stat({ bigint: true });
    if (!hasIdentity(before, identity)) failCustody();
    if (before.size !== BigInt(expectedSize)) fail('candidate-download-size');
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      size += chunk.length;
      if (size > expectedSize) fail('candidate-download-size');
      hash.update(chunk);
    }
    if (size !== expectedSize) fail('candidate-download-size');
    if (`sha256:${hash.digest('hex')}` !== expectedDigest) fail('candidate-download-digest');
    const after = await handle.stat({ bigint: true });
    if (!hasIdentity(after, identity)) failCustody();
    if (after.size !== BigInt(expectedSize)) fail('candidate-download-size');
  } catch (error) {
    verifyError = error && error.code ? error : custodyFailure();
  }
  if (!await closeHandles([handle])) failCustody();
  if (verifyError) throw verifyError;
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
      typeof partialFileSystem.unlink !== 'function' || typeof partialFileSystem.lstat !== 'function' ||
      typeof partialFileSystem.link !== 'function') {
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
  let identity = null;
  let ownedEntries = [];
  try {
    try {
      partialHandle = await partialFileSystem.open(temp, 'wx+');
      ownedEntries = [temp];
      identity = await readIdentity(partialHandle);
    } catch (error) {
      if (error && error.code === 'EEXIST') fail('candidate-download-output-exists');
      if (error && error.preserveEntries) throw error;
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
    await partialHandle.sync();
    const writtenStat = await partialHandle.stat({ bigint: true });
    if (!hasIdentity(writtenStat, identity)) failCustody();
    if (writtenStat.size !== BigInt(expectedSize)) fail('candidate-download-size');

    const sourceProof = await openOwnedEntry(partialFileSystem, temp, identity);
    let linkError = null;
    try {
      await partialFileSystem.link(temp, out);
      ownedEntries.push(out);
    } catch (error) {
      linkError = error && error.code === 'EEXIST'
        ? failure('candidate-download-output-exists')
        : failure('candidate-download-failed');
    }
    if (!await closeHandles([sourceProof])) failCustody();
    if (linkError) throw linkError;
    await verifyOwnedEntry(partialFileSystem, out, identity);

    await removeOwnedEntries(partialFileSystem, [temp], identity);
    ownedEntries = [out];
    if (!await closeHandles([partialHandle])) failCustody();
    partialHandle = null;
    await verifyPromotedFinal(partialFileSystem, out, identity, expectedSize, expectedDigest);
  } catch (error) {
    let cleanupFailed = Boolean(error && error.preserveEntries);
    if (!cleanupFailed && identity && ownedEntries.length) {
      try { await removeOwnedEntries(partialFileSystem, ownedEntries, identity); }
      catch (_) { cleanupFailed = true; }
    }
    if (partialHandle && !await closeHandles([partialHandle])) cleanupFailed = true;
    if (cleanupFailed) fail('candidate-download-cleanup');
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
