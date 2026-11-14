'use strict';

// Node only. Load the complete shipped shell into an isolated VM with inert
// elements, observer records, animation frames, timers, and request adapters.
// No browser, Electron, application IPC, subprocess, network, or file writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gate = require('../screen-actions').applyScreenControls;
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'compact-shell.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const ids = new Map(), observers = [], frames = [], timers = new Map(), requests = [];
  let writes = 0, nextTimer = 1, quitCalls = 0;
  const attributeName = key => 'data-' + String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase());
  function notify(record) {
    writes++;
    for (const observer of observers) {
      for (const watch of observer.watches) {
        let target = record.target;
        while (target && target !== watch.target && watch.options.subtree) target = target.parent;
        if (target !== watch.target) continue;
        if (!watch.options[record.type]) continue;
        if (record.type === 'attributes' && watch.options.attributeFilter
          && !watch.options.attributeFilter.includes(record.attributeName)) continue;
        observer.records.push({ ...record, oldValue: watch.options.attributeOldValue ? record.oldValue : null });
        break;
      }
    }
  }
  class Element {
    constructor(id = '') {
      this.id = id;
      this.parent = null;
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this._text = '';
      this._html = '';
      this.checked = true;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
        toggle: (name, on) => {
          const names = this.className.split(/\s+/).filter(Boolean).filter(value => value !== name);
          if (on) names.push(name);
          this.className = names.join(' ');
        }
      };
      this.dataset = new Proxy({}, {
        get: (_target, key) => this.getAttribute(attributeName(key)) || undefined,
        set: (_target, key, value) => { this.setAttribute(attributeName(key), String(value)); return true; },
        deleteProperty: (_target, key) => { this.removeAttribute(attributeName(key)); return true; }
      });
      if (id) ids.set(id, this);
    }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', String(value)); }
    get hidden() { return this.attributes.has('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get disabled() { return this.attributes.has('disabled'); }
    set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get textContent() { return this._text; }
    set textContent(value) {
      this._text = String(value);
      // Replacing text creates an observed child-list mutation even when the
      // visible string is unchanged. This catches self-observing sync loops.
      notify({ type: 'childList', target: this });
    }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      this._html = value;
      if (value.includes('compact-exit-keep')) {
        const keep = new Element(); keep.className = 'compact-exit-keep'; this.appendChild(keep);
        const confirm = new Element(); confirm.className = 'compact-exit-confirm'; this.appendChild(confirm);
      }
      notify({ type: 'childList', target: this });
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) {
      const oldValue = this.getAttribute(name);
      this.attributes.set(name, String(value));
      notify({ type: 'attributes', target: this, attributeName: name, oldValue });
    }
    removeAttribute(name) {
      if (!this.attributes.has(name)) return;
      const oldValue = this.attributes.get(name);
      this.attributes.delete(name);
      notify({ type: 'attributes', target: this, attributeName: name, oldValue });
    }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      notify({ type: 'childList', target: this });
      return child;
    }
    querySelector(selector) {
      const match = /^\.([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(selector);
      assert.ok(match, 'inert fixture supports requested selector: ' + selector);
      const find = root => {
        for (const child of root.children) {
          if (child.classList.contains(match[1]) && (!match[2] || child.getAttribute(match[2]) === match[3])) return child;
          const nested = find(child);
          if (nested) return nested;
        }
        return null;
      };
      return find(this);
    }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }
    emit(name) { for (const callback of this.listeners.get(name) || []) callback({ preventDefault() {} }); }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { document.activeElement = this; }
  }
  const document = {
    readyState: 'complete', activeElement: null,
    documentElement: new Element('documentElement'), body: new Element('body'), head: new Element('head'),
    getElementById: id => ids.get(id) || null,
    createElement: () => new Element(),
    querySelector: selector => document.body.querySelector(selector)
  };
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  const add = (id, parent = document.body, className = '') => {
    const el = new Element(id); el.className = className; parent.appendChild(el); return el;
  };
  const wizard = add('wizardCard'), actionArea = add('actionArea', document.body, 'action-area');
  add('appMark', document.body, 'app-mark');
  add('statusBadge').setAttribute('data-tone', 'ready');
  const panes = {};
  for (const name of ['checking', 'result', 'fixing', 'notice']) panes[name] = add('wiz' + name[0].toUpperCase() + name.slice(1), wizard);
  add('checkingTitle', panes.checking, 'wiz-title');
  add('fixingTitle', panes.fixing, 'wiz-title');
  add('wizResultTitle', panes.result); add('wizResultSub', panes.result);
  add('wizNoticeTitle', panes.notice); add('wizNoticeSub', panes.notice);
  add('zoomRecovery', panes.result).hidden = true;
  const tracker = add('stageTracker', panes.fixing);
  for (const name of ['prep', 'verify', 'consent', 'launch', 'receipt']) {
    const row = add('stage-' + name, tracker, 'stage-pill');
    row.setAttribute('data-stage', name);
    row.setAttribute('data-state', name === 'prep' ? 'active' : 'pending');
  }
  const managed = require('../screen-actions').MANAGED_CONTROLS;
  for (const id of managed) add(id, id === 'btnExit' || id === 'backBtn' ? document.body : actionArea).hidden = true;
  add('shortcutOptInput', ids.get('shortcutOpt'));
  add('discoverySection', actionArea).hidden = true;
  ids.get('btnExit').hidden = false;
  panes.checking.classList.add('active');
  class Observer {
    constructor(callback) { this.callback = callback; this.watches = []; this.records = []; observers.push(this); }
    observe(target, options) { this.watches.push({ target, options }); }
  }
  const context = vm.createContext({
    module: { exports: {} }, document, MutationObserver: Observer,
    console: { log() {}, warn() {} },
    window: {
      requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
      setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    }
  });
  vm.runInContext(source, context, { filename: 'compact-shell-under-test.js' });
  context.module.exports.installCompactShell({
    gate,
    requestCancel() { const request = deferred(); requests.push(request); return request.promise; },
    requestQuit() { quitCalls++; }
  });
  function deliverObservers() {
    for (const observer of observers) {
      if (!observer.records.length) continue;
      const records = observer.records.splice(0);
      observer.callback(records);
    }
  }
  async function settle({ includeTimers = true } = {}) {
    let frameCount = 0;
    for (let turn = 0; turn < 24; turn++) {
      await Promise.resolve();
      deliverObservers();
      for (const callback of frames.splice(0)) { callback(); frameCount++; }
      if (includeTimers) {
        const current = Array.from(timers.entries());
        for (const [id, callback] of current) { if (timers.delete(id)) callback(); }
      }
      await Promise.resolve();
      if (!frames.length && !observers.some(observer => observer.records.length) && (!includeTimers || !timers.size)) return frameCount;
    }
    throw new Error('compact shell did not settle within bounded observer/frame turns');
  }
  function render(pane, outcome = '', tone = '') {
    for (const [name, el] of Object.entries(panes)) el.classList.toggle('active', name === pane);
    document.documentElement.dataset.fixOutcome = outcome;
    ids.get('statusBadge').setAttribute('data-tone', tone);
    ids.get('fixBtn').hidden = pane !== 'result';
    ids.get('elevateBtn').hidden = true;
    ids.get('zoomRecovery').hidden = true;
  }
  return {
    document, ids, requests, timers, render, settle, deliverObservers,
    writes: () => writes, pendingFrames: () => frames.length, quitCalls: () => quitCalls,
    state: () => document.body.dataset.compactState,
    exitOverlay: () => document.body.querySelector('.compact-exit-overlay'),
    async begin() { render('fixing', 'running'); await settle(); assert.equal(document.body.dataset.compactState, 'fixing'); },
    async cancelled(options) { render('notice', 'cancelled', 'error'); await settle(options); },
    chooseExit() {
      ids.get('btnExit').click();
      document.body.querySelector('.compact-exit-confirm').click();
    }
  };
}

