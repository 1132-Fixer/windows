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
  check(msg.includes('Create desktop shortcut'), 'shortcut failure names the retry button');
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
  const EXPECTED_KEYS = ['admin', 'zoom', 'helperUser', 'helperProfile', 'seclogon', 'camPolicy', 'micPolicy', 'hku', 'frameServer'];
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

console.log('messages-smoke: Zoom recovery card (directive 2026-08-09, byte-verbatim)');
{
  const z = m.ZOOM_RECOVERY;
  // Title, primary description, helper texts — byte-exact per the directive.
  check(z.TITLE === 'Zoom Workplace needs to be installed', 'title byte-exact');
  check(z.DESCRIPTION === '1132 Fixer uses the computer-wide version of Zoom Workplace. We could not find that version on this PC.', 'primary description byte-exact');
  check(z.HELPER_LABEL === 'What does this mean?', 'helper label byte-exact');
  check(z.HELPER_TEXT === 'Zoom may be missing, or you may have a personal version installed only for your Windows account. Install the 64-bit MSI version so Zoom works for every user on this computer.', 'helper text byte-exact (explains MSI in plain English, visible)');
  check(z.WHY_LABEL === 'Why is the MSI version required?', 'why-MSI label byte-exact');
  check(z.WHY_TEXT === 'The MSI package installs Zoom in the standard Windows program folder. This lets 1132 Fixer reliably find, check, and repair Zoom for every Windows user on this computer.', 'why-MSI expanded text byte-exact');
  check(z.TECH_LABEL === 'Technical details', 'technical-details label byte-exact');
  check(z.FLAG_LABEL === 'Action required', 'Action required label byte-exact (never red-alone)');
  // The official admin download URL — the ONLY URL the download action opens.
  check(z.DOWNLOAD_URL === 'https://zoom.us/download/admin', 'official admin download URL byte-exact');
  // Both accepted publisher CNs, exact.
  check(JSON.stringify(z.PUBLISHERS) === JSON.stringify(['Zoom Communications, Inc.', 'Zoom Video Communications, Inc.']), 'both publisher CNs byte-exact');
  // Four action labels (em dash in the recheck label is U+2014).
  check(z.ACTIONS.download === 'Download Zoom MSI', 'download action label byte-exact');
  check(z.ACTIONS.recheck === 'I installed it — Check again', 'recheck action label byte-exact');
  check(z.ACTIONS.choose === 'Choose installer file', 'choose action label byte-exact');
  check(z.ACTIONS.cancel === 'Cancel setup', 'cancel action label byte-exact');
  // The seven state strings — byte-exact incl. the U+2026 ellipsis and
  // straight apostrophes the directive uses.
  check(z.STATES.downloading === "Opening Zoom's official download page…", 'Downloading state byte-exact');
  check(z.STATES.waiting === 'Install Zoom Workplace, then return here and select Check again.', 'Waiting state byte-exact');
  check(z.STATES.checking === 'Checking for Zoom Workplace…', 'Checking state byte-exact');
  check(z.STATES.success === 'Zoom Workplace is installed and ready.', 'Success state byte-exact');
  check(z.STATES.still_not_found === 'We still cannot find the computer-wide Zoom installation. Make sure you installed the MSI version, then check again.', 'Still-not-found state byte-exact');
  check(z.STATES.wrong_version === 'We found Zoom, but it is installed only for one Windows user. Install the computer-wide MSI version to continue.', 'Wrong-version state byte-exact');
  check(z.STATES.offline === "We could not open Zoom's download page. Check your internet connection, or choose an MSI installer already saved on this computer.", 'Offline state byte-exact');

  // Truthfulness rule (operator amendment 2026-08-09): cancel copy states
  // the computer is unchanged + detection is read-only; the UAC copy
  // describes the ONE real automatic behavior precisely and promises no
  // credential handling.
  check(/read-only/.test(z.CANCEL_NOTE) && /leaves this computer exactly as it is/.test(z.CANCEL_NOTE), 'cancel copy: unchanged computer + read-only detection');
  check(/installs nothing unless you choose an installer/.test(z.CANCEL_NOTE), 'cancel copy: nothing modified without a user-chosen installer');
  check(/checks for Zoom again automatically/.test(z.UAC_NOTE), 'UAC copy describes the real installer-exit re-check precisely');
  check(/never asks for or stores your password/.test(z.UAC_NOTE), 'UAC copy: no credential request or storage');
  check(/Windows may now ask you to approve/.test(z.UAC_NOTE), 'UAC copy explains the admin-approval prompt BEFORE launch');
  // Once msiexec is running, the cancel copy and label swap to honest copy:
  // closing the app does NOT stop the installer or leave the computer as-is.
  check(/installer is running now/.test(z.CANCEL_NOTE_INSTALLING) && /will not stop it/.test(z.CANCEL_NOTE_INSTALLING), 'installing cancel copy: honest that closing does not stop the installer');
  check(z.ACTIONS.close_installing === 'Close 1132 Fixer', 'close-during-install action label byte-exact');

  // Download button accessible name says a browser opens and where.
  check(/opens Zoom's official download page/.test(z.DOWNLOAD_ARIA) && /browser/.test(z.DOWNLOAD_ARIA), 'download accessible label names the external destination');

  // Installer refusals name the EXACT failed check and state nothing ran.
  for (const code of ['not_msi_ext', 'not_msi_magic', 'changed', 'unreadable', 'signature', 'publisher', 'architecture']) {
    const msg = m.zoomInstallerRefusal(code, 'detail-x');
    check(/nothing was run/i.test(msg), `refusal '${code}' states nothing was executed`);
    check(msg.length > 40, `refusal '${code}' is real copy, not a fragment`);
  }
  check(/Failed check: publisher/.test(m.zoomInstallerRefusal('publisher', 'Evil Corp')) &&
        m.zoomInstallerRefusal('publisher', 'Evil Corp').includes('Evil Corp'), 'publisher refusal names the actual signer');
  check(/Failed check: digital signature/.test(m.zoomInstallerRefusal('signature', 'NotSigned')) &&
        m.zoomInstallerRefusal('signature', 'NotSigned').includes('NotSigned'), 'signature refusal keeps the Windows status visible');
  check(/Failed check: processor architecture/.test(m.zoomInstallerRefusal('architecture', 'arch explanation.')), 'architecture refusal names the check');
  check(/Failed check: file integrity/.test(m.zoomInstallerRefusal('changed', null)), 'changed refusal names the integrity check (post-validation swap)');
  check(/nothing was run/i.test(m.zoomInstallerRefusal('some_future_code', null)), 'unmapped refusal still states nothing was executed');

  // Technical-details disclosure: raw path demoted there, honestly framed.
  const td = m.zoomRecoveryTechDetails({ path: null, perUserPath: null });
  check(td.includes('C:\\Program Files\\Zoom\\bin\\Zoom.exe'), 'tech details carry the raw machine-wide path');
  check(/read-only/.test(td), 'tech details state the check is read-only');
  const tdPer = m.zoomRecoveryTechDetails({ path: null, perUserPath: 'C:\\Users\\a\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe' });
  check(tdPer.includes('C:\\Users\\a\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe'), 'tech details show the per-user path when present');
  check(m.zoomRecoveryTechDetails(null).length > 40, 'tech details work without install data, no throw');
}

console.log('messages-smoke: wizard states (directive 2026-08-23)');
{
  // Group derivation can never drift from CHECK_ORDER: same keys, same order.
  const derivedKeys = m.WIZARD_GROUPS.flatMap(g => g.keys);
  check(JSON.stringify(derivedKeys) === JSON.stringify(m.CHECK_ORDER.map(c => c.key)),
    'WIZARD_GROUPS covers every CHECK_ORDER key, in order');
  check(m.WIZARD_GROUPS.every(g => g.label && g.label.length >= 3), 'every wizard group has a display label');
  check(m.WIZARD_GROUPS[0].label === 'Administrator', 'App group presents as Administrator');
  check(m.WIZARD_GROUPS[1].label === 'Zoom Workplace', 'Zoom group presents as Zoom Workplace');

  // Fix-found headline follows the actual repairable count.
  check(m.wizardFixFoundTitle(1) === 'One fix found', 'single repairable -> "One fix found"');
  check(m.wizardFixFoundTitle(3) === '3 fixes found', 'multiple repairables -> "3 fixes found"');
  check(m.wizardFixFoundSub(['Helper account']) ===
        "The helper account needs repair. Your Zoom files and data won't be changed.",
    'single repairable sub is natural language + the one safety line');
  check(/need repair/.test(m.wizardFixFoundSub(['A', 'B'])), 'plural sub agrees in number');
  check(/won't be changed/.test(m.wizardFixFoundSub(['A', 'B'])), 'plural sub keeps the safety line');
  check(m.wizardFixFoundSub([]).length > 20, 'empty label list still yields real copy');

  // Blocked sub names the blockers; the empty case never goes silent.
  check(/Zoom Workplace needs your attention/.test(m.wizardBlockedSub(['Zoom Workplace'])),
    'blocked sub names the blocker');
  check(m.wizardBlockedSub([]).length > 40, 'blocked sub without labels still explains next steps');

  // State copy exists, is real copy, and never leans on raw codes.
  const wiz = m.WIZARD;
  const required = ['READY_TITLE', 'READY_SUB', 'UNKNOWN_TITLE', 'UNKNOWN_SUB', 'BLOCKED_TITLE',
    'ADMIN_TITLE', 'ADMIN_SUB', 'ADMIN_DECLINED_SUB', 'ADMIN_RESTARTING',
    'SUCCESS_TITLE', 'SUCCESS_SUB', 'PARTIAL_TITLE', 'PARTIAL_SUB', 'FAIL_TITLE',
    'SHORTCUT_NOT_READY_TITLE', 'SHORTCUT_NOT_READY_SUB', 'SHORTCUT_FAILED_TITLE',
    'SHORTCUT_FAILED_SUB', 'SHORTCUT_DONE_TITLE', 'SHORTCUT_DONE_SUB'];
  check(required.every(k => typeof wiz[k] === 'string' && wiz[k].length >= 5),
    'every wizard state has real copy');
  check(wiz.SHORTCUT_NOT_READY_SUB.includes('Run the repair once'),
    'shortcut-not-ready copy points at the repair as the next step');
  check(/unknown/i.test(wiz.UNKNOWN_SUB) && /not a pass/i.test(wiz.UNKNOWN_SUB),
    'unknown state stays honest: unknown is not a pass');
  check(/Advanced details/.test(wiz.PARTIAL_SUB), 'partial outcome points at Advanced details');

  // Self-elevation honesty: approval happens in the WINDOWS prompt, the
  // app never asks for a password, and a decline is reported as a decline.
  check(/Windows will ask for approval/.test(wiz.ADMIN_SUB), 'admin sub says Windows asks for approval');
  check(/Nothing has been changed/.test(wiz.ADMIN_SUB), 'admin sub states nothing changed yet');
  check(/declined|did not complete/.test(wiz.ADMIN_DECLINED_SUB), 'declined copy names the decline');
  check(/Run as administrator/.test(wiz.ADMIN_DECLINED_SUB), 'declined copy keeps the manual fallback');
}

console.log('messages-smoke: project disclosure (addendum 2026-08-23)');
{
  // Exact approved wording — byte-pinned, never reworded.
  check(m.DISCLOSURE.INDEPENDENCE === 'Independent project. Not affiliated with Zoom.',
    'independence disclosure is the exact approved wording');
  check(m.DISCLOSURE.OS_LABEL === 'Open Source', 'open-source label is exact');
  check(m.DISCLOSURE.ARIA.includes(m.DISCLOSURE.INDEPENDENCE) && !m.DISCLOSURE.ARIA.includes('·'),
    'accessible name carries the disclosure without the separator glyph');
  // No unsupported endorsement language anywhere in the catalog.
  const catalogText = JSON.stringify(m);
  for (const banned of ['Verified by Zoom', 'Zoom Certified', 'Zoom Partner', 'Official Zoom', 'endorsed by Zoom']) {
    check(!catalogText.includes(banned), `catalog never says "${banned}"`);
  }
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
