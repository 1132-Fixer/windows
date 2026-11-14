'use strict';

// Exercise real renderer functions and event registrations with inert DOM,
// deferred IPC and manual timers. No browser, Electron, socket, app or native
// process is launched. This is behavioural source evidence, not visual QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');
const messages = require('../messages');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const knownIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const FEEDBACK = messages.FEEDBACK;
const tests = [];
const liveHarnesses = [];
const textDraft = 'Synthetic user-chosen report text, kept complete during every request.';
// Canonical relay header minima. These fixtures prove header/MIME agreement,
// not complete image decoding or rendered image quality.
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13,
  73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const imageHeaders = [
  { name: 'PNG', mediaType: 'image/png', bytes: png, truncatedLengths: [0, 8, 16, 23] },
  { name: 'JPEG', mediaType: 'image/jpeg', bytes: new Uint8Array([255, 216, 255, 0]), truncatedLengths: [0, 3] },
  { name: 'GIF', mediaType: 'image/gif', bytes: new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0]), truncatedLengths: [0, 6, 12] },
  { name: 'WebP', mediaType: 'image/webp', bytes: new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]), truncatedLengths: [0, 12, 15] }
];
let suiteFinished = false;
process.once('beforeExit', () => {
  if (!suiteFinished) {
    console.error('FAIL feedback-renderer: async suite exited before completion');
    process.exitCode = 1;
  }
});

function region(start, end) {
  const begin = renderer.indexOf(start);
  const finish = renderer.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, 'actual feedback source boundaries must exist');
  return renderer.slice(begin, finish);
}
const intro = region('const ratings = ', '// Explore modal');
const controls = region("['fbClose', 'fbBugCancel', 'fbRatingCancel', 'fbContactCancel'].forEach", '// Support Report modal');

