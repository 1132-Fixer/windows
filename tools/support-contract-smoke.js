#!/usr/bin/env node
'use strict';

// The support contract is defined in 1132-Fixer/support-reporting. This app
// ships exact copies of the schema and its checker. This smoke proves that the
// copies still match their pin, and that every request the client can build
// passes the contract, with diagnostics present only together with consent.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const contract = require('../src/main/support-contract');
const support = require('../src/main/support-client');
const { FEEDBACK } = require('../messages');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'src', 'main', 'support-contract');
const config = { FEEDBACK_PROXY_URL: 'https://support.example.test/' };
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(16)]);
let checks = 0;
function check(condition, name) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok  ${name}`);
}

// LF line ends, so a CRLF checkout gives the same value.
function fingerprint(file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// A transport that records the request body and answers like the service.
function recordingClient(sent) {
  const transportRequest = (_url, _options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      const wire = JSON.parse(Buffer.from(body).toString('utf8'));
      sent.push(wire);
      const res = new EventEmitter();
      res.statusCode = 201;
      res.destroy = () => {};
      setImmediate(() => {
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify({ success: true, requestId: wire.requestId })));
        res.emit('end');
      });
    };
    return req;
  };
  return support.createSupportClient({ transportRequest });
}

async function run() {
  console.log('support-contract-smoke: copies match the pin');
  const pin = contract.pin;
  check(pin.source === '1132-Fixer/support-reporting' && /^[a-f0-9]{40}$/.test(pin.commit), 'the pin names the source repository and an exact commit');
  check(pin.version === 1, 'the pin states contract version 1');
  check(JSON.stringify(Object.keys(pin.files).sort()) === JSON.stringify(['feedback.v1.schema.json', 'validate.js']), 'the pin lists exactly the two copied files');
  for (const file of Object.keys(pin.files)) {
    check(fingerprint(file) === pin.files[file], `${file} is an unchanged copy`);
  }
  check(pin.schemaSha256 === pin.files['feedback.v1.schema.json'], 'the schema fingerprint is the value that the service reports at /health');
  check(contract.schema.properties.product.enum.includes(contract.PRODUCT), 'this product is in the contract product list');

  console.log('support-contract-smoke: every request passes the contract');
  const sent = [];
  const client = recordingClient(sent);
  const version = '6.5.0';
  const cases = [
    ['bug report', { type: 'Bug Report', text: 'Fix now stops before repair.' }],
    ['bug report with a screenshot', { type: 'Bug Report', text: 'See the picture.', screenshot: { bytes: PNG, mediaType: 'image/png' } }],
    ['rating', { type: 'User Rating', text: 'Works well.', rating: 5 }],
    ['other feedback', { type: 'Contact', text: 'A suggestion.' }],
    ['bug report with consented diagnostics', { type: 'Bug Report', text: 'It failed.', diagnostics: '## Support Report\n- App: 6.5.0', consentDiagnostics: true }],
  ];
  for (const [name, input] of cases) {
    const before = sent.length;
    const result = await client.submitFeedback({ config, version, ...input });
    check(result.success === true && sent.length === before + 1, `${name}: sent`);
    const wire = sent[sent.length - 1];
    const verdict = contract.validate(wire);
    check(verdict.valid, `${name}: passes the contract${verdict.valid ? '' : ' ' + JSON.stringify(verdict.errors)}`);
    check(wire.product === 'windows', `${name}: names its product`);
  }
  const withReport = sent[sent.length - 1];
  check(withReport.diagnostics.format === 'markdown' && withReport.consent.diagnostics === true, 'diagnostics travel with the consent statement');
  check(sent.slice(0, -1).every((wire) => wire.diagnostics === undefined && wire.consent === undefined), 'no diagnostics and no consent field without a choice');

  console.log('support-contract-smoke: diagnostics never leave without consent');
  const count = sent.length;
  for (const [name, input] of [
    ['consent not given', { diagnostics: 'report' }],
    ['consent false', { diagnostics: 'report', consentDiagnostics: false }],
    ['consent not a boolean', { diagnostics: 'report', consentDiagnostics: 'yes' }],
    ['blank diagnostics', { diagnostics: '  \n ', consentDiagnostics: true }],
    ['diagnostics not text', { diagnostics: { text: 'report' }, consentDiagnostics: true }],
  ]) {
    const result = await client.submitFeedback({ config, version, type: 'Bug Report', text: 'It failed.', ...input });
    check(result.success === false && result.error === FEEDBACK.REJECTED && sent.length === count, `${name}: refused and nothing sent`);
  }
  const large = await client.submitFeedback({ config, version, type: 'Bug Report', text: 'It failed.',
    diagnostics: 'x'.repeat(support.DIAGNOSTICS_MAX_BYTES + 1), consentDiagnostics: true });
  check(large.success === false && large.error === FEEDBACK.DIAGNOSTICS_TOO_LARGE && sent.length === count, 'diagnostics over the limit: refused with its own message');
  check(support.DIAGNOSTICS_MAX_BYTES === contract.schema.properties.diagnostics.properties.text['x-maxUtf8Bytes'], 'the client diagnostics limit is the contract limit');
  check(support.TEXT_MAX_BYTES === contract.schema.properties.text['x-maxUtf8Bytes'], 'the client text limit is the contract limit');

  console.log(`\nsupport-contract-smoke: ${checks} checks passed`);
}

run().catch((error) => {
  console.error('\nsupport-contract-smoke FAILED:', error && error.message);
  process.exit(1);
});