async function check(name, run) { await run(); console.log('  ok  ' + name); }
const deadline = setTimeout(() => { console.error('compact-shell-observer-smoke: unfinished check'); process.exitCode = 1; }, 10000);
(async () => {
  await check('all idle states settle and verified success paints Complete copy', async () => {
    const h = harness();
    await h.settle();
    const states = [
      ['checking', 'checking', '', ''],
      ['ready', 'result', '', 'ready'],
      ['notice', 'notice', 'success', 'warn'],
      ['error', 'notice', 'error', 'error'],
      ['success', 'notice', 'success', 'done'],
      ['cancelled', 'notice', 'cancelled', 'error']
    ];
    for (const [expected, pane, outcome, tone] of states) {
      h.render(pane, outcome, tone);
      await h.settle();
      assert.equal(h.state(), expected);
      if (expected === 'success') {
        assert.equal(h.ids.get('wizNoticeTitle').textContent, 'Complete');
        assert.equal(h.ids.get('wizNoticeSub').textContent, 'Zoom has been fixed and is ready to use.');
      }
      const writes = h.writes();
      assert.equal(await h.settle(), 0);
      assert.equal(h.writes(), writes);
      assert.equal(h.pendingFrames(), 0);
    }
    h.render('result', '', 'warn');
    h.ids.get('fixBtn').hidden = true;
    await h.settle();
    assert.equal(h.state(), 'blocked');
    assert.equal(await h.settle(), 0);
    await h.begin();
    assert.equal(await h.settle(), 0);
    h.ids.get('cancelFixBtn').click();
    await h.settle();
    assert.equal(h.state(), 'cancelling');
    assert.equal(await h.settle(), 0);
    h.requests[0].resolve({ cancelRequested: true });
    await h.cancelled();
  });

  await check('progress changes reconcile then settle without redundant text writes', async () => {
    const h = harness(); await h.settle(); await h.begin();
    h.ids.get('stage-prep').setAttribute('data-state', 'done');
    h.ids.get('stage-consent').setAttribute('data-state', 'active');
    await h.settle();
    const progress = h.ids.get('wizFixing').querySelector('.compact-step-line');
    assert.equal(progress.textContent, 'Step 3 of 5');
    assert.equal(progress.getAttribute('aria-valuenow'), '3');
    const writes = h.writes();
    assert.equal(await h.settle(), 0);
    assert.equal(h.writes(), writes);
  });

  for (const exitFirst of [false, true]) {
    await check(exitFirst ? 'Exit then Cancel sends one request and exits once' : 'Cancel then Exit keeps exit intent and exits once', async () => {
      const h = harness(); await h.settle(); await h.begin();
      if (exitFirst) { h.chooseExit(); h.ids.get('cancelFixBtn').emit('click'); }
      else { h.ids.get('cancelFixBtn').click(); await h.settle(); h.chooseExit(); }
      assert.equal(h.requests.length, 1);
      h.requests[0].resolve({ cancelRequested: true });
      await h.cancelled();
      assert.equal(h.quitCalls(), 1);
      await h.settle();
      assert.equal(h.quitCalls(), 1);
    });
  }

  for (const reject of [false, true]) {
    await check(reject ? 'rejected Exit cancellation does not contaminate plain retry' : 'unaccepted Exit cancellation does not contaminate plain retry', async () => {
      const h = harness(); await h.settle(); await h.begin(); h.chooseExit();
      if (reject) h.requests[0].reject(new Error('fixture cancellation rejected'));
      else h.requests[0].resolve({ cancelRequested: false });
      await h.settle();
      assert.equal(h.state(), 'fixing');
      assert.equal(h.ids.get('cancelFixBtn').disabled, false);
      h.ids.get('cancelFixBtn').click();
      assert.equal(h.requests.length, 2);
      h.requests[1].resolve({ cancelRequested: true });
      await h.cancelled();
      assert.equal(h.quitCalls(), 0);
    });
  }

  await check('late rejection cannot reset newer run after coalesced terminal and running records', async () => {
    const h = harness(); await h.settle(); await h.begin(); h.chooseExit();
    h.ids.get('btnExit').click();
    assert.equal(h.exitOverlay().hidden, false);
    h.render('notice', 'error', 'error');
    h.render('fixing', 'running');
    h.deliverObservers();
    h.requests[0].reject(new Error('old run reply'));
    await h.settle();
    assert.equal(h.state(), 'fixing');
    assert.equal(h.exitOverlay().hidden, true);
    assert.equal(h.ids.get('cancelFixBtn').disabled, false);
    h.ids.get('cancelFixBtn').click();
    assert.equal(h.requests.length, 2);
    h.requests[1].resolve({ cancelRequested: true });
    await h.cancelled();
    assert.equal(h.quitCalls(), 0);
  });

  await check('new run cancels queued quit and stale timer cannot quit it', async () => {
    const h = harness(); await h.settle(); await h.begin(); h.chooseExit();
    h.requests[0].resolve({ cancelRequested: true });
    await h.cancelled({ includeTimers: false });
    assert.equal(h.timers.size, 1);
    const staleQuit = Array.from(h.timers.values())[0];
    h.render('fixing', 'running');
    h.deliverObservers();
    staleQuit();
    await h.settle();
    assert.equal(h.quitCalls(), 0);
    h.ids.get('cancelFixBtn').click();
    h.requests[1].resolve({ cancelRequested: true });
    await h.cancelled();
    assert.equal(h.quitCalls(), 0);
    await h.begin(); h.chooseExit();
    h.requests[2].resolve({ cancelRequested: true });
    await h.cancelled();
    assert.equal(h.quitCalls(), 1);
  });

  await check('late rejection after cancelled terminal cannot erase queued Exit', async () => {
    const h = harness(); await h.settle(); await h.begin(); h.chooseExit();
    await h.cancelled({ includeTimers: false });
    h.requests[0].reject(new Error('terminal reply arrived late'));
    await h.settle();
    assert.equal(h.quitCalls(), 1);
  });

  await check('Details and checkbox intent survive shell reconciliation', async () => {
    const h = harness(); await h.settle();
    h.render('result', '', 'ready');
    h.ids.get('fixBtn').textContent = 'Starting after check\u2026';
    for (const checked of [false, true]) {
      h.ids.get('shortcutOptInput').checked = checked;
      h.document.body.dataset.view = 'details';
      h.ids.get('wizardCard').hidden = true;
      h.ids.get('actionArea').hidden = true;
      await h.settle();
      assert.equal(h.document.body.dataset.view, 'details');
      assert.equal(h.ids.get('wizardCard').hidden, true);
      assert.equal(h.ids.get('actionArea').hidden, true);
      assert.equal(h.ids.get('shortcutOptInput').checked, checked);
      assert.equal(h.ids.get('fixBtn').textContent, 'Starting after check\u2026');
      delete h.document.body.dataset.view;
      h.ids.get('wizardCard').hidden = false;
      h.ids.get('actionArea').hidden = false;
      await h.settle();
      assert.equal(h.ids.get('shortcutOptInput').checked, checked);
    }
  });
  console.log('compact-shell-observer-smoke: all checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
