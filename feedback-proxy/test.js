/**
 * Smoke test for the feedback proxy.
 *
 * Runs the real server on a random port with a FAKE token and a stubbed
 * github.com fetch, so nothing ever hits the real API and no credential is
 * needed. Exercises the validation/limits that matter and asserts the token is
 * never echoed back to a client.
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FAKE_TOKEN = 'github_pat_FAKE_TOKEN_FOR_TESTS_ONLY';
const PORT = 39117;

// --- Stub GitHub: intercept fetch before loading the server ----------
const captured = [];
global.fetch = async (url, opts) => {
  captured.push({ url, opts });
  return {
    status: 201,
    json: async () => ({ number: 4242 }),
    text: async () => '',
  };
};

process.env.PORT = String(PORT);
process.env.GH_ISSUES_TOKEN = FAKE_TOKEN;
process.env.GH_ISSUES_REPO = 'PrimeUpYourLife/1132-Fixer-Windows';

// Loading server.js starts it listening.
require('./server.js');

function req(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = Object.assign(
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      extraHeaders || {}
    );
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path, method, headers },
      (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ status: res.statusCode, body: s }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('health returns ok + configured', async () => {
  const r = await req('GET', '/health');
  const j = JSON.parse(r.body);
  return r.status === 200 && j.ok === true && j.configured === true;
});

check('health never leaks the token', async () => {
  const r = await req('GET', '/health');
  return !r.body.includes(FAKE_TOKEN) && !r.body.includes('github_pat_');
});

check('unknown route 404s', async () => {
  const r = await req('GET', '/whatever');
  return r.status === 404;
});

check('valid feedback creates an issue (201)', async () => {
  const r = await req('POST', '/feedback', { type: 'Bug Report', text: 'camera does not work', version: '5.3.11', os: 'Windows 10.0.26200' });
  const j = JSON.parse(r.body);
  return r.status === 201 && j.ok === true && j.number === 4242;
});

check('token goes to GitHub in the Authorization header', async () => {
  const last = captured[captured.length - 1];
  return last && last.opts.headers.Authorization === `Bearer ${FAKE_TOKEN}`;
});

check('server builds the label; client cannot choose it', async () => {
  const last = captured[captured.length - 1];
  const sent = JSON.parse(last.opts.body);
  return Array.isArray(sent.labels) && sent.labels.length === 1 && sent.labels[0] === 'bug-report';
});

check('renderer contract: every type the app actually sends is accepted', async () => {
  // Read the types straight out of renderer.js so client/server drift fails
  // this test instead of shipping (the 'Contact' regression class). Each probe
  // uses its own x-forwarded-for so the shared-IP rate budget is untouched.
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const types = [...new Set([...rendererSrc.matchAll(/submitFeedback\(\s*'([^']+)'/g)].map((m) => m[1]))];
  if (!types.length) { console.log('   regex found no submitFeedback types — fix the test'); return false; }
  for (let i = 0; i < types.length; i++) {
    const r = await req('POST', '/feedback', { type: types[i], text: 'contract probe for ' + types[i] }, { 'x-forwarded-for': '10.99.0.' + (i + 1) });
    if (r.status !== 201) { console.log(`   type '${types[i]}' -> ${r.status} ${r.body}`); return false; }
    const sent = JSON.parse(captured[captured.length - 1].opts.body);
    if (!Array.isArray(sent.labels) || sent.labels.length !== 1 || !sent.labels[0]) return false;
  }
  return true;
});

check('multi-line text yields a single-line issue title', async () => {
  const r = await req('POST', '/feedback', { type: 'Feedback', text: '## Report\nline two\nline three of the report body' }, { 'x-forwarded-for': '10.99.1.1' });
  if (r.status !== 201) return false;
  const sent = JSON.parse(captured[captured.length - 1].opts.body);
  return !sent.title.includes('\n') && sent.title.startsWith('[Feedback] ## Report line two');
});

check('bogus type rejected (400)', async () => {
  const r = await req('POST', '/feedback', { type: 'Arbitrary Label', text: 'x' });
  return r.status === 400 && JSON.parse(r.body).error === 'bad_type';
});

check('empty text rejected (400)', async () => {
  const r = await req('POST', '/feedback', { type: 'Feedback', text: '   ' });
  return r.status === 400 && JSON.parse(r.body).error === 'empty_text';
});

check('malformed json rejected (400)', async () => {
  const r = await req('POST', '/feedback', '{not json');
  return r.status === 400 && JSON.parse(r.body).error === 'bad_json';
});

check('oversized payload rejected (413)', async () => {
  const r = await req('POST', '/feedback', { type: 'Feedback', text: 'A'.repeat(20000) });
  return r.status === 413 || r.status === 400;
});

check('rate limit kicks in (429)', async () => {
  let sawLimit = false;
  for (let i = 0; i < 10; i++) {
    const r = await req('POST', '/feedback', { type: 'Feedback', text: 'spam ' + i });
    if (r.status === 429) { sawLimit = true; break; }
  }
  return sawLimit;
});

check('no client response ever contains the token', async () => {
  const probes = [
    await req('GET', '/health'),
    await req('POST', '/feedback', { type: 'Feedback', text: 'hello' }),
    await req('POST', '/feedback', { type: 'nope', text: 'x' }),
  ];
  return probes.every((p) => !p.body.includes(FAKE_TOKEN));
});

(async () => {
  console.log('=== feedback-proxy smoke ===\n');
  let pass = true;
  for (const c of checks) {
    let ok = false;
    try { ok = await c.fn(); } catch (e) { ok = false; console.log('   threw: ' + e.message); }
    if (!ok) pass = false;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  console.log('');
  console.log(pass ? 'ALL PASS' : 'FAILURES PRESENT');
  process.exit(pass ? 0 : 1);
})();
