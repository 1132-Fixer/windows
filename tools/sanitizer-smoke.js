// Exercise the production support-report handler with synthetic dependencies.
// Never load Electron or read the operator's Windows identity or clipboard.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateInvoke } = require('../src/main/electron-security');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const registration = "ipcMain.handle('support-report',";
const start = source.indexOf(registration);
const end = source.indexOf('\n});', start);
const fixture = Object.freeze({
  username: 'OperatorFixture',
  home: 'C:\\Users\\OperatorFixture',
  hostname: 'HOST-FIXTURE',
  sid: 'S-1-5-21-1234567890-987654321-1122334455-1001',
});
const receiptFields = ['camera', 'microphone', 'hkuPath', 'frameServer', 'dataClear', 'zoomRelaunch'];
const sensitive = `${fixture.home}\\Desktop ${fixture.username} ${fixture.hostname} ${fixture.sid}`;

function loadHandler(options = {}) {
  if (start < 0 || end < start || source.indexOf(registration, start + registration.length) !== -1) {
    throw new Error('production handler boundary missing or ambiguous');
  }
  const handlers = new Map();
  const identity = options.identity || fixture;
  const sandbox = {
    ipcMain: {
      handle(channel, handler) {
        if (channel !== 'support-report' || handlers.has(channel)) throw new Error('unexpected handler');
        handlers.set(channel, handler);
      },
    },
    app: { getVersion: () => '0.0.0-fixture' },
    os: {
      release: () => '10.0.fixture',
      userInfo: () => ({ username: identity.username }),
      homedir: () => identity.home,
      hostname: () => identity.hostname,
    },
    isElevatedSync: async () => options.elevated !== false,
    preflightCheck: async () => {
      if (options.preflightError) throw new Error('synthetic preflight failure');
      return {
        ok: true,
        blockers: [],
        warnings: [],
        info: { seclogon: { status: 'Running', startType: 'Manual' } },
      };
    },
    updaterCtl: options.updater || null,
    FIX_USER: 'user1',
  };
  // No require, process, filesystem, native process, network or clipboard API
  // is available to the captured handler. Changed dependencies fail closed.
  vm.runInContext(source.slice(start, end + '\n});'.length), vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  }), { filename: 'main.js:support-report', timeout: 1000 });
  if (handlers.size !== 1) throw new Error('production handler not registered');
  return handlers.get('support-report');
}

async function report(context, options) {
  const validated = validateInvoke('support-report', [context]);
  if (!validated.ok) throw new Error('synthetic context rejected');
  const result = await loadHandler(options)({}, ...validated.args);
  if (!result || result.success !== true || typeof result.markdown !== 'string') {
    throw new Error('report contract failed');
  }
  return result.markdown;
}

