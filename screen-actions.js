// ============================================================
// screen-actions.js — the explicit action map for every screen.
//
// One table says which controls may be visible on which screen. The
// renderer still decides, per outcome, which of the ALLOWED controls it
// wants (setActions); this module is the gate that hides everything
// else. A control that belongs to another screen can therefore never
// leak through a stale flag, a reused slot or a forgotten reset — it
// is not on the allowlist, so it is hidden.
//
// Loaded as a plain browser script before compact-shell.js and
// renderer.js, and require()-able from tools/ (same pattern as
// ui-state.js and messages.js), so tools/screen-actions-smoke.js can
// assert the map without a DOM.
//
// Screens are the compact states the shell derives on <body
// data-compact-state> plus the Details view, which sits over any state.
// ============================================================

// Every control the gate manages, by element id. Anything interactive in
// the header, action area or details region must be listed here; an id
// that is not listed is not governed and must not exist on those surfaces.
const MANAGED_CONTROLS = Object.freeze([
  // header
  'backBtn', 'btnExit',
  // primary action slot
  'elevateBtn', 'fixBtn', 'launchBtn', 'shortcutBtn',
  // repair option
  'shortcutOpt',
  // secondary row
  'cancelFixBtn', 'doneBtn', 'rescanBtn', 'closeBtn', 'detailsBtn', 'supportBtn', 'copyErrBtn',
  // Zoom recovery card (blocked screen only)
  'zrDownloadBtn', 'zrRecheckBtn', 'zrChooseBtn', 'zrCancelBtn',
  // details view
  'detailsOverviewBtn'
]);

// Controls every screen shares.
const COMMON = ['btnExit'];

// Screen -> allowed control ids. Order is documentation only; visual order
// is the markup order in index.html.
const SCREEN_CONTROLS = Object.freeze({
  // Checking: nothing to act on yet. Exit only.
  checking:   Object.freeze([...COMMON]),
  // Ready: the one primary, its option, and the details disclosure.
  ready:      Object.freeze([...COMMON, 'fixBtn', 'shortcutOpt', 'detailsBtn']),
  // Blocked / action required: the elevation or recovery path plus a
  // re-check. Fix now is never offered here.
  blocked:    Object.freeze([...COMMON, 'elevateBtn', 'rescanBtn', 'closeBtn', 'detailsBtn',
                             'zrDownloadBtn', 'zrRecheckBtn', 'zrChooseBtn', 'zrCancelBtn']),
  // Fixing / cancelling: cooperative cancel and the details disclosure.
  fixing:     Object.freeze([...COMMON, 'cancelFixBtn', 'detailsBtn']),
  cancelling: Object.freeze([...COMMON, 'cancelFixBtn', 'detailsBtn']),
  // Cancelled: try again, or read what happened.
  cancelled:  Object.freeze([...COMMON, 'fixBtn', 'detailsBtn']),
  // Complete (verified success): Open Zoom is allowed here and nowhere
  // before it. The shortcut control appears only when the shortcut step
  // did not complete.
  success:    Object.freeze([...COMMON, 'launchBtn', 'shortcutBtn', 'doneBtn', 'rescanBtn', 'detailsBtn']),
  // Unable: retry, support, copy details, close.
  error:      Object.freeze([...COMMON, 'fixBtn', 'rescanBtn', 'closeBtn', 'supportBtn', 'copyErrBtn', 'detailsBtn']),
  // Notice (finished with items to attend to, shortcut states): the
  // renderer picks among these per outcome.
  notice:     Object.freeze([...COMMON, 'fixBtn', 'launchBtn', 'shortcutBtn', 'rescanBtn', 'closeBtn',
                             'supportBtn', 'detailsBtn']),
  // Details view: an overlay on any state. While it is open the wizard and
  // the action area are hidden as containers (their controls keep the
  // renderer's flags, so Back restores the state exactly) and these are
  // the only additional controls: Back in the header and the overview
  // switch when a category is open. Never a primary action, never Explore.
  details:    Object.freeze(['backBtn', 'detailsOverviewBtn'])
});

const SCREENS = Object.freeze(Object.keys(SCREEN_CONTROLS));
const VIEW_DETAILS = 'details';

function isScreen(name) {
  return Object.prototype.hasOwnProperty.call(SCREEN_CONTROLS, name);
}

// The allowlist for a state, optionally with the Details overlay open.
function allowedControls(screen, view) {
  const base = isScreen(screen) && screen !== VIEW_DETAILS ? SCREEN_CONTROLS[screen] : SCREEN_CONTROLS.checking;
  return view === VIEW_DETAILS ? base.concat(SCREEN_CONTROLS.details) : base;
}

function isAllowed(screen, controlId, view) {
  return allowedControls(screen, view).indexOf(controlId) !== -1;
}

// Apply the gate to a document. Hides every managed control the screen
// does not allow; never reveals anything (that stays the renderer's call).
// Returns the ids it hid, for tests and logging.
function applyScreenControls(screen, doc, view) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return [];
  const allowed = allowedControls(screen, view);
  const hid = [];
  for (const id of MANAGED_CONTROLS) {
    if (allowed.indexOf(id) !== -1) continue;
    const el = d.getElementById(id);
    if (el && !el.hidden) {
      el.hidden = true;
      hid.push(id);
    }
  }
  return hid;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MANAGED_CONTROLS,
    SCREEN_CONTROLS,
    SCREENS,
    VIEW_DETAILS,
    isScreen,
    allowedControls,
    isAllowed,
    applyScreenControls
  };
}
