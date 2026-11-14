'use strict';

// All outbound requests, responses, timers, generated configuration and build
// writes below are in-memory fakes. No server, socket, credential, user profile,
// child process or installed application is used by this smoke test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const adapterPath = path.join(root, 'src/main/support-client.js');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const configSource = fs.readFileSync(path.join(root, 'src/main/config.js'), 'utf8');
const injectionSource = fs.readFileSync(path.join(root, 'scripts/inject-config.js'), 'utf8');
const endpoint = 'https://support.example.test/';
const config = { FEEDBACK_PROXY_URL: endpoint };
// Synthetic structural headers accepted by the canonical relay; not visual QA.
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.writeUInt32BE(13, 8); Buffer.from('IHDR').copy(png, 12);
png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
const tests = [];
let unexpectedNetwork = 0;
let unexpectedStorage = 0;
const originalRequest = https.request;
const originalLoad = Module._load;

https.request = () => { unexpectedNetwork++; throw new Error('real network forbidden in synthetic test'); };
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === adapterPath && ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'http', 'node:http'].includes(request)) {
    unexpectedStorage++;
    throw new Error('adapter persistence/plaintext dependency forbidden');
  }
  return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[require.resolve(adapterPath)];
const support = require(adapterPath);

function test(name, fn) { tests.push({ name, fn }); }
function harness() {
  const state = { mode: 'ack', now: 1000, calls: [], timers: new Map(), nextTimer: 1, destroys: 0 };
  state.schedule = (fn, ms) => { const id = state.nextTimer++; state.timers.set(id, { fn, ms }); return id; };
  state.cancelSchedule = id => { state.timers.delete(id); };
  state.fireTimers = () => { for (const item of [...state.timers.values()]) item.fn(); };
  state.transportRequest = (options, onResponse) => {
    if (state.mode === 'throw') throw new Error('synthetic private transport detail');
    const req = new EventEmitter();
    const call = { options, chunks: [], req };
    state.calls.push(call);
    req.write = bytes => { call.chunks.push(Buffer.from(bytes)); };
    req.destroy = () => { state.destroys++; req.emit('close'); };
    req.end = () => {
      call.body = JSON.parse(Buffer.concat(call.chunks).toString('utf8'));
      const mode = state.mode;
      queueMicrotask(() => {
        if (mode === 'hold') return;
        if (mode === 'request-error') { req.emit('error', new Error('synthetic private request detail')); return; }
        const res = new EventEmitter();
        call.res = res;
        res.statusCode = 201;
        res.complete = true;
        res.destroy = () => { state.destroys++; res.emit('close'); };
        onResponse(res);
        if (mode === 'response-error') { res.emit('error', new Error('synthetic private response detail')); return; }
        if (mode === 'response-close') { res.complete = false; res.emit('close'); return; }
        let body = { success: true, requestId: call.body.requestId };
        if (mode === 'wrong-id') body.requestId = '00000000-0000-4000-8000-000000000000';
        if (mode === 'missing-id') delete body.requestId;
        if (mode === 'false-success') body.success = false;
        if (mode === 'legacy-ack') body = { ok: true, number: 123, caseRef: 'CASE-123' };
        if (mode === 'rating-error') { res.statusCode = 400; body = { success: false, error: { code: 'validation_failed', message: 'synthetic private detail' } }; }
        if (mode === 'rate-limit') { res.statusCode = 429; body = { success: false, error: { code: 'rate_limited' } }; }
        if (mode === 'too-large') { res.statusCode = 413; body = { success: false, error: { code: 'too_large' } }; }
        if (mode === 'cutover') { res.statusCode = 503; body = { success: false, error: { code: 'support_cutover_pending' } }; }
        if (mode === 'unknown') { res.statusCode = 503; body = { success: false, error: { code: 'send_unknown' } }; }
        if (mode === 'upstream-500') { res.statusCode = 502; body = { success: false, error: { code: 'discord_rejected_500' } }; }
        if (mode === 'redirect') res.statusCode = 302;
        if (mode === 'large') body.padding = 'x'.repeat(support.RESPONSE_MAX_BYTES);
        const bytes = Buffer.from(mode === 'malformed' ? 'not json' : JSON.stringify(body));
        res.emit('data', bytes);
        res.emit('end');
        res.emit('close');
        req.emit('close');
      });
    };
    return req;
  };
  state.client = support.createSupportClient({
    transportRequest: state.transportRequest, clock: () => state.now,
    schedule: state.schedule, cancelSchedule: state.cancelSchedule, timeoutMs: 100
  });
  state.submit = extra => state.client.submitFeedback({ config, type: 'Contact', text: 'Synthetic user-chosen message.', version: '6.4.0', ...extra });
  return state;
}

