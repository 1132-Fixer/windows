#!/usr/bin/env node
'use strict';

// Exercise the real desktop client against an ephemeral HTTP upstream behind
// an injected HTTPS transport. Production URL validation remains HTTPS-only.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawnSync } = require('child_process');
const support = require('../src/main/support-client');
const { FEEDBACK } = require('../messages');
const root = path.resolve(__dirname, '..');
const config = { FEEDBACK_PROXY_URL: 'https://support.example.test/' };
let checks = 0;
function check(condition, name) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok  ${name}`);
}

async function run() {
  console.log('support-submission-smoke: endpoint trust boundary');
  for (const endpoint of [
    '', 'ghp_secret_do_not_print', 'http://localhost:8080/', 'http://support.example.test/',
    'https://user:password@support.example.test/', 'https://support.example.test/?token=private',
    'https://support.example.test/#private', 'https://support.example.test/?',
    'https://support.example.test/#', 'https://support.example.test/v1/principals',
    'https://support.example.test/private/path', 'https://support.example.test/ white',
  ]) check(support.endpointUrl(endpoint) === null, `rejects unsafe endpoint ${endpoint ? endpoint.split(':')[0] : 'unset'}`);
  check(support.endpointUrl(config.FEEDBACK_PROXY_URL).pathname === '/v1/feedback', 'one public submission route');

  const calls = [];
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (mode === 'drop') return req.socket.destroy();
      if (mode === 'timeout') return;
      if (mode === 'oversized') { res.writeHead(201); return res.end('x'.repeat(20000)); }
      if (mode === 'malformed') { res.writeHead(201); return res.end('{broken'); }
      if (mode === 'unavailable') { res.writeHead(503); return res.end(JSON.stringify({ error: { message: 'secret server diagnostic' } })); }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, requestId: mode === 'wrong-id' ? 'wrong' : body.requestId }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const transportRequest = (url, options, callback) => {
    assert.equal(url.protocol, 'https:');
    return http.request({ ...options, hostname: '127.0.0.1', port: address.port, path: url.pathname }, callback);
  };
  const client = support.createSupportClient({ transportRequest, timeoutMs: 100 });
  const submit = (opts = {}) => client.submitFeedback({ config, type: 'Contact', text: 'Please help with this repair.', version: '6.4.1', ...opts });

  try {
    check(client.capabilities(config).screenshots, 'configured feature gate is local');
    check(!client.capabilities({}).screenshots && calls.length === 0, 'unset configuration and capabilities send no network traffic');
    for (const type of ['Bug Report', 'User Rating', 'Contact']) {
      const count = calls.length;
      const result = await submit({ type, ...(type === 'User Rating' ? { rating: 4 } : {}) });
      check(result.success === true && calls.length === count + 1, `${type} uses one user-triggered request`);
      const call = calls.at(-1);
      check(call.method === 'POST' && call.path === '/v1/feedback', `${type} uses the same service route`);
      check(call.headers['idempotency-key'] === call.body.requestId && /^[0-9a-f-]{36}$/.test(call.body.requestId), `${type} has a temporary request ID`);
      check(!call.headers.authorization && Object.keys(call.body).sort().join(',') === (type === 'User Rating' ? 'rating,requestId,text,type,version' : 'requestId,text,type,version'), `${type} sends no credential or automatic device inventory`);
    }

    const image = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
    check((await submit({ type: 'Bug Report', screenshot: { bytes: image, mediaType: 'image/png' } })).success, 'screenshot stays in the same outbound request');
    check(Buffer.from(calls.at(-1).body.screenshot.data, 'base64').equals(image), 'complete screenshot bytes reach the service');
    for (const [mediaType, bytes] of [
      ['image/jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12)])],
      ['image/gif', Buffer.from('GIF89a123456789')],
      ['image/webp', Buffer.from('RIFF1234WEBP1234')],
    ]) check((await submit({ type: 'Bug Report', screenshot: { bytes, mediaType } })).success, `${mediaType} is supported`);
    const longText = 'Full sanitized report line.\n'.repeat(500);
    check((await submit({ text: longText })).success && calls.at(-1).body.text === longText, 'reports above the old 4000-character limit are complete');

    const countBeforeInvalid = calls.length;
    for (const opts of [
      { text: 'é'.repeat(60 * 1024) }, { text: 'x'.repeat(support.TEXT_MAX_BYTES + 1) },
      { type: 'User Rating' }, { type: 'User Rating', rating: 0 }, { type: 'User Rating', rating: 2.5 },
      { type: 'Contact', rating: 5 }, { type: 'Unknown' }, { config: {} },
      { screenshot: { bytes: image, mediaType: 'image/jpeg' } },
      { screenshot: { bytes: Buffer.alloc(support.SCREENSHOT_MAX_BYTES + 1), mediaType: 'image/png' } },
    ]) check(!(await submit(opts)).success, 'invalid content fails locally');
    check(calls.length === countBeforeInvalid, 'invalid content sends no request');

    for (const responseMode of ['wrong-id', 'malformed', 'unavailable', 'oversized', 'drop', 'timeout']) {
      mode = responseMode;
      const count = calls.length;
      const result = await submit({ text: `Failure case ${responseMode}` });
      check(!result.success && result.error && !result.error.includes('secret server diagnostic'), `${responseMode} never claims Sent or exposes server text`);
      check(calls.length === count + 1, `${responseMode} has no automatic retry`);
    }
    mode = 'unavailable';
    await submit({ text: 'Same report after an ambiguous request.' });
    const failedId = calls.at(-1).body.requestId;
    mode = 'ok';
    await submit({ text: 'Same report after an ambiguous request.' });
    check(calls.at(-1).body.requestId === failedId, 'explicit unchanged retry reuses temporary request ID');
    await submit({ text: 'Same report after an ambiguous request.' });
    check(calls.at(-1).body.requestId !== failedId, 'successful submission clears temporary retry ID');
    mode = 'unavailable';
    await submit({ text: 'Before edit' });
    const beforeEdit = calls.at(-1).body.requestId;
    await submit({ text: 'After edit' });
    check(calls.at(-1).body.requestId !== beforeEdit, 'edited content starts a new submission');
    mode = 'timeout';
    const pending = submit({ text: 'In-flight report' });
    const duplicate = await submit({ text: 'In-flight report' });
    check(!duplicate.success && duplicate.error === FEEDBACK.BUSY, 'double submission is bounded in the main process');
    await pending;

    console.log('support-submission-smoke: renderer acknowledgement and draft preservation');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const fnStart = renderer.indexOf('async function submitFeedback(');
    const fnEnd = renderer.indexOf('// ============================================================\n// Support Report modal', fnStart);
    const elements = Object.fromEntries(['fbBugStatus', 'fbRatingStatus', 'fbContactStatus', 'fbBugSubmit', 'fbRatingSubmit', 'fbContactSubmit', 'fbBugText', 'fbContactText'].map(id => [id, { disabled: false, textContent: '', className: '', value: 'Draft remains here' }]));
    for (const id of ['fbBugSubmit', 'fbRatingSubmit', 'fbContactSubmit']) {
      elements[id].closest = () => ({ querySelectorAll: () => [elements.fbBugText] });
    }
    const closeTimers = [];
    const context = {
      FEEDBACK, FEEDBACK_FALLBACK: FEEDBACK.FAILED, FEEDBACK_NETWORK: FEEDBACK.NETWORK,
      FEEDBACK_TEXT_MAX_BYTES: support.TEXT_MAX_BYTES, TextEncoder, feedbackGen: 1,
      feedbackSending: new Set(),
      feedbackEditorLocks: new WeakMap(),
      SUBMIT_BTN_FOR_STATUS: { fbBugStatus: 'fbBugSubmit', fbRatingStatus: 'fbRatingSubmit', fbContactStatus: 'fbContactSubmit' },
      document: { getElementById: id => elements[id] },
      window: { electronAPI: { submitFeedback: (type, text, screenshot, rating) => submit({ type, text, screenshot, rating }) } },
      setTimeout: callback => { closeTimers.push(callback); return 1; }, closeFeedback() {}, refreshBugSubmit() {},
    };
    vm.createContext(context);
    vm.runInContext(renderer.slice(fnStart, fnEnd), context);
    mode = 'ok';
    await context.submitFeedback('Bug Report', 'Draft remains here', 'fbBugStatus');
    check(elements.fbBugStatus.textContent === 'Sent', 'successful HTTP acknowledgement shows exactly Sent');
    check(elements.fbBugText.disabled, 'submitted draft stays stable until the acknowledgement closes');
    closeTimers.shift()();
    check(!elements.fbBugText.disabled, 'form editors unlock after Sent closes');
    mode = 'unavailable';
    await context.submitFeedback('Contact', 'Draft remains here', 'fbContactStatus');
    check(elements.fbContactStatus.className === 'fb-status err' && elements.fbContactSubmit.disabled === false && elements.fbBugText.value === 'Draft remains here', 'failed acknowledgement preserves draft and explicit retry');
    const beforeOversize = calls.length;
    await context.submitFeedback('Contact', 'é'.repeat(60 * 1024), 'fbContactStatus');
    check(calls.length === beforeOversize && elements.fbContactStatus.textContent === FEEDBACK.TEXT_TOO_LARGE, 'renderer rejects oversize text visibly without truncation');
    mode = 'timeout';
    const olderForm = context.submitFeedback('Contact', 'Older pending draft', 'fbContactStatus');
    context.feedbackGen = 2;
    elements.fbContactText.value = 'New draft after reopening the feedback dialog. Please keep this text.';
    elements.fbContactStatus.textContent = '';
    await olderForm;
    check(elements.fbContactStatus.textContent === '' && !elements.fbContactSubmit.disabled && elements.fbContactText.value.startsWith('New draft'), 'an older request cannot change or leave a reopened draft locked');

    console.log('support-submission-smoke: Back invalidates the submitted form instance');
    const sectionStart = renderer.indexOf('function showSection(');
    const sectionEnd = renderer.indexOf('function openFeedback(', sectionStart);
    check(sectionStart >= 0 && sectionEnd > sectionStart && renderer.includes("addEventListener('click', returnToFeedbackChooser)"),
      'every feedback Back control uses the production generation invalidator');
    for (const targetId of ['fbContact', 'fbRating']) {
      const classSet = initial => {
        const values = new Set(initial);
        return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) };
      };
      const sections = Object.fromEntries(['fbChoose', 'fbBug', 'fbContact', 'fbRating']
        .map(id => [id, { classList: classSet(id === 'fbBug' ? ['active'] : []) }]));
      const bugEditor = { id: 'fbBugText', disabled: false };
      const bugSubmit = {
        disabled: false,
        closest: () => ({ querySelectorAll: () => [bugEditor] })
      };
      const status = { textContent: '', className: '' };
      const localElements = {
        ...sections,
        fbBugStatus: status,
        fbBugSubmit: bugSubmit,
        fbContactText: { value: 'A different contact form draft with enough text to submit.' },
        fbContactSubmit: { disabled: false },
        fbRatingSubmit: { disabled: false }
      };
      let resolveSubmission;
      let closeCalls = 0;
      const staleTimers = [];
      const formContext = {
        FEEDBACK, FEEDBACK_FALLBACK: FEEDBACK.FAILED, FEEDBACK_NETWORK: FEEDBACK.NETWORK,
        FEEDBACK_TEXT_MAX_BYTES: support.TEXT_MAX_BYTES, TextEncoder, feedbackGen: 1, feedbackMode: 'bug',
        feedbackSending: new Set(), feedbackEditorLocks: new WeakMap(), ratings: { overall: 5 },
        SUBMIT_BTN_FOR_STATUS: { fbBugStatus: 'fbBugSubmit' },
        document: {
          getElementById: id => localElements[id],
          querySelectorAll: selector => selector === '.fb-section' ? Object.values(sections) : []
        },
        window: { electronAPI: { submitFeedback: () => new Promise(resolve => { resolveSubmission = resolve; }) } },
        setTimeout: callback => { staleTimers.push(callback); return staleTimers.length; },
        closeFeedback: () => { closeCalls++; },
        refreshBugSubmit: () => { bugSubmit.disabled = false; }
      };
      vm.createContext(formContext);
      vm.runInContext([
        renderer.slice(sectionStart, sectionEnd),
        renderer.slice(fnStart, fnEnd)
      ].join('\n'), formContext);
      const pendingBug = formContext.submitFeedback('Bug Report', 'Pending bug report', 'fbBugStatus');
      await Promise.resolve();
      formContext.returnToFeedbackChooser();
      formContext.showSection(targetId);
      resolveSubmission({ success: true });
      await pendingBug;
      check(sections[targetId].classList.contains('active') && !sections.fbBug.classList.contains('active') &&
        status.textContent !== FEEDBACK.SENT && closeCalls === 0 && staleTimers.length === 0,
      `Bug acknowledgement cannot overwrite or close the ${targetId === 'fbContact' ? 'Contact' : 'Rating'} form after Back`);
      check(formContext.feedbackGen === 2 && !bugEditor.disabled && !bugSubmit.disabled,
        `stale Bug completion releases only its own controls after switching to ${targetId === 'fbContact' ? 'Contact' : 'Rating'}`);
    }

    // Run the real radio-group handlers without reproducing their selection
    // rules in the test. Check screen-reader state and keyboard interaction.
    const radioContext = { ratings: { overall: 0 }, feedbackSending: new Set(), FEEDBACK };
    const radioButtons = Array.from({ length: 5 }, (_, index) => ({
      dataset: { val: String(index + 1) }, attrs: {}, listeners: {}, disabled: false,
      classList: { add() {}, remove() {} },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(key, listener) { this.listeners[key] = listener; },
      click() { if (!this.disabled) this.listeners.click(); },
      focus() { radioContext.document.activeElement = this; },
    }));
    const group = {
      dataset: { cat: 'overall' }, attrs: {}, listeners: {},
      querySelectorAll: () => radioButtons,
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(key, listener) { this.listeners[key] = listener; },
    };
    radioContext.document = {
      querySelectorAll: () => [group],
      getElementById: id => elements[id],
      activeElement: radioButtons[0],
    };
    const radioStart = renderer.indexOf("document.querySelectorAll('.fb-rating-btns').forEach(group => {\n  const cat");
    const radioEnd = renderer.indexOf("document.getElementById('fbBugText').addEventListener", radioStart);
    vm.createContext(radioContext);
    vm.runInContext(renderer.slice(radioStart, radioEnd), radioContext);
    check(group.attrs['aria-required'] === 'true' && radioButtons.every(button => button.attrs.role === 'radio' && button.attrs['aria-checked'] === 'false'), 'Overall rating exposes required radio semantics');
    check(radioButtons.filter(button => button.tabIndex === 0).length === 1, 'rating group has one keyboard tab stop');
    const key = value => group.listeners.keydown({ key: value, preventDefault() {} });
    key('ArrowRight');
    check(radioContext.ratings.overall === 2 && radioButtons[1].attrs['aria-checked'] === 'true' && !elements.fbRatingSubmit.disabled, 'arrow key selects and announces a concrete score');
    key('End');
    check(radioContext.ratings.overall === 5, 'End selects the highest rating');
    key('Home');
    check(radioContext.ratings.overall === 1, 'Home selects the lowest rating');
    key('ArrowLeft');
    check(radioContext.ratings.overall === 5, 'rating arrow keys wrap within the group');
    radioButtons[0].disabled = true;
    key('Home');
    check(radioContext.ratings.overall === 5, 'disabled sending state prevents rating changes');

    const source = fs.readFileSync(path.join(root, 'src/main/support-client.js'), 'utf8');
    check(!/require\(['"](?:fs|path|http)['"]\)|safeStorage|principals|\/v1\/cases|Authorization|writeFile|readFile|caseRef/.test(source), 'desktop adapter has no credentials, principal storage, plaintext fallback or case API');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const submitRegion = main.slice(main.indexOf("ipcMain.handle('submit-feedback'"), main.indexOf('// IPC: preflight-scan'));
    check(!/os\.release|userData|safeStorage|https\.request|\/feedback['"]/.test(submitRegion), 'main delegates all support forms without automatic environment data');
    check(!renderer.includes('4,000-character limit') && !renderer.includes('RATING_DATA:'), 'legacy truncation and hidden rating metadata are removed');
    check(FEEDBACK.SENT === 'Sent' && /ratings\.overall === 0/.test(renderer), 'rating requires the explicit Overall choice');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }

  console.log('support-submission-smoke: build injection secret rejection');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-public-config-'));
  try {
    for (const relative of ['scripts/inject-config.js', 'src/main/support-client.js', 'messages.js']) {
      const target = path.join(temp, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, relative), target);
    }
    for (const value of ['ghp_secret_canary', 'https://private-user:private-secret@support.example.test/', 'https://support.example.test/?token=private-secret']) {
      const result = spawnSync(process.execPath, [path.join(temp, 'scripts/inject-config.js')], { env: { ...process.env, FEEDBACK_PROXY_URL: value }, encoding: 'utf8' });
      check(result.status === 1 && !`${result.stdout}${result.stderr}`.includes(value) && !`${result.stdout}${result.stderr}`.includes('private-secret'), 'invalid configuration is refused without logging credential input');
      check(!fs.existsSync(path.join(temp, 'src/main/config.generated.js')), 'rejected configuration never enters a build file');
    }
    const valid = spawnSync(process.execPath, [path.join(temp, 'scripts/inject-config.js')], { env: { ...process.env, FEEDBACK_PROXY_URL: config.FEEDBACK_PROXY_URL, DISCORD_BOT_TOKEN: 'private-canary' }, encoding: 'utf8' });
    const output = fs.readFileSync(path.join(temp, 'src/main/config.generated.js'), 'utf8');
    check(valid.status === 0 && output.includes('/v1/feedback') && !output.includes('private-canary'), 'only validated public endpoint enters client configuration');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`support-submission-smoke: ${checks} checks passed`);
}

run().catch(err => { console.error(err); process.exitCode = 1; });
