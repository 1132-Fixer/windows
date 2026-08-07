/**
 * Legacy /feedback path — the original GitHub-issue proxy, moved here verbatim.
 *
 * WHY THIS EXISTS
 * ---------------
 * The desktop app used to embed a GitHub PAT and POST issues to the API
 * directly. Anything embedded in an Electron app ships inside app.asar, which
 * stores file contents uncompressed — so the token was extractable from the
 * public installer in about a minute. This service holds the token server-side;
 * the app posts plain JSON to a PUBLIC url and ships no secret at all.
 *
 * Installed clients depend on this exact contract. Do not change behavior here;
 * new capability goes in the /v1 support API instead.
 */
'use strict';

const { json, clientIp, readBody, clean, createRateLimiter } = require('./http');

const TOKEN = process.env.GH_ISSUES_TOKEN || '';
const REPO = process.env.GH_ISSUES_REPO || 'PrimeUpYourLife/1132-Fixer-Windows';

// --- Limits ---------------------------------------------------------
const MAX_BODY_BYTES = 8 * 1024;       // reject oversized payloads outright
const MAX_TEXT_CHARS = 4000;           // truncate long feedback rather than reject
const RATE_MAX = 5;                    // requests per window per IP
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// The client may only pick from this set; anything else is rejected. Stops the
// client inventing arbitrary labels on the issue tracker.
const TYPE_LABELS = new Map([
  ['Bug Report', 'bug-report'],
  ['Feature Request', 'feature-request'],
  ['User Rating', 'user-rating'],
  ['Feedback', 'feedback'],
  ['Contact', 'contact'],
]);

const limiter = createRateLimiter(RATE_MAX, RATE_WINDOW_MS);

// --- Issue creation -------------------------------------------------
async function createIssue({ type, text, version, os }) {
  const label = TYPE_LABELS.get(type);
  // Titles must be single-line: collapse newlines/whitespace from the excerpt
  // (clean() keeps \n in the body on purpose, but a multi-line title reads as
  // junk in the issue list and risks API rejection).
  const titleText = text.slice(0, 80).replace(/\s+/g, ' ').trim();
  const title = `[${type}] ${titleText}${text.length > 80 ? '...' : ''}`;
  const body =
    `**Type:** ${type}\n` +
    `**App Version:** ${version || 'unknown'}\n` +
    `**OS:** ${os || 'unknown'}\n\n` +
    `---\n\n${text}\n\n` +
    `<sub>Submitted via in-app feedback (feedback-proxy).</sub>`;

  const r = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': '1132-fixer-feedback-proxy',
    },
    body: JSON.stringify({ title, body, labels: [label] }),
  });

  if (r.status === 201) {
    const data = await r.json().catch(() => ({}));
    return { ok: true, number: data.number };
  }

  // Deliberately do NOT surface GitHub's response to the client — it can carry
  // repo or token detail. Log server-side, return something generic.
  const detail = await r.text().catch(() => '');
  console.error(`[feedback] github ${r.status}: ${detail.slice(0, 300)}`);
  return { ok: false, status: r.status };
}

async function handleFeedback(req, res) {
  if (!TOKEN) {
    console.error('[feedback] GH_ISSUES_TOKEN not set — refusing');
    return json(res, 503, { ok: false, error: 'not_configured' });
  }

  const ip = clientIp(req);
  if (limiter.limited(ip, Date.now())) {
    return json(res, 429, { ok: false, error: 'rate_limited' });
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'));
  } catch (e) {
    if (e && e.code === 413) return json(res, 413, { ok: false, error: 'too_large' });
    return json(res, 400, { ok: false, error: 'bad_json' });
  }

  const type = clean(payload.type, 40);
  const text = clean(payload.text, MAX_TEXT_CHARS);
  const version = clean(payload.version, 20);
  const os = clean(payload.os, 60);

  if (!TYPE_LABELS.has(type)) return json(res, 400, { ok: false, error: 'bad_type' });
  if (!text) return json(res, 400, { ok: false, error: 'empty_text' });

  const result = await createIssue({ type, text, version, os });
  if (result.ok) return json(res, 201, { ok: true, number: result.number });
  return json(res, 502, { ok: false, error: 'upstream_failed' });
}

module.exports = {
  handleFeedback,
  configured: () => Boolean(TOKEN),
  repo: () => REPO,
};