let passed = 0;
let failed = 0;
async function check(name, test) {
  let ok = false;
  try { ok = (await test()) === true; } catch (_) { /* Report labels only. */ }
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

async function main() {
  await check('contract.empty-context', async () => {
    const md = await report(undefined, { elevated: false });
    return md.includes('## 1132 Fixer — Support Report') &&
      md.includes('**App version:** 0.0.0-fixture') &&
      md.includes('**OS:** Windows 10.0.fixture') &&
      md.includes('**Administrator:** NO') &&
      md.includes('### Preflight summary') &&
      !md.includes('### Last fix receipt') && !md.includes('### Recent log');
  });
  await check('contract.validated-context', async () => {
    const md = await report({ stage: 'launch', receipt: { camera: 'allowed' }, logTail: 'complete' });
    return md.includes('**Last stage reached:** launch') &&
      md.includes('### Last fix receipt') && md.includes('camera:      allowed') &&
      md.includes('microphone:  not recorded') && md.includes('### Recent log') &&
      md.includes('complete');
  });
  await check('contract.invalid-context-rejected', () =>
    !validateInvoke('support-report', [{ stage: 12 }]).ok &&
    !validateInvoke('support-report', [{ logTail: [] }]).ok &&
    !validateInvoke('support-report', [{ receipt: { camera: {} } }]).ok);
  await check('resilience.preflight-failure', async () => {
    const md = await report({ logTail: 'still available' }, { preflightError: true });
    return md.includes('still available') && !md.includes('### Preflight summary') &&
      !md.includes('synthetic preflight failure');
  });
  await check('resilience.updater-diagnostics-failure', async () => {
    const md = await report({}, { updater: { diagnostics() { throw new Error('synthetic updater failure'); } } });
    return md.includes('## 1132 Fixer') && !md.includes('### Update status') &&
      !md.includes('synthetic updater failure');
  });

  const log = await report({ logTail: sensitive });
  const redactions = {
    home: text => !text.toLowerCase().includes(fixture.home.toLowerCase()),
    username: text => !text.toLowerCase().includes(fixture.username.toLowerCase()),
    hostname: text => !text.toLowerCase().includes(fixture.hostname.toLowerCase()),
    sid: text => !/S-1-5-21-\d+-\d+-\d+-\d+/.test(text),
  };
  for (const [category, redacted] of Object.entries(redactions)) {
    await check(`privacy.log.${category}`, () => redacted(log));
  }
  await check('privacy.log.redaction-markers', () =>
    log.includes('C:\\Users\\<you>') && log.includes('<host>') &&
    log.includes('S-1-5-21-XXXX-XXXX-XXXX-XXXX'));
  await check('privacy.log.case-insensitive', async () => {
    const md = await report({ logTail: sensitive.toUpperCase() });
    return Object.values(redactions).every(redacted => redacted(md));
  });
  await check('privacy.log.home-with-regex-metacharacters', async () => {
    const identity = { ...fixture, username: 'Operator.Fixture', home: 'C:\\Users\\Operator.Fixture' };
    const md = await report({ logTail: `${identity.home}\\Desktop ${identity.username}` }, { identity });
    return !md.includes(identity.home) && !md.includes(identity.username) && md.includes('<you>');
  });
  await check('integrity.helper-name-preserved', async () => {
    const md = await report({ logTail: "Account 'user1' created. Random number 12345 unchanged." });
    return md.includes("Account 'user1' created.") && md.includes('12345 unchanged');
  });
  await check('integrity.helper-operator-name-collision', async () => {
    const identity = { ...fixture, username: 'user1', home: 'C:\\Users\\user1' };
    const md = await report({ logTail: `Account 'user1' created. Home: ${identity.home}` }, { identity });
    return md.includes("Account 'user1' created.") && !md.includes(identity.home);
  });
  await check('bounds.log-last-80-lines', async () => {
    const logTail = Array.from({ length: 90 }, (_, i) => `fixture-line-${String(i).padStart(3, '0')}`).join('\n');
    const md = await report({ logTail });
    return !md.includes('fixture-line-009') && md.includes('fixture-line-010') &&
      md.includes('fixture-line-089') && (md.match(/fixture-line-\d{3}/g) || []).length === 80;
  });
  await check('privacy.updater-recent-lines', async () => {
    const md = await report({}, { updater: { diagnostics: () => ({
      state: 'idle', current: '0.0.0-fixture', channel: 'stable',
      executionMode: 'fixture', attempts: 0, recent: [sensitive],
    }) } });
    return md.includes('### Update status') && Object.values(redactions).every(redacted => redacted(md));
  });
  await check('bounds.updater-last-12-lines', async () => {
    const md = await report({}, { updater: { diagnostics: () => ({
      state: 'idle', current: '0.0.0-fixture', channel: 'stable', executionMode: 'fixture', attempts: 0,
      recent: Array.from({ length: 20 }, (_, i) => `update-line-${String(i).padStart(3, '0')}`),
    }) } });
    return !md.includes('update-line-007') && md.includes('update-line-008') &&
      md.includes('update-line-019') && (md.match(/update-line-\d{3}/g) || []).length === 12;
  });

  // These contexts pass the production IPC validator. Every displayed field
  // must obey the same privacy contract as the log, without hiding failures.
  const stage = await report({ stage: sensitive });
  for (const [category, redacted] of Object.entries(redactions)) {
    await check(`privacy.stage.${category}`, () => redacted(stage));
  }
  for (const field of receiptFields) {
    const md = await report({ receipt: { [field]: sensitive } });
    for (const [category, redacted] of Object.entries(redactions)) {
      await check(`privacy.receipt.${field}.${category}`, () => redacted(md));
    }
  }
  // Exercise the real handler with Unicode identities and literal usernames.
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
    await check('privacy.username.' + example.name, async () => {
      const identity = { ...fixture, username: example.username, home: 'C:\\Users\\UnicodeFixture' };
      const md = await report({ logTail: example.text }, { identity });
      return md.endsWith(['```', example.expected, '```'].join('\n'));
    });
  }
  await check('privacy.username.cjk-assembled-report', async () => {
    const identity = { ...fixture, username: '操作员', home: 'C:\\Users\\UnicodeFixture' };
    const md = await report({
      stage: identity.username, receipt: { hkuPath: identity.username }, logTail: identity.username,
    }, { identity });
    return !md.includes(identity.username) && md.includes('**Last stage reached:** <you>') &&
      md.includes('hkuPath:     <you>') && md.endsWith(['```', '<you>', '```'].join('\n'));
  });
  console.log(`sanitizer-smoke: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(() => {
  console.log('FAIL harness.production-handler-execution');
  process.exitCode = 1;
});
