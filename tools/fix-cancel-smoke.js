'use strict';

const { createFixCancelBroker, FIX_CHECKPOINTS } = require('../src/main/fix-cancel');

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
  check(Object.isFrozen(FIX_CHECKPOINTS) && FIX_CHECKPOINTS.length === 6,
    'engine checkpoints are a fixed internal contract');

  console.log('fix-cancel-smoke: cooperative cancellation');
  {
    const broker = createFixCancelBroker();
    const lines = [];
    const event = fakeEvent(7, lines);
    const gate = deferred();
    const run = broker.run(event, async wrapped => {
      wrapped.fixCheckpoint('before-close-helper');
      wrapped.sender.send('fix-log', { line: 'Translated or edited progress text', kind: 'header' });
      await gate.promise;
      wrapped.fixCheckpoint('before-profile-plan');
      return { success: true };
    });
    const req = broker.requestCancel(event);
    check(req.success && req.cancelRequested, 'cancel request accepted while fix is active');
    gate.resolve();
    const result = await run;
    check(result.cancelled === true && result.error === 'cancelled', 'run stops at the next safe boundary');
    check(result.stoppedBefore === 'before-profile-plan' && lines.some(line => line.includes('Completed changes remain')),
      'cancellation names its engine checkpoint and preserves earlier effects');
  }

  console.log('fix-cancel-smoke: progress text cannot interrupt the rebuild');
  {
    const broker = createFixCancelBroker();
    const lines = [];
    const event = fakeEvent(8, lines);
    const gate = deferred();
    let reached7 = false;
    const run = broker.run(event, async wrapped => {
      wrapped.fixCheckpoint('before-profile-rebuild');
      await gate.promise;
      for (const line of ['[1/8] misleading', '[7/8] misleading', '[V] misleading', 'new copy']) {
        wrapped.sender.send('fix-log', { line, kind: 'header' });
      }
      reached7 = true;
      wrapped.fixCheckpoint('before-preferences');
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
      wrapped.fixCheckpoint('before-verification');
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

  {
    const broker = createFixCancelBroker();
    const own = fakeEvent(11, []);
    const foreign = fakeEvent(12, []);
    const gate = deferred();
    const run = broker.run(own, async wrapped => { await gate.promise; wrapped.fixCheckpoint('before-profile-plan'); return { success: true }; });
    check(broker.requestCancel(foreign).success === false, 'another sender cannot cancel this repair');
    gate.resolve();
    check((await run).success === true, 'foreign request has no effect');
    let rejected = false;
    try { await broker.run(own, async wrapped => wrapped.fixCheckpoint('[3/8] log text')); }
    catch (_) { rejected = true; }
    check(rejected, 'unknown or log-shaped checkpoints fail closed');
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
