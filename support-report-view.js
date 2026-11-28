// ============================================================
// support-report-view.js — the state behind the Support Report window.
//
// renderer.js owns the DOM; this file owns the rules, so
// tools/support-report-view-smoke.js can test them in Node. Pure and
// DOM-free (same pattern as details-view.js). Loaded before renderer.js.
//
// Rules (1132 Fixer audit 2026-11-14, findings A12, A13, A14):
//   - A12: every open starts a new generation; closing ends it. A report
//     that arrives for an older generation is dropped, so it can never
//     overwrite a newer preview.
//   - A13: Copy works only on a current, complete report. While the
//     "Generating" text or the failure text shows, Copy is disabled and
//     refuses; it never says "Copied" for them.
//   - A14: a failed build shows fixed text from messages.js. The error
//     object is never passed to the text, so no message, path or user
//     name from it can reach the copyable report.
// ============================================================

function createSupportReportController(deps) {
  const {
    requestReport, failureText, copy: text,
    setText, setCopyEnabled, setStatus, writeClipboard, selectText
  } = deps;
  let generation = 0;
  let report = null; // the current, complete report, or null

  async function open(input) {
    const mine = ++generation;
    report = null;
    setCopyEnabled(false);
    setStatus('', '');
    setText(text.GENERATING);
    let markdown = null;
    try {
      const result = await requestReport(input);
      if (result && typeof result.markdown === 'string' && result.markdown) markdown = result.markdown;
    } catch (_) {
      // The error is deliberately not used (A14).
      markdown = null;
    }
    if (mine !== generation) return 'stale';
    if (markdown === null) {
      setText(failureText());
      return 'failed';
    }
    report = markdown;
    setText(markdown);
    setCopyEnabled(true);
    return 'ready';
  }

  function close() {
    generation++;
    report = null;
    setCopyEnabled(false);
  }

  async function copyReport() {
    if (report === null) {
      setStatus(text.NOT_READY, 'warning');
      return 'refused';
    }
    const current = report;
    const mine = generation;
    try {
      await writeClipboard(current);
      // The window may have closed or reopened during the write.
      if (mine !== generation) return 'stale';
      setStatus(text.COPIED, 'success');
      return 'copied';
    } catch (_) {
      if (mine !== generation) return 'stale';
      // Fallback: select the text so the person can copy it by hand.
      selectText();
      setStatus(text.COPY_BLOCKED, 'warning');
      return 'selected';
    }
  }

  return { open, close, copy: copyReport, isReady: () => report !== null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSupportReportController };
}