class Element {
  constructor(id, document) {
    this.id = id; this.document = document; this.listeners = new Map();
    this.value = ''; this.textContent = ''; this.className = ''; this.disabled = false;
    this.hidden = false; this.dataset = {}; this.attributes = {}; this.children = [];
    const change = (op, names) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) op === 'add' ? values.add(name) : values.delete(name);
      this.className = [...values].join(' ');
    };
    this.classList = {
      add: (...names) => change('add', names), remove: (...names) => change('remove', names),
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const has = this.classList.contains(name);
        const on = force === undefined ? !has : Boolean(force);
        change(on ? 'add' : 'remove', [name]); return on;
      }
    };
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler); this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== handler));
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  querySelectorAll(selector) { return selector === '.fb-rating-btn' ? this.children : []; }
  focus() { this.document.activeElement = this; }
  click() { if (!this.disabled) return this.fire('click'); }
  dispatchEvent(event) { this.fire(event.type, event); return true; }
  fire(type, details = {}) {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...details };
    return Promise.all((this.listeners.get(type) || []).map(handler => handler(event)));
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject, settled: false };
}
function createHarness({ reply, report, reportDeferred = false } = {}) {
  const elements = new Map();
  const document = {
    listeners: new Map(), activeElement: null,
    getElementById(id) {
      assert.ok(knownIds.has(id), 'renderer references an existing HTML element: ' + id);
      if (!elements.has(id)) elements.set(id, new Element(id, document));
      return elements.get(id);
    },
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler); this.listeners.set(type, handlers);
    },
    querySelectorAll(selector) {
      if (selector === '.fb-section') return ['fbChoose', 'fbBug', 'fbRating', 'fbContact'].map(id => this.getElementById(id));
      if (selector === '.fb-choice') return choices;
      if (selector === '.fb-rating-btns') return groups;
      if (selector === '.fb-rating-btn') return groups.flatMap(group => group.children);
      if (selector === '.fb-textarea') return ['fbBugText', 'fbRatingText', 'fbContactText'].map(id => this.getElementById(id));
      return [];
    }
  };
  document.body = new Element('body', document);
  document.activeElement = document.body;
  const choices = ['bug', 'rating', 'contact'].map(mode => {
    const element = new Element('choice-' + mode, document); element.dataset.mode = mode; return element;
  });
  const groups = ['ease', 'resolved', 'recommend', 'overall'].map(cat => {
    const element = new Element('rating-' + cat, document); element.dataset.cat = cat;
    element.children = [1, 2, 3, 4, 5].map(value => {
      const button = new Element(cat + '-' + value, document); button.dataset.val = String(value); return button;
    });
    return element;
  });
  const calls = [], pending = [], reports = [], timers = new Map();
  let nextTimer = 1, nextUrl = 1, releases = 0;
  const context = vm.createContext({
    document, TextEncoder, Uint8Array, ArrayBuffer, Blob,
    URL: { createObjectURL: () => 'blob:synthetic-' + nextUrl++, revokeObjectURL() {} },
    Event: class { constructor(type) { this.type = type; } },
    FEEDBACK, FEEDBACK_FALLBACK: messages.FEEDBACK_FALLBACK, FEEDBACK_NETWORK: messages.FEEDBACK_NETWORK,
    lastReceipt: { synthetic: 'redacted' }, logBuffer: ['synthetic redacted line'], lastStageLabel: 'Synthetic stage',
    installFocusTrap: () => () => { releases++; }, openSupportReport() {},
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: { electronAPI: {
      submitFeedback(...args) {
        calls.push(args);
        if (reply !== undefined) return Promise.resolve(reply);
        const item = deferred(); pending.push(item); return item.promise;
      },
      feedbackCapabilities: async () => ({ configured: true, screenshots: true, readiness: 'not-checked' }),
      getSystemInfo: async () => ({ version: '6.4.0', os: 'Synthetic OS', admin: null }),
      supportReport() {
        if (!reportDeferred) return Promise.resolve({ markdown: report === undefined ? 'Synthetic sanitized report.' : report });
        const item = deferred(); reports.push(item); return item.promise;
      }
    } }
  });
  vm.runInContext(intro + '\n' + controls, context, { filename: 'actual-feedback-renderer.js' });
  const run = source => vm.runInContext(source, context);
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const settle = (item, value, reject = false) => {
    assert.ok(item && !item.settled, 'one pending synthetic IPC result exists');
    item.settled = true; reject ? item.reject(value) : item.resolve(value);
  };
  const h = {
    document, calls, pending, reports, timers, run, flush,
    element: id => document.getElementById(id),
    fire: (id, type = 'click', details) => document.getElementById(id).fire(type, details),
    choose: async mode => { await choices.find(choice => choice.dataset.mode === mode).fire('click'); },
    rate: async (cat, value) => { await groups.find(group => group.dataset.cat === cat).children[value - 1].fire('click'); },
    setText: async (id, value) => { const element = document.getElementById(id); element.value = value; await element.fire('input'); },
    open: async () => { run('openFeedback()'); await flush(); },
    settle: (value, index = 0, reject = false) => settle(pending[index], value, reject),
    settleReport: (markdown, index = 0) => settle(reports[index], { markdown }),
    async selectScreenshot(bytes = png, name = 'synthetic.png', mediaType = 'image/png') {
      context.syntheticFile = { size: bytes.byteLength, type: mediaType, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      try { await run('setScreenshot(syntheticFile, ' + JSON.stringify(name) + ')'); }
      finally { delete context.syntheticFile; }
    },
    async screenshot(bytes = png, name = 'synthetic.png', mediaType = 'image/png') {
      await h.selectScreenshot(bytes, name, mediaType);
      assert.ok(run('bugScreenshot'), 'synthetic screenshot passes the actual renderer header gate');
    },
    async runTimers() {
      const current = [...timers.values()]; timers.clear();
      for (const item of current) item.fn();
      await flush();
    },
    get releases() { return releases; },
    async dispose() {
      for (const item of pending) if (!item.settled) settle(item, { success: false, delivery: 'unknown', error: 'Synthetic cleanup' });
      for (const item of reports) if (!item.settled) settle(item, { markdown: 'Synthetic cleanup report.' });
      timers.clear(); await flush();
    }
  };
  liveHarnesses.push(h);
  return h;
}
function test(name, fn) { tests.push({ name, fn }); }
function assertNotSent(h, statusId) {
  assert.notEqual(h.element(statusId).textContent, FEEDBACK.SUBMITTED);
  assert.ok(!h.element(statusId).classList.contains('ok'));
}
function assertDraftChanged(h, statusId) {
  assert.equal(typeof FEEDBACK.DRAFT_CHANGED, 'string', 'draft changes have explicit catalogue copy');
  assert.ok(FEEDBACK.DRAFT_CHANGED.length > 0, 'draft-change copy is not an empty placeholder');
  assert.equal(h.element(statusId).textContent, FEEDBACK.DRAFT_CHANGED);
  assertNotSent(h, statusId);
  assert.notEqual(h.element(statusId).textContent, FEEDBACK.SUBMITTING);
  assert.notEqual(h.element(statusId).textContent, FEEDBACK.SUBMITTING_IMAGE);
}

