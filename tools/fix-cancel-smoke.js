'use strict';

const { createFixCancelBroker, isSafeFixCancelBoundary } = require('../src/main/fix-cancel');

let failures = 0;
function check(condition, name) {
  if (condition) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fakeEvent(id, lines) {
  return {
    sender: {
      id,
      send(channel, payload) {
        if (channel === 'fix-log' && payload && payload.line) lines.push(payload.line);
      }
    }
  };
}

(async () => {
  console.log('fix-cancel-smoke: safe boundary classification');
  for (const line of ['[1/8] close', '[2/8] clean', '[3/8] rebuild', '[7/8] settings', '[8/8] launch', '[V] verify']) {
    check(isSafeFixCancelBoundary(line), `${line} is cancellable`);
  }
  for (const line of ['[3b/8] profile service', '[4/8] recreate', '[5/8] launch', '[6/8] profile']) {
    check(!isSafeFixCancelBoundary(line), `${line} stays inside the atomic rebuild`);
  }

  console.log('fix-cancel-smoke: cooperative cancellation');
  {
    const broker = createFixCancelBroker();
    const lines = [];
    const event = fakeEvent(7, lines);
    const gate = deferred();
    const run = broker.run(event, async wrapped => {
      wrapped.sender.send('fix-log', { line: '[1/8] first', kind: 'header' });
      await gate.promise;
      wrapped.sender.send('fix-log', { line: '[2/8] second', kind: 'header' });
      return { success: true };
    });
    const req = broker.requestCancel(event);
    check(req.success && req.cancelRequested, 'cancel request accepted while fix is active');
    gate.resolve();
    const result = await run;
    check(result.cancelled === true && result.error === 'cancelled', 'run stops at the next safe boundary');
    check(lines.includes('Fix cancelled safely — no further changes will be made.'), 'truthful cancellation log is emitted');
  }

  console.log('fix-cancel-smoke: atomic rebuild is never interrupted');
  {
    const broker = createFixCancelBroker();
    const lines = [];
    const event = fakeEvent(8, lines);
    const gate = deferred();
    let reached7 = false;
    const run = broker.run(event, async wrapped => {
      wrapped.sender.send('fix-log', { line: '[3/8] account teardown begins', kind: 'header' });
      await gate.promise;
      for (const line of ['[3b/8] service', '[4/8] recreate', '[5/8] launch', '[6/8] profile']) {
        wrapped.sender.send('fix-log', { line, kind: 'header' });
      }
      reached7 = true;
      wrapped.sender.send('fix-log', { line: '[7/8] preferences', kind: 'header' });
      return { success: true };
    });
    broker.requestCancel(event);
    gate.resolve();
    const result = await run;
    check(reached7, 'cancellation waits until the account/profile rebuild is stable');
    check(result.cancelled === true, 'run then cancels before the next optional stage');
  }

  console.log('fix-cancel-smoke: late cancellation stays truthful');
  {
    const broker = createFixCancelBroker();
    const lines = [];
    const event = fakeEvent(9, lines);
    const gate = deferred();
    const run = broker.run(event, async wrapped => {
      wrapped.sender.send('fix-log', { line: '[V] verifying', kind: 'header' });
      await gate.promise;
      return { success: true, receipt: { zoomRelaunch: 'confirmed' } };
    });
    broker.requestCancel(event);
    gate.resolve();
    const result = await run;
    check(result.success === true && result.cancelTooLate === true, 'completed fix is not falsely reported as cancelled');
  }

  console.log('fix-cancel-smoke: idle cancel request does nothing');
  {
    const broker = createFixCancelBroker();
    const event = fakeEvent(10, []);
    const result = broker.requestCancel(event);
    check(result.cancelRequested === false, 'idle request is rejected');
  }

  if (failures) {
    console.error(`fix-cancel-smoke: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('fix-cancel-smoke: all checks passed');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
