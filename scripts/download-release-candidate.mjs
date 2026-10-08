#!/usr/bin/env node
/** Download one preflight-authorized Actions artifact and verify its archive digest. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function request(url, token, accept = 'application/vnd.github+json') {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'User-Agent': '1132-fixer-release-candidate',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) fail('candidate-download-failed');
  return response;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const artifactId = Number(argOf('--artifact-id'));
  const runId = Number(argOf('--run-id'));
  const expectedName = argOf('--name');
  const expectedHead = argOf('--head');
  const expectedDigest = argOf('--digest');
  const out = path.resolve(argOf('--out', 'release-candidate.zip'));
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(artifactId) || artifactId < 1 || !Number.isSafeInteger(runId) || runId < 1 ||
      !/^release-candidate-[a-f0-9]{40}$/.test(expectedName) || !/^[a-f0-9]{40}$/.test(expectedHead) ||
      !/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) fail('candidate-download-input');
  const base = `https://api.github.com/repos/${repository}`;
  const metadataResponse = await request(`${base}/actions/artifacts/${artifactId}`, token);
  const metadata = await metadataResponse.json();
  if (metadata.id !== artifactId || metadata.name !== expectedName || metadata.expired === true ||
      metadata.digest !== expectedDigest || !metadata.workflow_run || metadata.workflow_run.id !== runId ||
      metadata.workflow_run.head_sha !== expectedHead) fail('candidate-download-identity');
  const archive = await request(`${base}/actions/artifacts/${artifactId}/zip`, token, 'application/octet-stream');
  if (!archive.body) fail('candidate-download-body');
  const temp = `${out}.part-${process.pid}`;
  if (fs.existsSync(out) || fs.existsSync(temp)) fail('candidate-download-output-exists');
  const hash = crypto.createHash('sha256');
  const tee = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(archive.body), tee, fs.createWriteStream(temp, { flags: 'wx' }));
    const digest = `sha256:${hash.digest('hex')}`;
    if (digest !== expectedDigest) fail('candidate-download-digest');
    fs.renameSync(temp, out);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) { /* exact owned partial may already be absent */ }
    throw error;
  }
  console.log(`[release-candidate] downloaded verified artifact ${artifactId}`);
}

main().catch(error => {
  console.error(`[release-candidate] ${error && error.code || 'candidate-download-failed'}`);
  process.exitCode = 1;
});