test('all three real form handlers carry the correct type, screenshot and fourth Overall argument', async () => {
  const h = createHarness({ reply: { success: true, delivery: 'acknowledged' } });
  await h.open(); await h.choose('bug');
  await h.setText('fbBugText', textDraft); await h.screenshot();
  await h.fire('fbBugSubmit');
  assert.equal(h.calls[0][0], 'Bug Report');
  assert.equal(h.calls[0][1], textDraft);
  assert.deepEqual(Array.from(h.calls[0][2].bytes), Array.from(png));
  assert.equal(h.calls[0][3], undefined);
  await h.fire('fbBugBack'); await h.choose('rating');
  await h.rate('overall', 4); await h.setText('fbRatingText', 'Synthetic optional rating comment.');
  await h.fire('fbRatingSubmit');
  assert.equal(h.calls[1][0], 'User Rating');
  assert.equal(h.calls[1][2], undefined);
  assert.equal(h.calls[1][3], 4);
  await h.fire('fbRatingBack'); await h.choose('contact');
  await h.setText('fbContactText', textDraft); await h.fire('fbContactSubmit');
  assert.equal(h.calls[2][0], 'Contact');
  assert.equal(h.calls[2][1], textDraft);
  assert.equal(h.calls[2][2], undefined);
  assert.equal(h.calls[2][3], undefined);
  assert.equal(h.calls.length, 3);
});
test('other survey scores cannot substitute for missing Overall', async () => {
  const h = createHarness(); await h.open(); await h.choose('rating'); await h.rate('ease', 5);
  assert.equal(h.element('fbRatingSubmit').disabled, true);
  await h.fire('fbRatingSubmit');
  assert.equal(h.calls.length, 0);
  assert.equal(h.element('fbRatingStatus').textContent, FEEDBACK.RATING_REQUIRED);
});
test('UTF-8 bytes cap submission without truncating an exactly fitting report', async () => {
  const h = createHarness({ reply: { success: true, delivery: 'acknowledged' } });
  await h.open(); await h.choose('bug');
  await h.setText('fbBugText', 'é'.repeat(50 * 1024 + 1)); await h.fire('fbBugSubmit');
  assert.equal(h.calls.length, 0);
  assert.equal(h.element('fbBugStatus').textContent, FEEDBACK.TEXT_TOO_LARGE);
  const exact = 'é'.repeat(50 * 1024);
  await h.setText('fbBugText', exact); await h.fire('fbBugSubmit');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1], exact);
});
test('failed or unknown delivery preserves every draft, rating and screenshot on close/reopen', async () => {
  const h = createHarness({ reply: { success: false, delivery: 'unknown', error: FEEDBACK.SEND_UNKNOWN } });
  await h.open(); await h.choose('bug'); await h.setText('fbBugText', textDraft);
  await h.setText('fbContactText', 'Second ' + textDraft); await h.setText('fbRatingText', 'Optional rating draft.');
  await h.rate('overall', 3); await h.screenshot();
  const shot = h.run('bugScreenshot');
  const preview = h.element('fbShotImg').src;
  await h.fire('fbBugSubmit'); assertNotSent(h, 'fbBugStatus');
  await h.fire('fbBugCancel'); await h.open();
  assert.equal(h.element('fbBugText').value, textDraft);
  assert.equal(h.element('fbContactText').value, 'Second ' + textDraft);
  assert.equal(h.element('fbRatingText').value, 'Optional rating draft.');
  assert.equal(h.run('ratings.overall'), 3);
  assert.equal(h.run('bugScreenshot'), shot);
  assert.equal(h.element('fbShotImg').src, preview);
  assert.equal(h.element('fbShotPreview').hidden, false);
});
test('input refresh and forced duplicate click cannot bypass the per-form in-flight guard', async () => {
  const h = createHarness(); await h.open(); await h.choose('bug'); await h.setText('fbBugText', textDraft);
  const pending = h.fire('fbBugSubmit');
  assert.equal(h.calls.length, 1);
  await h.setText('fbBugText', 'Edited ' + textDraft);
  assert.equal(h.element('fbBugSubmit').disabled, true);
  await h.fire('fbBugSubmit');
  assert.equal(h.calls.length, 1);
  h.settle({ success: false, delivery: 'unknown', error: FEEDBACK.SEND_UNKNOWN }); await pending;
  assert.equal(h.element('fbBugText').value, 'Edited ' + textDraft);
  assert.equal(h.element('fbBugSubmit').disabled, false);
});
for (const change of ['draft', 'screenshot', 'back', 'reopen', 'rating']) {
  test('stale ' + change + ' completion cannot mark Sent or close the current form', async () => {
    const h = createHarness(); await h.open();
    const rating = change === 'rating';
    await h.choose(rating ? 'rating' : 'bug');
    if (rating) { await h.rate('overall', 3); await h.setText('fbRatingText', textDraft); }
    else await h.setText('fbBugText', textDraft);
    const statusId = rating ? 'fbRatingStatus' : 'fbBugStatus';
    const pending = h.fire(rating ? 'fbRatingSubmit' : 'fbBugSubmit');
    if (change === 'draft') await h.setText('fbBugText', 'New ' + textDraft);
    if (change === 'screenshot') await h.screenshot();
    if (change === 'back') { await h.fire('fbBugBack'); await h.choose('contact'); await h.setText('fbContactText', 'New ' + textDraft); }
    if (change === 'reopen') { await h.fire('fbBugCancel'); await h.open(); await h.choose('bug'); }
    if (change === 'rating') await h.rate('overall', 5);
    const releaseCount = h.releases;
    h.settle({ success: true, delivery: 'acknowledged' }); await pending; await h.runTimers();
    assertNotSent(h, statusId);
    assert.ok(h.element('fbOverlay').classList.contains('show'));
    assert.equal(h.releases, releaseCount);
    if (change === 'back') assert.ok(h.element('fbContact').classList.contains('active'));
    if (change === 'rating') assert.equal(h.run('ratings.overall'), 5);
  });
}
for (const [label, reply] of [
  ['boolean success only', { success: true }],
  ['unknown delivery', { success: true, delivery: 'unknown' }],
  ['false success', { success: false, delivery: 'acknowledged' }],
  ['missing result', null]
]) {
  test(label + ' cannot show Sent', async () => {
    const h = createHarness({ reply }); await h.open(); await h.choose('contact');
    await h.setText('fbContactText', textDraft); await h.fire('fbContactSubmit'); await h.runTimers();
    assertNotSent(h, 'fbContactStatus');
    assert.equal(h.element('fbContactText').value, textDraft);
    assert.equal(h.element('fbContactSubmit').disabled, false);
    assert.ok(h.element('fbOverlay').classList.contains('show'));
  });
}
test('only an acknowledged delivery gives the current draft its Sent state', async () => {
  const h = createHarness({ reply: { success: true, delivery: 'acknowledged', replayed: true } });
  await h.open(); await h.choose('contact'); await h.setText('fbContactText', textDraft);
  await h.fire('fbContactSubmit');
  assert.equal(h.element('fbContactStatus').textContent, FEEDBACK.SUBMITTED);
  assert.ok(h.element('fbContactStatus').classList.contains('ok'));
  assert.equal(h.element('fbContactSubmit').disabled, true);
});
const draftChanges = [
  { name: 'bug text', mode: 'bug', statusId: 'fbBugStatus', button: 'fbBugSubmit',
    prepare: async h => h.setText('fbBugText', textDraft),
    edit: async h => h.setText('fbBugText', 'Changed ' + textDraft) },
  { name: 'contact text', mode: 'contact', statusId: 'fbContactStatus', button: 'fbContactSubmit',
    prepare: async h => h.setText('fbContactText', textDraft),
    edit: async h => h.setText('fbContactText', 'Changed ' + textDraft) },
  { name: 'rating comments', mode: 'rating', statusId: 'fbRatingStatus', button: 'fbRatingSubmit',
    prepare: async h => { await h.rate('overall', 3); await h.setText('fbRatingText', textDraft); },
    edit: async h => h.setText('fbRatingText', 'Changed ' + textDraft) },
  { name: 'rating score', mode: 'rating', statusId: 'fbRatingStatus', button: 'fbRatingSubmit',
    prepare: async h => { await h.rate('overall', 3); await h.setText('fbRatingText', textDraft); },
    edit: async h => h.rate('overall', 5) },
  { name: 'screenshot replacement', mode: 'bug', statusId: 'fbBugStatus', button: 'fbBugSubmit',
    prepare: async h => { await h.setText('fbBugText', textDraft); await h.screenshot(); },
    edit: async h => { const changed = png.slice(); changed[23] = 2; await h.screenshot(changed, 'changed.png'); } },
  { name: 'screenshot removal', mode: 'bug', statusId: 'fbBugStatus', button: 'fbBugSubmit',
    prepare: async h => { await h.setText('fbBugText', textDraft); await h.screenshot(); },
    edit: async h => h.fire('fbShotRemove') },
  { name: 'Support Report attachment', mode: 'bug', statusId: 'fbBugStatus', button: 'fbBugSubmit',
    prepare: async h => h.setText('fbBugText', textDraft),
    edit: async h => h.fire('fbAttachReport') }
];
for (const change of draftChanges) {
  for (const result of [
    { name: 'acknowledgement', value: { success: true, delivery: 'acknowledged' } },
    { name: 'unknown result', value: { success: false, delivery: 'unknown', error: FEEDBACK.SEND_UNKNOWN } }
  ]) {
    test('pending ' + result.name + ' cannot overwrite visible draft status after ' + change.name, async () => {
      const h = createHarness(); await h.open(); await h.choose(change.mode); await change.prepare(h);
      const pending = h.fire(change.button);
      assert.equal(h.calls.length, 1);
      assert.ok([FEEDBACK.SUBMITTING, FEEDBACK.SUBMITTING_IMAGE].includes(h.element(change.statusId).textContent));
      await change.edit(h);
      assertDraftChanged(h, change.statusId);
      assert.equal(h.element(change.button).disabled, true, 'the old request still owns the in-flight submission guard');
      h.settle(result.value); await pending;
      assertDraftChanged(h, change.statusId);
      assert.equal(h.element(change.button).disabled, false, 'the edited valid draft becomes usable after the old request finishes');
      assert.equal(h.calls.length, 1, 'draft edits never send automatically');
      assert.ok(h.element('fbOverlay').classList.contains('show'));
    });
  }
  test('confirmed status is invalidated immediately by ' + change.name, async () => {
    const h = createHarness({ reply: { success: true, delivery: 'acknowledged' } });
    await h.open(); await h.choose(change.mode); await change.prepare(h); await h.fire(change.button);
    assert.equal(h.element(change.statusId).textContent, FEEDBACK.SUBMITTED);
    assert.ok(h.element(change.statusId).classList.contains('ok'));
    await change.edit(h);
    assertDraftChanged(h, change.statusId);
    assert.equal(h.element(change.button).disabled, false);
    assert.equal(h.calls.length, 1, 'editing a confirmed draft is not another submission');
  });
}