test('local availability is not a health read or readiness claim', () => {
  const h = harness();
  const cap = h.client.capabilities(config);
  assert.equal(cap.configured, true);
  assert.equal(cap.screenshots, true);
  assert.equal(cap.readiness, 'not-checked');
  assert.equal(h.client.capabilities({}).configured, false);
  assert.equal(h.client.capabilities({ ...config, FEEDBACK_CONFIG_INTEGRITY: false }).configured, false);
  assert.equal(h.calls.length, 0);
});
test('one explicit UUID POST and exact acknowledgement for every form', async () => {
  const h = harness();
  for (const type of ['Bug Report', 'User Rating', 'Contact']) {
    const result = await h.submit({ type, ...(type === 'User Rating' ? { rating: 4 } : {}) });
    assert.equal(result.success, true);
    assert.equal(result.delivery, 'acknowledged');
    const call = h.calls.at(-1);
    assert.equal(call.options.protocol, 'https:');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.path, '/v1/feedback');
    assert.equal(call.options.headers['Idempotency-Key'], call.body.requestId);
    assert.match(call.body.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(call.options.headers.Authorization, undefined);
    assert.deepEqual(Object.keys(call.body).sort(), (type === 'User Rating' ? ['rating', 'requestId', 'text', 'type', 'version'] : ['requestId', 'text', 'type', 'version']));
  }
  assert.equal(h.calls.length, 3);
  assert.equal(h.timers.size, 0);
});
for (const mode of ['wrong-id', 'missing-id', 'false-success', 'legacy-ack', 'malformed', 'large', 'request-error', 'response-error', 'response-close', 'redirect', 'upstream-500', 'unknown', 'throw']) {
  test(mode + ' cannot establish delivery or trigger an automatic retry', async () => {
    const h = harness(); h.mode = mode;
    const result = await h.submit();
    assert.equal(result.success, false);
    assert.equal(result.delivery, 'unknown');
    assert.equal(result.retryable, true);
    assert.ok(result.code && result.requestId);
    assert.equal(result.retryScope, 'same-app-and-relay-processes');
    assert.equal(result.retryUntilMs, 1000 + support.RETRY_WINDOW_MS);
    assert.ok(!String(result.error).includes('synthetic private'));
    assert.equal(h.calls.length, mode === 'throw' ? 0 : 1);
    assert.equal(h.timers.size, 0);
  });
}
for (const mode of ['rating-error', 'rate-limit', 'too-large', 'cutover']) {
  test(mode + ' is an honest definite rejection', async () => {
    const h = harness(); h.mode = mode;
    const result = await h.submit();
    assert.equal(result.success, false);
    assert.equal(result.delivery, 'not-sent');
    assert.ok(!String(result.error).includes('synthetic private'));
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
  });
}
test('absolute deadline drains a silent request and releases the per-form guard', async () => {
  const h = harness(); h.mode = 'hold';
  const pending = h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal([...h.timers.values()][0].ms, 100);
  assert.equal((await h.submit()).code, 'busy');
  assert.equal(h.calls.length, 1);
  h.fireTimers();
  const result = await pending;
  assert.equal(result.code, 'timeout');
  assert.equal(result.delivery, 'unknown');
  assert.ok(h.destroys > 0);
  assert.equal(h.timers.size, 0);
  h.mode = 'ack';
  assert.equal((await h.submit()).success, true);
});
test('unchanged retry reuses ID and confirmed receipt; edits start new submissions', async () => {
  const h = harness(); h.mode = 'unknown';
  const first = await h.submit();
  h.now += 1000;
  const second = await h.submit();
  assert.equal(second.requestId, first.requestId);
  assert.equal(second.retryUntilMs, first.retryUntilMs, 'unknown retry must not extend the window');
  h.mode = 'ack';
  assert.equal((await h.submit()).requestId, first.requestId);
  const callsAfterAck = h.calls.length;
  const replay = await h.submit();
  assert.equal(replay.requestId, first.requestId);
  assert.equal(replay.replayed, true);
  assert.equal(h.calls.length, callsAfterAck);
  h.mode = 'unknown';
  const old = await h.submit({ text: 'First deliberately edited synthetic request.' });
  assert.notEqual((await h.submit({ text: 'Deliberately edited synthetic request.' })).requestId, old.requestId);
});
test('confirmed unchanged draft never silently reposts after the relay cache expires', async () => {
  const h = harness();
  const first = await h.submit();
  h.now += support.RETRY_WINDOW_MS * 4;
  h.mode = 'unknown';
  const replay = await h.submit();
  assert.equal(replay.success, true);
  assert.equal(replay.requestId, first.requestId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.receiptScope, 'same-app-process');
  assert.equal(h.calls.length, 1);
});
test('unknown A then edited B then A preserves the original UUID and retry window', async () => {
  const h = harness(); h.mode = 'unknown';
  const a = await h.submit({ text: 'Synthetic unknown request A.' });
  h.now += 1000;
  const b = await h.submit({ text: 'Synthetic edited request B.' });
  assert.notEqual(b.requestId, a.requestId);
  h.mode = 'ack';
  const retried = await h.submit({ text: 'Synthetic unknown request A.' });
  assert.equal(retried.requestId, a.requestId);
  assert.equal(h.calls[2].body.requestId, a.requestId);
  assert.equal(h.calls.length, 3);
});
test('an expired unknown A remains blocked after edited B succeeds', async () => {
  const h = harness(); h.mode = 'unknown';
  const a = await h.submit({ text: 'Synthetic unknown request A.' });
  h.now = a.retryUntilMs;
  h.mode = 'ack';
  assert.equal((await h.submit({ text: 'Synthetic edited request B.' })).success, true);
  const retried = await h.submit({ text: 'Synthetic unknown request A.' });
  assert.equal(retried.code, 'delivery-unresolved');
  assert.equal(retried.requestId, a.requestId);
  assert.equal(retried.retryable, false);
  assert.equal(h.calls.length, 2, 'expired A must not be recreated under another UUID');
});
test('confirmed A then confirmed B then A reuses A receipt without another POST', async () => {
  const h = harness();
  const a = await h.submit({ text: 'Synthetic acknowledged request A.' });
  const b = await h.submit({ text: 'Synthetic acknowledged request B.' });
  assert.notEqual(b.requestId, a.requestId);
  h.now += support.RETRY_WINDOW_MS * 2;
  const replay = await h.submit({ text: 'Synthetic acknowledged request A.' });
  assert.equal(replay.requestId, a.requestId);
  assert.equal(replay.replayed, true);
  assert.equal(h.calls.length, 2);
});
test('bounded confirmed history refuses a new identity instead of evicting an old receipt', async () => {
  const h = harness();
  const first = await h.submit({ text: 'Synthetic retained receipt 0.' });
  for (let i = 1; i < support.MAX_REQUEST_RECORDS; i++) {
    assert.equal((await h.submit({ text: 'Synthetic retained receipt ' + i + '.' })).success, true);
  }
  const full = await h.submit({ text: 'Synthetic new request beyond capacity.' });
  assert.equal(full.code, 'client-history-full');
  assert.equal(full.retryable, false);
  assert.equal(full.delivery, 'not-sent');
  const replay = await h.submit({ text: 'Synthetic retained receipt 0.' });
  assert.equal(replay.requestId, first.requestId);
  assert.equal(replay.replayed, true);
  assert.equal(h.calls.length, support.MAX_REQUEST_RECORDS);
});
test('bounded unknown history retains expired identities and still permits same-UUID resolution', async () => {
  const h = harness(); h.mode = 'unknown';
  const first = await h.submit({ text: 'Synthetic unresolved identity 0.' });
  for (let i = 1; i < support.MAX_REQUEST_RECORDS; i++) {
    const result = await h.submit({ text: 'Synthetic unresolved identity ' + i + '.' });
    assert.equal(result.delivery, 'unknown');
  }
  assert.equal((await h.submit({ text: 'Synthetic overflow identity.' })).code, 'client-history-full');
  h.mode = 'ack';
  const resolved = await h.submit({ text: 'Synthetic unresolved identity 0.' });
  assert.equal(resolved.requestId, first.requestId);
  assert.equal(h.calls.length, support.MAX_REQUEST_RECORDS + 1);
  h.now = first.retryUntilMs;
  assert.equal((await h.submit({ text: 'Synthetic unresolved identity 1.' })).code, 'delivery-unresolved');
  assert.equal((await h.submit({ text: 'Synthetic overflow identity.' })).code, 'client-history-full');
  assert.equal(h.calls.length, support.MAX_REQUEST_RECORDS + 1);
});
test('rejection after an unknown outcome cannot erase earlier uncertainty', async () => {
  const h = harness(); h.mode = 'unknown';
  const first = await h.submit();
  h.mode = 'cutover';
  const rejected = await h.submit();
  assert.equal(rejected.delivery, 'unknown');
  assert.equal(rejected.requestId, first.requestId);
  assert.equal(rejected.retryUntilMs, first.retryUntilMs);
});
test('exact ten-minute boundary blocks an unresolved resend without replacing the UUID', async () => {
  const h = harness(); h.mode = 'unknown';
  const first = await h.submit();
  h.now = first.retryUntilMs;
  const result = await h.submit();
  assert.equal(result.code, 'delivery-unresolved');
  assert.equal(result.retryable, false);
  assert.equal(result.requestId, first.requestId);
  assert.equal(h.calls.length, 1);
});
test('clock rollback cannot reopen an unresolved retry window', async () => {
  const h = harness(); h.mode = 'unknown';
  await h.submit(); h.now = 999;
  assert.equal((await h.submit()).code, 'delivery-unresolved');
  assert.equal(h.calls.length, 1);
});
test('definite rejection can be retried later without falsely expiring a new unknown send', async () => {
  const h = harness(); h.mode = 'rate-limit';
  const first = await h.submit();
  h.now += support.RETRY_WINDOW_MS * 2;
  h.mode = 'unknown';
  const later = await h.submit();
  assert.equal(later.requestId, first.requestId);
  assert.equal(later.retryable, true);
  assert.equal(later.retryUntilMs, h.now + support.RETRY_WINDOW_MS);
});
test('a new app process cannot promise to recover earlier retry memory', async () => {
  const first = harness(); first.mode = 'unknown';
  const result = await first.submit();
  const next = harness(); next.mode = 'unknown';
  assert.notEqual((await next.submit()).requestId, result.requestId);
  assert.equal(result.retryScope, 'same-app-and-relay-processes');
});
for (const input of [undefined, null, '', 'http://support.example.test/', 'https://user:private-canary@support.example.test/', 'https://support.example.test/?token=private-canary', 'https://support.example.test/#', 'https://support.example.test/v1/principals', 'https://support.example.test/v1/cases', 'https://support.example.test/feedback', 'https://support.example.test/\n']) {
  test('unsafe or absent endpoint is disabled: ' + String(input).split(':')[0], () => {
    assert.equal(support.endpointUrl(input), null);
  });
}
test('endpoint normalization and revision are deterministic without claiming ownership', () => {
  assert.equal(support.endpointUrl(endpoint).href, 'https://support.example.test/v1/feedback');
  assert.equal(support.supportConfigRevision(endpoint), support.supportConfigRevision('https://support.example.test/v1/feedback/'));
  assert.notEqual(support.supportConfigRevision(endpoint), support.supportConfigRevision('https://other.example.test/'));
});
test('invalid input, rating and screenshot fields never reach transport', async () => {
  const h = harness();
  const cases = [
    { config: {} }, { config: { ...config, FEEDBACK_CONFIG_INTEGRITY: false } },
    { type: 'Other' }, { text: '' }, { text: null }, { version: 'not-a-version' },
    { type: 'User Rating' }, { type: 'User Rating', rating: 0 }, { type: 'User Rating', rating: 2.5 },
    { type: 'Contact', rating: 4 }, { screenshot: { bytes: png, mediaType: 'image/png' } },
    { type: 'Bug Report', screenshot: { bytes: png, mediaType: 'image/jpeg' } },
    { type: 'Bug Report', screenshot: { bytes: Buffer.alloc(0), mediaType: 'image/png' } }
  ];
  for (const value of cases) assert.equal((await h.submit(value)).success, false);
  for (const value of [null, false, [], 12]) assert.equal((await h.client.submitFeedback(value)).success, false);
  assert.equal(h.calls.length, 0);
});
test('UTF-8 bytes govern the complete report, not character count or truncation', async () => {
  const h = harness();
  const text = 'é'.repeat(50 * 1024);
  assert.equal((await h.submit({ text })).success, true);
  assert.equal(h.calls[0].body.text, text);
  assert.equal((await h.submit({ text: text + 'é' })).code, 'text-too-large');
  assert.equal(h.calls.length, 1);
});
test('all supported screenshot signatures use the same complete anonymous request', async () => {
  const h = harness();
  for (const [bytes, mediaType] of [[png, 'image/png'], [Buffer.from([255, 216, 255, 0]), 'image/jpeg'], [Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(7)]), 'image/gif'], [Buffer.from('RIFF0000WEBP0000'), 'image/webp']]) {
    assert.equal((await h.submit({ type: 'Bug Report', screenshot: { bytes, mediaType } })).success, true);
    assert.deepEqual(Buffer.from(h.calls.at(-1).body.screenshot.data, 'base64'), bytes);
  }
  const tooBig = Buffer.alloc(support.SCREENSHOT_MAX_BYTES + 1); png.copy(tooBig);
  assert.equal((await h.submit({ type: 'Bug Report', screenshot: { bytes: tooBig, mediaType: 'image/png' } })).code, 'invalid-screenshot');
  assert.equal(h.calls.length, 4);
});
test('truncated magic prefixes and PNG without IHDR are rejected before transport', async () => {
  const h = harness();
  const badPng = Buffer.from(png); Buffer.from('IEND').copy(badPng, 12);
  const invalid = [
    [png.subarray(0, 8), 'image/png'], [png.subarray(0, 23), 'image/png'], [badPng, 'image/png'],
    [Buffer.from([255, 216, 255]), 'image/jpeg'],
    [Buffer.from('GIF89a'), 'image/gif'], [Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(6)]), 'image/gif'],
    [Buffer.from('RIFF0000WEBP'), 'image/webp'], [Buffer.from('RIFF0000WEBP000'), 'image/webp']
  ];
  for (const [bytes, mediaType] of invalid) {
    const result = await h.submit({ type: 'Bug Report', screenshot: { bytes, mediaType } });
    assert.equal(result.code, 'invalid-screenshot');
    assert.equal(result.delivery, 'not-sent');
  }
  assert.equal(h.calls.length, 0);
});
test('high-bit bytes cannot masquerade as ASCII image headers', async () => {
  const h = harness();
  const disguisedPng = Buffer.from(png);
  for (let i = 12; i < 16; i++) disguisedPng[i] |= 128;
  const disguisedGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(7)]);
  for (let i = 0; i < 6; i++) disguisedGif[i] |= 128;
  const disguisedWebp = Buffer.from('RIFF0000WEBP0000');
  for (const i of [0, 1, 2, 3, 8, 9, 10, 11]) disguisedWebp[i] |= 128;
  for (const [bytes, mediaType] of [[disguisedPng, 'image/png'], [disguisedGif, 'image/gif'], [disguisedWebp, 'image/webp']]) {
    assert.equal((await h.submit({ type: 'Bug Report', screenshot: { bytes, mediaType } })).code, 'invalid-screenshot');
  }
  assert.equal(h.calls.length, 0);
});

