'use strict';

/**
 * Support Report window rules (support-report-view.js, messages.js), audit
 * findings A12, A13 and A14 of 2026-11-14.
 *   A12: an older result can never overwrite a newer preview.
 *   A13: Copy is disabled and refuses unless a current, complete report
 *        shows; it never says "Copied" for the placeholder or the failure.
 *   A14: a failed build shows fixed text; no message, path or user name from
 *        the error reaches the copyable report.
 * Part 4 checks the renderer and page wiring from source.
 */

const fs = require('fs');
const path = require('path');
const { createSupportReportController } = require('../support-report-view.js');
const messages = require('../messages.js');

let failures = 0;
let checks = 0;
function check(cond, name) {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A fake window: records what the DOM would show.
function harness(requestReport) {
  const ui = { text: '', copyEnabled: true, status: '', tone: '', clipboard: [], selected: 0, clipboardFails: false };
  const controller = createSupportReportController({
    requestReport,
    failureText: messages.reportBuildFailure,
    copy: messages.SUPPORT_REPORT,
    setText: (v) => { ui.text = v; },
    setCopyEnabled: (e) => { ui.copyEnabled = e; },
    setStatus: (m, t) => { ui.status = m; ui.tone = t; },
    writeClipboard: async (v) => { if (ui.clipboardFails) throw new Error('blocked'); ui.clipboard.push(v); },
    selectText: () => { ui.selected++; }
  });
  return { ui, controller };
}

(async () => {
  const S = messages.SUPPORT_REPORT;

  console.log('support-report-view-smoke: A12, an older result never overwrites a newer preview');
  {
    const calls = [];
    const { ui, controller } = harness(() => { const d = deferred(); calls.push(d); return d.promise; });
    const first = controller.open({ n: 1 });
    const second = controller.open({ n: 2 });
    calls[1].resolve({ markdown: '# report two' });
    check(await second === 'ready' && ui.text === '# report two', 'the newer request shows its report');
    calls[0].resolve({ markdown: '# report one (old)' });
    check(await first === 'stale' && ui.text === '# report two', 'the older result arriving later is dropped');
    check(ui.copyEnabled === true, 'Copy stays enabled for the current report');
    calls.length = 0;
    const third = controller.open({ n: 3 });
    controller.close();
    calls[0].resolve({ markdown: '# report after close' });
    check(await third === 'stale' && ui.text === S.GENERATING, 'a result after Close is dropped (the text is left as it was)');
    check(ui.copyEnabled === false, 'Copy is disabled after Close');
    const failingLate = harness(() => { const d = deferred(); calls.push(d); return d.promise; });
    calls.length = 0;
    const a = failingLate.controller.open({});
    const b = failingLate.controller.open({});
    calls[1].resolve({ markdown: '# fresh' });
    await b;
    calls[0].reject(new Error('late failure'));
    check(await a === 'stale' && failingLate.ui.text === '# fresh', 'an older failure arriving later does not replace a newer report');
    // The reverse: the newer request fails, then an older success arrives.
    const reverse = harness(() => { const d = deferred(); calls.push(d); return d.promise; });
    calls.length = 0;
    const older = reverse.controller.open({});
    const newer = reverse.controller.open({});
    calls[1].reject(new Error('newer failed'));
    check(await newer === 'failed' && reverse.ui.text === messages.reportBuildFailure(), 'the newer failure shows the fixed text');
    calls[0].resolve({ markdown: '# older report' });
    check(await older === 'stale' && reverse.ui.text === messages.reportBuildFailure() && reverse.ui.copyEnabled === false,
      'an older success arriving later neither replaces the failure nor re-enables Copy');
    // Copy in flight while the window closes and reopens.
    const racing = deferred();
    const raceUi = { text: '', status: '', selected: 0 };
    const slowWrite = createSupportReportController({
      requestReport: async () => ({ markdown: '# ready' }), failureText: messages.reportBuildFailure, copy: S,
      setText: (v) => { raceUi.text = v; }, setCopyEnabled: () => {}, setStatus: (m) => { raceUi.status = m; },
      writeClipboard: () => racing.promise, selectText: () => { raceUi.selected++; }
    });
    await slowWrite.open({});
    const copying = slowWrite.copy();
    slowWrite.close();
    const reopening = slowWrite.open({});
    racing.resolve();
    check(await copying === 'stale' && raceUi.status !== S.COPIED, 'a copy that finishes after Close/reopen does not say "Copied" in the new window');
    await reopening;
    // Same race, but the clipboard refuses: no selection of the new window's text.
    const blocked = deferred();
    const blockedUi = { text: '', status: '', selected: 0 };
    const blockedWrite = createSupportReportController({
      requestReport: async () => ({ markdown: '# ready' }), failureText: messages.reportBuildFailure, copy: S,
      setText: (v) => { blockedUi.text = v; }, setCopyEnabled: () => {}, setStatus: (m) => { blockedUi.status = m; },
      writeClipboard: () => blocked.promise, selectText: () => { blockedUi.selected++; }
    });
    await blockedWrite.open({});
    const copyingBlocked = blockedWrite.copy();
    blockedWrite.close();
    const reopenBlocked = blockedWrite.open({});
    blocked.reject(new Error('blocked'));
    check(await copyingBlocked === 'stale' && blockedUi.selected === 0 && blockedUi.status !== S.COPY_BLOCKED,
      'a blocked copy that fails after Close/reopen neither selects the new text nor shows the Ctrl+C hint');
    await reopenBlocked;
  }

  console.log('support-report-view-smoke: A13, Copy only for a current, complete report');
  {
    const d = deferred();
    const { ui, controller } = harness(() => d.promise);
    const opening = controller.open({});
    check(ui.text === S.GENERATING && ui.copyEnabled === false, 'while generating, the placeholder shows and Copy is disabled');
    check(await controller.copy() === 'refused' && ui.clipboard.length === 0, 'Copy refuses while the placeholder shows');
    check(ui.status === S.NOT_READY && ui.status !== S.COPIED, 'it never says "Copied" for the placeholder');
    d.resolve({ markdown: '# sanitized report' });
    await opening;
    check(ui.copyEnabled === true, 'Copy is enabled once the report is complete');
    check(await controller.copy() === 'copied' && ui.clipboard[0] === '# sanitized report' && ui.status === S.COPIED,
      'Copy writes the current report and says "Copied"');
    ui.clipboardFails = true;
    check(await controller.copy() === 'selected' && ui.selected === 1 && ui.status === S.COPY_BLOCKED,
      'a blocked clipboard selects the text and says so');
  }
  {
    const { ui, controller } = harness(async () => { throw new Error('build failed'); });
    check(await controller.open({}) === 'failed' && ui.copyEnabled === false, 'after a failed build Copy stays disabled');
    check(await controller.copy() === 'refused' && ui.clipboard.length === 0 && ui.status !== S.COPIED,
      'Copy refuses the failure text and never says "Copied"');
    const empty = harness(async () => ({ markdown: '' }));
    check(await empty.controller.open({}) === 'failed' && empty.ui.copyEnabled === false, 'an empty report counts as a failure');
    const missing = harness(async () => null);
    check(await missing.controller.open({}) === 'failed', 'no result counts as a failure');
  }

  console.log('support-report-view-smoke: A14, no error text, path or user name reaches the report');
  {
    // Canary values built at run time; none of them may appear in the report.
    const user = ['canary', 'user', Date.now().toString(36)].join('.');
    const privatePath = ['C:', 'Users', user, 'AppData', 'Local', '1132 Fixer', 'secret-canary.txt'].join('\\');
    const err = new Error(`ENOENT: no such file or directory, open '${privatePath}'`);
    err.code = 'ENOENT';
    err.path = privatePath;
    err.stack = `Error: ${privatePath}\n    at ${privatePath}:1:1`;
    const { ui, controller } = harness(async () => { throw err; });
    await controller.open({});
    const fixed = messages.reportBuildFailure();
    check(ui.text === fixed, 'the failure shows exactly the fixed text');
    for (const canary of [user, privatePath, 'Users', 'secret-canary', 'ENOENT', 'AppData']) {
      check(!ui.text.includes(canary), `the report does not contain "${canary.length > 24 ? canary.slice(0, 24) + '…' : canary}"`);
    }
    check(messages.reportBuildFailure(err) === fixed && messages.reportBuildFailure('C:\\Users\\x') === fixed &&
      messages.reportBuildFailure(null) === fixed, 'reportBuildFailure ignores any argument');
    check(!/Detail for support/.test(fixed) && fixed.length > 0, 'the fixed text has no "Detail for support" part');
    const rejected = harness(() => Promise.reject(err));
    await rejected.controller.open({});
    check(rejected.ui.text === fixed, 'a rejected promise shows the same fixed text');
    // Every other way an error value could arrive.
    const cases = [
      ['a thrown string', async () => { throw privatePath; }],
      ['a thrown plain object', async () => { throw { message: privatePath, code: user, path: privatePath }; }],
      ['a synchronous throw', () => { throw new Error(privatePath); }],
      ['a result with an error field', async () => ({ error: privatePath, message: user })],
      ['a non-string markdown object', async () => ({ markdown: { toString: () => privatePath } })],
      ['a numeric markdown', async () => ({ markdown: 42 })]
    ];
    for (const [name, request] of cases) {
      const h = harness(request);
      const outcome = await h.controller.open({});
      await h.controller.copy();
      const seen = [h.ui.text, h.ui.status, ...h.ui.clipboard].join('\n');
      check(outcome === 'failed' && h.ui.text === fixed && !seen.includes(user) && !seen.includes(privatePath) &&
        h.ui.clipboard.length === 0, `${name}: fixed text only, nothing copied, no canary in text, status or clipboard`);
    }
  }

  console.log('support-report-view-smoke: renderer and page wiring');
  {
    const root = path.join(__dirname, '..');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const start = renderer.indexOf('// Support Report modal');
    const end = renderer.indexOf('// Esc closes any open modal', start);
    const block = start >= 0 && end > start ? renderer.slice(start, end) : '';
    check(block.length > 0, 'the Support Report block is found in renderer.js');
    check(/createSupportReportController\(\{/.test(block) && /failureText: reportBuildFailure,/.test(block) &&
      /copy: SUPPORT_REPORT,/.test(block), 'the renderer builds the window with the shared controller and copy');
    check(!/err\.message|reportBuildFailure\(err\)|String\(err/.test(block), 'the renderer passes no error to the report text');
    check(/supportCopyBtn\.addEventListener\('click', \(\) => supportReport\.copy\(\)\)/.test(block) &&
      !/navigator\.clipboard\.writeText\(supportTextArea\.value\)/.test(block), 'Copy goes through the controller, never the raw text box');
    check(/supportCopyBtn\.disabled = !enabled/.test(block), 'the controller drives the Copy button state');
    check(/supportReport\.close\(\)/.test(block), 'Close ends the current generation');
    const viewTag = html.indexOf('<script src="support-report-view.js"></script>');
    const messagesTag = html.indexOf('<script src="messages.js"></script>');
    const rendererTag = html.indexOf('<script src="renderer.js"></script>');
    check(viewTag > messagesTag && messagesTag > 0 && rendererTag > viewTag, 'support-report-view.js loads after messages.js and before renderer.js');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check(pkg.scripts['test:core'].includes('node tools/support-report-view-smoke.js'), 'this test is part of npm run test:core');
  }

  if (failures) { console.error(`\nsupport-report-view-smoke: ${failures} of ${checks} FAILED`); process.exit(1); }
  console.log(`\nsupport-report-view-smoke: ${checks} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
