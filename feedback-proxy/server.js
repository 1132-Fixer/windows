/**
 * 1132 Fixer — feedback proxy
 *
 * WHY THIS EXISTS
 * ---------------
 * The desktop app used to embed a GitHub PAT and POST issues to the API
 * directly. Anything embedded in an Electron app ships inside app.asar, which
 * stores file contents uncompressed — so the token was extractable from the
 * public installer in about a minute:
 *
 *     7za x 1132-Fixer-Portable-5.3.10.exe -oext
 *     grep -a "GH_ISSUES_TOKEN" ext/resources/app.asar
 *
 * Build-time injection did not fix that; it only kept the secret out of source
 * control. The token still shipped inside every build.
 *
 * This service holds the token server-side. The app posts plain JSON to a
 * PUBLIC url — a url is not a credential — so the client ships with no secret
 * at all, and there is nothing to extract, leak, or rotate.
 *
 * THREAT MODEL (what this does and does not buy)
 * ----------------------------------------------
 * The endpoint is public and unauthenticated, because any shared key we shipped
 * would be exactly as extractable as the token was. So an attacker can still
 * spam issues — the same worst case as the leaked token. What changes:
 *
 *   - The token itself is no longer obtainable, so it cannot be reused
 *     elsewhere and its blast radius cannot grow beyond "open an issue".
 *   - Abuse is throttled here (rate limit + size caps + field validation).
 *   - You can disable or patch instantly by redeploying — no client update,
 *     no rotation, no waiting for users to upgrade.
 *   - The client cannot choose labels or forge issue bodies; this builds them.
 *
 * Zero dependencies: Node's built-in http + global fetch (Node 18+).
 */
'use strict';

const http = require('http');

const PORT = process.env.PORT || 3000;
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

// --- Rate limiting (in-memory; adequate for a single instance) -------
const hits = new Map(); // ip -> number[] of timestamps

function rateLimited(ip, now) {
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// Bound memory: drop stale IP buckets periodically.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) hits.set(ip, live);
    else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// --- Helpers --------------------------------------------------------
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      // Once over the cap, keep draining but stop buffering. Do NOT destroy the
      // socket here: destroying it before the handler writes a response gives
      // the client a "socket hang up" instead of a clean 413.
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        chunks.length = 0;
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// Strip control characters (keep \n and \t), then cap length.
const CONTROL_CHARS = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', 'g');

function clean(v, max) {
  return String(v == null ? '' : v).replace(CONTROL_CHARS, '').slice(0, max).trim();
}

// --- Issue creation -------------------------------------------------
async function createIssue({ type, text, version, os }) {
  const label = TYPE_LABELS.get(type);
  const title = `[${type}] ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`;
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

// --- Server ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      // Report readiness without revealing whether the token is valid.
      return json(res, 200, {
        ok: true,
        service: '1132-fixer-feedback-proxy',
        configured: Boolean(TOKEN),
      });
    }

    if (req.method !== 'POST' || req.url !== '/feedback') {
      return json(res, 404, { ok: false, error: 'not_found' });
    }

    if (!TOKEN) {
      console.error('[feedback] GH_ISSUES_TOKEN not set — refusing');
      return json(res, 503, { ok: false, error: 'not_configured' });
    }

    const ip = clientIp(req);
    if (rateLimited(ip, Date.now())) {
      return json(res, 429, { ok: false, error: 'rate_limited' });
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
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
  } catch (err) {
    console.error('[feedback] unhandled: ' + (err && err.message));
    return json(res, 500, { ok: false, error: 'internal' });
  }
});

server.listen(PORT, () => {
  console.log(`[feedback-proxy] listening on :${PORT}`);
  console.log(`[feedback-proxy] repo=${REPO} token=${TOKEN ? 'present' : 'ABSENT (503s until set)'}`);
});