function runtimeConfig({ generated, env = {}, resolveError, loadError } = {}) {
  const module = { exports: {} };
  const fakeRequire = request => {
    if (request === './support-client') return support;
    if (request === 'synthetic-generated-config') { if (loadError) throw loadError; return generated; }
    throw new Error('unexpected configuration dependency');
  };
  fakeRequire.resolve = () => {
    if (resolveError) throw resolveError;
    if (generated === undefined) throw Object.assign(new Error('absent'), { code: 'MODULE_NOT_FOUND' });
    return 'synthetic-generated-config';
  };
  vm.runInNewContext(configSource, { module, require: fakeRequire, process: { env } });
  return module.exports;
}
test('packaged endpoint wins over runtime environment and preserves independent product setting', () => {
  const generated = { FEEDBACK_PROXY_URL: endpoint, FEEDBACK_CONFIG_REVISION: support.supportConfigRevision(endpoint), PRODUCTS_URL: 'https://products.example.test/' };
  const output = runtimeConfig({ generated, env: { FEEDBACK_PROXY_URL: 'https://other.example.test/', PRODUCTS_URL: 'https://chosen.example.test/' } });
  assert.equal(output.FEEDBACK_PROXY_URL, support.endpointUrl(endpoint).href);
  assert.equal(output.FEEDBACK_CONFIG_SOURCE, 'bundled');
  assert.equal(output.FEEDBACK_CONFIG_INTEGRITY, true);
  assert.equal(output.PRODUCTS_URL, 'https://chosen.example.test/');
});
test('invalid, old or unloadable generated config never falls back to an environment endpoint', () => {
  for (const generated of [null, [], { FEEDBACK_PROXY_URL: endpoint }, { FEEDBACK_PROXY_URL: endpoint, FEEDBACK_CONFIG_REVISION: '0'.repeat(64) }]) {
    const output = runtimeConfig({ generated, env: { FEEDBACK_PROXY_URL: endpoint } });
    assert.equal(output.FEEDBACK_PROXY_URL, '');
    assert.equal(output.FEEDBACK_CONFIG_SOURCE, 'bundled');
    assert.equal(output.FEEDBACK_CONFIG_INTEGRITY, false);
  }
  const output = runtimeConfig({ generated: {}, loadError: new SyntaxError('synthetic generated failure'), env: { FEEDBACK_PROXY_URL: endpoint } });
  assert.equal(output.FEEDBACK_PROXY_URL, '');
  assert.equal(output.FEEDBACK_CONFIG_INTEGRITY, false);
  assert.equal(runtimeConfig({ resolveError: Object.assign(new Error('refused'), { code: 'EACCES' }), env: { FEEDBACK_PROXY_URL: endpoint } }).FEEDBACK_PROXY_URL, '');
});
test('only absent generated config permits validated development input', () => {
  const output = runtimeConfig({ env: { FEEDBACK_PROXY_URL: endpoint } });
  assert.equal(output.FEEDBACK_CONFIG_SOURCE, 'development');
  assert.equal(output.FEEDBACK_CONFIG_INTEGRITY, true);
  assert.equal(output.FEEDBACK_PROXY_URL, support.endpointUrl(endpoint).href);
  assert.equal(runtimeConfig().FEEDBACK_PROXY_URL, '');
});
function inject(env) {
  const writes = [], logs = [];
  const process = { env, exitCode: 0 };
  const fakeRequire = request => {
    if (request === 'fs') return { mkdirSync() {}, writeFileSync(file, body) { writes.push({ file, body }); } };
    if (request === 'path') return path;
    if (request === '../src/main/support-client') return support;
    throw new Error('unexpected injection dependency');
  };
  vm.runInNewContext(injectionSource, { require: fakeRequire, process, __dirname: path.join(root, 'scripts'), console: { log: s => logs.push(s), warn: s => logs.push(s), error: s => logs.push(s) } });
  return { writes, logs, exitCode: process.exitCode };
}
test('build input rejection writes nothing and never prints credential-shaped input', () => {
  for (const value of ['private-canary', 'http://localhost/', 'https://user:private-canary@support.example.test/', 'https://support.example.test/?token=private-canary']) {
    const result = inject({ FEEDBACK_PROXY_URL: value });
    assert.equal(result.exitCode, 1);
    assert.equal(result.writes.length, 0);
    assert.ok(!result.logs.join('\n').includes(value));
    assert.ok(!result.logs.join('\n').includes('private-canary'));
  }
});
test('build output contains only public normalized endpoint and revision', () => {
  const result = inject({ FEEDBACK_PROXY_URL: endpoint, DISCORD_BOT_TOKEN: 'private-canary' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.writes.length, 1);
  assert.ok(!result.writes[0].body.includes('private-canary'));
  const module = { exports: {} };
  vm.runInNewContext(result.writes[0].body, { module });
  assert.deepEqual(Object.keys(module.exports).sort(), ['FEEDBACK_CONFIG_REVISION', 'FEEDBACK_PROXY_URL']);
  assert.equal(module.exports.FEEDBACK_PROXY_URL, support.endpointUrl(endpoint).href);
  assert.equal(module.exports.FEEDBACK_CONFIG_REVISION, support.supportConfigRevision(endpoint));
  assert.equal(inject({}).writes.length, 1, 'disabled builds remain explicit, without a fabricated endpoint');
});
test('legacy screenshot export remains without touching credential fields', async () => {
  const h = harness();
  const module = { exports: {} };
  vm.runInNewContext(adapterSource, {
    module, Buffer, URL, Date, setTimeout: h.schedule, clearTimeout: h.cancelSchedule,
    require: request => request === 'crypto' ? crypto : request === 'https' ? { request: h.transportRequest }
      : request === '../../messages' ? { FEEDBACK_FALLBACK: 'Not confirmed', FEEDBACK_NETWORK: 'Not confirmed' }
        : (() => { throw new Error('unexpected adapter dependency'); })()
  });
  const opts = { config, text: 'Synthetic screenshot report.', version: '6.4.0', screenshot: { bytes: png, mediaType: 'image/png' } };
  for (const key of ['userDataDir', 'safeStorage', 'osLabel']) Object.defineProperty(opts, key, { get() { throw new Error('old credential/environment field read'); } });
  assert.equal((await module.exports.submitBugWithScreenshot(opts)).success, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.type, 'Bug Report');
});
test('no real network or adapter persistence dependency was used', () => {
  assert.equal(unexpectedNetwork, 0);
  assert.equal(unexpectedStorage, 0);
});

(async () => {
  let passed = 0, failed = 0;
  try {
    for (const item of tests) {
      try { await item.fn(); passed++; }
      catch (error) { failed++; console.error('FAIL support-submission: ' + item.name + ': ' + error.message); }
    }
  } finally {
    https.request = originalRequest;
    Module._load = originalLoad;
  }
  console.log('support-submission-smoke: ' + passed + ' passed, ' + failed + ' failed; synthetic transport/configuration only');
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
