// Smoke test for messages.js — the user-facing message catalog.
// Unlike the older smoke tools, this imports the REAL module (messages.js is
// a classic browser script with a module.exports guard), so the copy under
// test is the copy that ships.
//
// Contract under test (support copy standard):
//  - no user-visible path returns a bare code, raw enum, 'unknown', or
//    'Unknown error.'
//  - unmapped/unrecognized inputs keep the raw value visible for support,
//    wrapped in guidance
//  - every message tells the user a next step

const m = require('../messages.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('messages-smoke: friendlyError');
for (const code of Object.keys(m.FRIENDLY_ERRORS)) {
  const msg = m.friendlyError(code);
  check(typeof msg === 'string' && msg.length > 20, `mapped code '${code}' returns real copy`);
  check(msg !== code, `mapped code '${code}' is not echoed bare`);
}
{
  const msg = m.friendlyError('some_new_code');
  check(msg.includes('some_new_code'), 'unmapped code stays visible for support');
  check(/Feedback & Report/.test(msg), 'unmapped code points at Feedback & Report');
  check(!/^some_new_code$/.test(msg), 'unmapped code is wrapped, not bare');
}
{
  const msg = m.friendlyError(null);
  check(msg.length > 20 && !/unknown error/i.test(msg), 'null code gets guidance, not "Unknown error."');
}
{
  const msg = m.FRIENDLY_ERRORS.zoom_not_found;
  check(/zoom\.us\/download/.test(msg), 'zoom_not_found says WHERE to download the MSI (W8-UX)');
  check(!/C:\\Program Files\\Zoom/.test(msg), 'zoom_not_found no longer hardcodes the x64 path the W1 resolver looks beyond');
}

console.log('messages-smoke: fix/scan/shortcut failures');
{
  const msg = m.unexpectedFixFailure(new Error('boom detail'));
  check(msg.includes('safe to run the fix again'), 'unexpected failure says re-run is safe');
  check(msg.includes('boom detail'), 'unexpected failure keeps detail for support');
  check(m.unexpectedFixFailure(null).length > 20, 'unexpected failure works without an error object');
}
{
  const msg = m.scanFailureMessage(new Error('ipc dead'));
  check(msg.includes('Administrator'), 'scan failure names the most likely fix (elevation)');
  check(msg.includes('ipc dead'), 'scan failure keeps detail');
  check(!/^ipc dead/.test(msg), 'scan failure never leads with the raw message');
}
{
  const msg = m.shortcutFailureMessage('Exit 1');
  check(msg.includes('Create Zoom Helper Shortcut'), 'shortcut failure names the retry button');
  check(msg.includes('Exit 1'), 'shortcut failure keeps raw detail');
  check(m.shortcutFailureMessage(null).includes('Nothing else was changed'), 'shortcut failure states blast radius without detail');
}

console.log('messages-smoke: receipt describers');
for (const key of Object.keys(m.HKU_STATES)) {
  check(m.describeHku(key).txt === m.HKU_STATES[key].txt, `hku '${key}' maps`);
}
for (const key of Object.keys(m.FRAME_SERVER_STATES)) {
  check(m.describeFrameServer(key).txt === m.FRAME_SERVER_STATES[key].txt, `frameServer '${key}' maps`);
}
{
  const d = m.describeHku('weird-new-state');
  check(d.txt.includes('weird-new-state'), 'unrecognized hku keeps raw value visible');
  check(!/unknown$/i.test(d.txt), 'unrecognized hku is not bare "unknown"');
  const empty = m.describeHku(undefined);
  check(empty.txt.includes('Not recorded'), 'missing hku explained, not "unknown"');
}
{
  check(m.receiptStatusFor('OK').text === 'GRANTED', 'OK receipt unchanged');
  check(m.receiptStatusFor('POLICY-BLOCKED').status === 'fail', 'policy-blocked receipt unchanged');
  check(m.receiptStatusFor('UNVERIFIED').status === 'warn', 'unverified receipt unchanged');
  const unk = m.receiptStatusFor('SOMETHING-NEW');
  check(unk.text.includes('SOMETHING-NEW'), 'unrecognized receipt keeps raw value');
  check(unk.text !== 'SOMETHING-NEW', 'unrecognized receipt is wrapped');
  const missing = m.receiptStatusFor(undefined);
  check(missing.text.includes('Not recorded'), 'missing receipt status explained');
}

console.log('messages-smoke: checklist group mapping (§9)');
{
  const TAXONOMY = ['App', 'Zoom', 'Helper account', 'Privacy policies', 'Camera service'];
  const EXPECTED_KEYS = ['admin', 'zoom', 'helperUser', 'seclogon', 'camPolicy', 'micPolicy', 'hku', 'frameServer'];
  check(JSON.stringify(m.CHECK_ORDER.map(c => c.key)) === JSON.stringify(EXPECTED_KEYS),
    'CHECK_ORDER keys and display order unchanged');
  check(m.CHECK_ORDER.every(c => typeof c.label === 'string' && c.label.length > 0),
    'every check row has a fallback label');
  check(m.CHECK_ORDER.every(c => TAXONOMY.includes(c.group)),
    'every check row maps to an approved group name');
  // Renderer emits a header when the group CHANGES — a group split across
  // non-adjacent rows would render the same header twice.
  const collapsed = m.CHECK_ORDER.map(c => c.group).filter((g, i, a) => g !== a[i - 1]);
  check(JSON.stringify(collapsed) === JSON.stringify(TAXONOMY),
    'groups are contiguous and cover the full taxonomy in order');
}

console.log('messages-smoke: catalog-wide bans');
{
  const everyMessage = [
    ...Object.values(m.FRIENDLY_ERRORS),
    m.friendlyError('x_code'), m.friendlyError(null),
    m.unexpectedFixFailure(null), m.scanFailureMessage(null), m.shortcutFailureMessage(null),
    m.describeHku(undefined).txt, m.describeFrameServer(undefined).txt,
    m.receiptStatusFor(undefined).text,
    m.FEEDBACK_FALLBACK, m.FEEDBACK_NETWORK, m.reportBuildFailure(null)
  ];
  check(everyMessage.every(s => !/^unknown/i.test(s.trim())), 'no message starts with "unknown"');
  check(everyMessage.every(s => !/unknown error\.?$/i.test(s.trim())), 'no message is "Unknown error."');
  check(everyMessage.every(s => s.trim().length >= 20), 'no message is a fragment');
}

if (failures) {
  console.error(`messages-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('messages-smoke: all checks passed');
