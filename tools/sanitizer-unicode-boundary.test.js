// Unicode username boundary regression for the support-report sanitizer
// (governance#656). Runs the production handler through the smoke harness
// with synthetic identities only. Run: node --test tools/sanitizer-unicode-boundary.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, report } = require('./sanitizer-smoke');

const home = 'C:\\Users\\UnicodeFixture';
const fence = (expected) => ['```', expected, '```'].join('\n');

const usernameCases = [
  { name: 'bare-cjk', username: '操作员', text: '操作员', expected: '<you>' },
  { name: 'bare-cyrillic', username: 'оператор', text: 'оператор', expected: '<you>' },
  { name: 'uppercase-cyrillic', username: 'оператор', text: 'ОПЕРАТОР', expected: '<you>' },
  { name: 'combining-mark', username: 'Cafe\u0301', text: 'Cafe\u0301', expected: '<you>' },
  { name: 'regex-literal', username: 'ops.name+qa', text: 'ops.name+qa', expected: '<you>' },
  { name: 'punctuation-delimiters', username: 'оператор', text: '(оператор), /оператор/; "оператор"', expected: '(<you>), /<you>/; "<you>"' },
  { name: 'adjoining-letter-left', username: 'operator', text: '前operator', expected: '前operator' },
  { name: 'adjoining-letter-right', username: 'operator', text: 'operator後', expected: 'operator後' },
  { name: 'adjoining-number-left', username: 'operator', text: '\u0661operator', expected: '\u0661operator' },
  { name: 'adjoining-number-right', username: 'operator', text: 'operator\u0662', expected: 'operator\u0662' },
  { name: 'adjoining-mark-left', username: 'operator', text: '\u0301operator', expected: '\u0301operator' },
  { name: 'adjoining-mark-right', username: 'operator', text: 'operator\u0301', expected: 'operator\u0301' },
  { name: 'adjoining-underscore-left', username: 'operator', text: '_operator', expected: '_operator' },
  { name: 'adjoining-underscore-right', username: 'operator', text: 'operator_', expected: 'operator_' },
  { name: 'regex-literal-near-match', username: 'ops.name+qa', text: 'opsXnameeeqa', expected: 'opsXnameeeqa' },
  { name: 'regex-literal-word-adjoining', username: 'ops.name+qa', text: '前ops.name+qa後', expected: '前ops.name+qa後' },
];

for (const example of usernameCases) {
  test(`privacy.username.${example.name}`, async () => {
    const identity = { ...fixture, username: example.username, home };
    const md = await report({ logTail: example.text }, { identity });
    assert.ok(md.endsWith(fence(example.expected)), `log tail ended with: ${JSON.stringify(md.slice(-40))}`);
  });
}

test('privacy.username.cjk-assembled-report', async () => {
  const identity = { ...fixture, username: '操作员', home };
  const md = await report({
    stage: identity.username, receipt: { hkuPath: identity.username }, logTail: identity.username,
  }, { identity });
  assert.ok(!md.includes(identity.username), 'username leaked into the assembled report');
  assert.ok(md.includes('**Last stage reached:** <you>'));
  assert.ok(md.includes('hkuPath:     <you>'));
  assert.ok(md.endsWith(fence('<you>')));
});