test('closing and reopening an unchanged pending draft cannot leave Submitting after stale completion', async () => {
  const h = createHarness(); await h.open(); await h.choose('contact'); await h.setText('fbContactText', textDraft);
  const pending = h.fire('fbContactSubmit');
  assert.equal(h.element('fbContactStatus').textContent, FEEDBACK.SUBMITTING);
  await h.fire('fbContactCancel'); await h.open(); await h.choose('contact');
  h.settle({ success: true, delivery: 'acknowledged' }); await pending;
  assert.equal(h.element('fbContactStatus').textContent, FEEDBACK.SEND_UNKNOWN);
  assertNotSent(h, 'fbContactStatus');
  assert.equal(h.element('fbContactSubmit').disabled, false);
  assert.equal(h.element('fbContactText').value, textDraft);
  assert.equal(h.calls.length, 1);
});

for (const image of imageHeaders) {
  test(image.name + ' canonical header is accepted by the actual renderer', async () => {
    const h = createHarness(); await h.open(); await h.choose('bug');
    await h.screenshot(image.bytes, 'synthetic-' + image.name, image.mediaType);
    assert.equal(h.run('bugScreenshot.mediaType'), image.mediaType);
    assert.deepEqual(Array.from(h.run('bugScreenshot.bytes')), Array.from(image.bytes));
    assert.equal(h.element('fbShotPreview').hidden, false);
    assert.equal(h.calls.length, 0, 'attachment selection never submits');
  });
  for (const length of image.truncatedLengths) {
    test(image.name + ' truncated ' + length + '-byte prefix is rejected before submission', async () => {
      const h = createHarness(); await h.open(); await h.choose('bug');
      await h.selectScreenshot(image.bytes.slice(0, length), 'truncated-' + image.name, image.mediaType);
      assert.equal(h.run('bugScreenshot'), null);
      assert.equal(h.run('shotReadBusy'), false);
      assert.ok(h.element('fbShotStatus').classList.contains('err'));
      assert.ok(h.element('fbShotStatus').textContent.length > 0);
      assert.equal(h.calls.length, 0);
    });
  }
}
test('PNG signature without the canonical IHDR marker is rejected', async () => {
  const h = createHarness(); await h.open(); await h.choose('bug');
  const wrongChunk = png.slice(); wrongChunk[12] = 0;
  await h.selectScreenshot(wrongChunk);
  assert.equal(h.run('bugScreenshot'), null);
  assert.ok(h.element('fbShotStatus').classList.contains('err'));
  assert.equal(h.calls.length, 0);
});
test('a valid image header with a different declared MIME is rejected', async () => {
  const h = createHarness(); await h.open(); await h.choose('bug');
  await h.selectScreenshot(png, 'mismatched.jpg', 'image/jpeg');
  assert.equal(h.run('bugScreenshot'), null);
  assert.ok(h.element('fbShotStatus').classList.contains('err'));
  assert.equal(h.calls.length, 0);
});

