'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { verifySupportEndpoint } = await import('../scripts/verify-support-endpoint.mjs');
  const { supportConfigRevision } = require('../src/main/support-client');
  const publicEndpoint = 'https://support.example/v1/feedback';
  const identity = {
    endpointConfigRevision: supportConfigRevision(publicEndpoint),
    backendDeploymentRevision: '1'.repeat(40),
    destinationFingerprint: '2'.repeat(64),
    acknowledgementFingerprint: '3'.repeat(64)
  };
  const ready = { ok: true, configured: true, service: '1132-fixer-support',
    capabilities: { feedback: true, statelessFeedback: true, screenshots: false },
    deploymentRevision: identity.backendDeploymentRevision,
    destinationFingerprint: identity.destinationFingerprint,
    acknowledgementFingerprint: identity.acknowledgementFingerprint };
  let calls = 0;
  await verifySupportEndpoint(publicEndpoint, identity, async (url, options) => {
    calls += 1;
    assert.equal(url.href, 'https://support.example/health');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify(ready));
  });
  assert.equal(calls, 1);
  for (const config of ['', 'http://support.example', 'https://secret@support.example', 'https://support.example/?token=private']) {
    await assert.rejects(verifySupportEndpoint(config, identity, () => { throw new Error('invalid configuration must not fetch'); }));
  }
  await assert.rejects(verifySupportEndpoint('https://support.example', null,
    () => { throw new Error('unbound identity must not fetch'); }));
  await assert.rejects(verifySupportEndpoint(publicEndpoint,
    { ...identity, endpointConfigRevision: '4'.repeat(64) },
    () => { throw new Error('wrong endpoint revision must not fetch'); }));
  for (const state of [
    {}, { ...ready, ok: false }, { ...ready, configured: false }, { ...ready, service: 'other' },
    { ...ready, capabilities: { feedback: true } },
    { ...ready, deploymentRevision: '4'.repeat(40) },
    { ...ready, destinationFingerprint: '4'.repeat(64) },
    { ...ready, acknowledgementFingerprint: '4'.repeat(64) }
  ]) {
    await assert.rejects(verifySupportEndpoint(publicEndpoint, identity,
      async () => new Response(JSON.stringify(state))));
  }
  for (const response of [new Response('{}', { status: 503 }), new Response('not JSON'), new Response('x'.repeat(16385))]) {
    await assert.rejects(verifySupportEndpoint(publicEndpoint, identity, async () => response));
  }
  await assert.rejects(verifySupportEndpoint(publicEndpoint, identity,
    async () => { throw new Error('PRIVATE_TOKEN fixture'); }),
  (error) => !error.message.includes('PRIVATE_TOKEN'));
  console.log('support-release-smoke: bound deployment/destination/ack identity, protocol, bounds and secret-safe errors passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
