// Release-only readiness check. The desktop app never runs this request.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReleaseEvidence } from './release-evidence.mjs';

const require = createRequire(import.meta.url);
const { endpointUrl, supportConfigRevision } = require('../src/main/support-client');

function expectedSupportIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  const allowed = [
    'acknowledgementFingerprint', 'backendDeploymentRevision', 'destinationFingerprint',
    'endpointConfigRevision'
  ];
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return null;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.backendDeploymentRevision || '') ||
      !/^[a-f0-9]{64}$/.test(value.destinationFingerprint || '') ||
      !/^[a-f0-9]{64}$/.test(value.acknowledgementFingerprint || '') ||
      !/^[a-f0-9]{64}$/.test(value.endpointConfigRevision || '')) return null;
  return value;
}

export async function verifySupportEndpoint(value, expected, fetchImpl = fetch) {
  const endpoint = endpointUrl(value);
  if (!endpoint) throw new Error('A valid public HTTPS support endpoint is required.');
  const identity = expectedSupportIdentity(expected);
  if (!identity) throw new Error('A bound support deployment identity is required.');
  if (supportConfigRevision(endpoint.href) !== identity.endpointConfigRevision) {
    throw new Error('The public support configuration revision does not match the release evidence.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(new URL('/health', endpoint), {
      signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('The support service is not ready.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('The support response is invalid.'); }
      chunks.push(Buffer.from(chunk));
    }
    const state = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (state.ok !== true || state.service !== '1132-fixer-support' || state.configured !== true ||
        state.capabilities?.feedback !== true || state.capabilities?.statelessFeedback !== true ||
        state.deploymentRevision !== identity.backendDeploymentRevision ||
        state.destinationFingerprint !== identity.destinationFingerprint ||
        state.acknowledgementFingerprint !== identity.acknowledgementFingerprint) {
      throw new Error('The verified stateless support service is required.');
    }
  } catch (_) {
    // Do not log URLs, response bodies or connection errors: configuration
    // may contain private data when supplied incorrectly.
    throw new Error('Support readiness verification failed. Check the public endpoint and service configuration.');
  } finally { clearTimeout(timer); }
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const native = fs.readFileSync(path.resolve(argOf('--native')));
    const support = fs.readFileSync(path.resolve(argOf('--support')));
    const evidence = validateReleaseEvidence(native, support, {
      expectedHead: process.env.GITHUB_SHA || '',
      expectedVersion: process.env.RELEASE_VERSION || ''
    });
    verifySupportEndpoint(process.env.FEEDBACK_PROXY_URL, {
      endpointConfigRevision: evidence.support.endpointConfigRevision,
      backendDeploymentRevision: evidence.support.backendDeploymentRevision,
      destinationFingerprint: evidence.support.destinationFingerprint,
      acknowledgementFingerprint: evidence.support.acknowledgementFingerprint
    }).then(() => {
      console.log('[release] Verified the bound stateless support deployment is ready.');
    }).catch(() => {
      console.error('[release] Support readiness verification failed.');
      process.exitCode = 1;
    });
  } catch (_) {
    console.error('[release] Support release evidence is invalid.');
    process.exitCode = 1;
  }
}
