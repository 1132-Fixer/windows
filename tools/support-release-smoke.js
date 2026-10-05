'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { verifySupportEndpoint } = await import('../scripts/verify-support-endpoint.mjs');
  const ready = { ok: true, configured: true, service: '1132-fixer-support', capabilities: { feedback: true, statelessFeedback: true, screenshots: false } };
  let calls = 0;
  await verifySupportEndpoint('https://support.example/v1/feedback', async (url, options) => {
    calls += 1;
    assert.equal(url.href, 'https://support.example/health');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify(ready));
  });
  assert.equal(calls, 1);
  for (const config of ['', 'http://support.example', 'https://secret@support.example', 'https://support.example/?token=private']) {
    await assert.rejects(verifySupportEndpoint(config, () => { throw new Error('invalid configuration must not fetch'); }));
  }
  for (const state of [ {}, { ...ready, ok: false }, { ...ready, configured: false }, { ...ready, service: 'other' }, { ...ready, capabilities: { feedback: true } } ]) {
    await assert.rejects(verifySupportEndpoint('https://support.example', async () => new Response(JSON.stringify(state))));
  }
  for (const response of [new Response('{}', { status: 503 }), new Response('not JSON'), new Response('x'.repeat(16385))]) {
    await assert.rejects(verifySupportEndpoint('https://support.example', async () => response));
  }
  await assert.rejects(verifySupportEndpoint('https://support.example', async () => { throw new Error('PRIVATE_TOKEN fixture'); }), (error) => !error.message.includes('PRIVATE_TOKEN'));
  console.log('support-release-smoke: readiness, protocol, bounds and secret-safe errors passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