test('a complete Support Report above the former 3700-character limit is preserved', async () => {
  const report = 'Synthetic report start\n' + 'x'.repeat(6000) + '\nSYNTHETIC REPORT END';
  const h = createHarness({ report }); await h.open(); await h.choose('bug'); await h.setText('fbBugText', textDraft);
  await h.fire('fbAttachReport');
  assert.equal(h.element('fbBugText').value, textDraft + '\n\n---\n' + report);
  assert.ok(!h.element('fbBugText').value.includes('[report trimmed'));
  assert.equal(h.element('fbAttachReport').textContent, 'Report attached');
});
test('an oversized Support Report is rejected without changing or trimming the draft', async () => {
  const h = createHarness({ report: 'é'.repeat(50 * 1024) }); await h.open(); await h.choose('bug');
  const draft = '  ' + textDraft + '  '; await h.setText('fbBugText', draft);
  await h.fire('fbAttachReport');
  assert.equal(h.element('fbBugText').value, draft);
  assert.equal(h.element('fbBugStatus').textContent, FEEDBACK.TEXT_TOO_LARGE);
  assert.equal(h.element('fbAttachReport').disabled, false);
});
test('pending Support Report generation blocks submission of an incomplete attachment', async () => {
  const h = createHarness({ reportDeferred: true }); await h.open(); await h.choose('bug'); await h.setText('fbBugText', textDraft);
  const attaching = h.fire('fbAttachReport');
  assert.equal(h.element('fbBugSubmit').disabled, true);
  await h.fire('fbBugSubmit');
  assert.equal(h.calls.length, 0, 'the real handler must also reject a forced click while attachment is pending');
  h.settleReport('Complete synthetic report.'); await attaching;
  assert.equal(h.element('fbBugSubmit').disabled, false);
  assert.ok(h.element('fbBugText').value.endsWith('Complete synthetic report.'));
});
test('Back invalidates pending Support Report completion before another form becomes active', async () => {
  const h = createHarness({ reportDeferred: true }); await h.open(); await h.choose('bug'); await h.setText('fbBugText', textDraft);
  const attaching = h.fire('fbAttachReport');
  await h.fire('fbBugBack'); await h.choose('contact'); await h.setText('fbContactText', 'New ' + textDraft);
  h.settleReport('Stale synthetic report.'); await attaching;
  assert.equal(h.element('fbBugText').value, textDraft);
  assert.equal(h.element('fbContactText').value, 'New ' + textDraft);
  assert.ok(h.element('fbContact').classList.contains('active'));
  assert.ok(h.element('fbOverlay').classList.contains('show'));
});

(async () => {
  let passed = 0, failed = 0;
  for (const item of tests) {
    const firstHarness = liveHarnesses.length;
    try { await item.fn(); passed++; }
    catch (error) { failed++; console.error('FAIL feedback-renderer: ' + item.name + ': ' + error.message); }
    finally { for (const h of liveHarnesses.slice(firstHarness)) await h.dispose(); }
  }
  console.log('feedback-renderer-smoke: ' + passed + ' passed, ' + failed + ' failed; inert DOM/deferred IPC only');
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => { suiteFinished = true; });
