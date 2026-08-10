/**
 * Support-framework test suite (node script, no framework — test.js style),
 * aligned to the final build directive incl. its §15 test list.
 *
 * Needs a throwaway Postgres via TEST_DATABASE_URL; without it the suite
 * SKIPS with exit 0. All Discord and GitHub traffic is stubbed through
 * global.fetch — nothing external is ever called. Tables are TRUNCATEd at
 * start: point this at a scratch database only.
 *
 * Exits 0 on PASS/SKIP, 1 on FAIL.
 */
'use strict';

if (!process.env.TEST_DATABASE_URL) {
  console.log('SKIPPED no TEST_DATABASE_URL');
  process.exit(0);
}

const crypto = require('crypto');
const http = require('http');
const { execFileSync } = require('child_process');
const path = require('path');

const PORT = 39118;
process.env.PORT = String(PORT);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SUPPORT_V2_ENABLED = 'true';
process.env.GH_ISSUES_TOKEN = 'not-a-token__1132-fixer-test-fixture__no-credential-here';
process.env.TOKEN_HASH_PEPPER = 'test-pepper';
process.env.DISCORD_ENABLED = 'false'; // worker must NOT dispatch: proves rows persist
process.env.DISCORD_BOT_TOKEN = 'FAKE_DISCORD_BOT_TOKEN';
process.env.DISCORD_GUILD_ID = 'guild-1';
process.env.DISCORD_SUPPORT_FORUM_ID = 'forum-1';
process.env.DISCORD_SUPPORT_ROLE_IDS = 'staff-role-1,staff-role-2';
process.env.DISCORD_LIVE_RATING_CHANNEL_ID = 'rating-chan-1';

// Real ed25519 keypair so signature verification is exercised end to end.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
process.env.DISCORD_PUBLIC_KEY = publicKey
  .export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

// --- Stub every external fetch BEFORE the server loads ---------------
const fetchCalls = [];
let threadCounter = 0;
let failNextThreadPost = false; // simulates an archived thread once
let failNextRoleAlert = false;  // simulates a role-alert failure once
global.fetch = async (url, opts) => {
  const u = String(url);
  const call = { url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body };
  fetchCalls.push(call);
  const respond = (status, obj) => ({
    ok: status < 400, status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  if (u.includes('api.github.com')) return respond(201, { number: 4242 });
  if (u.includes('/threads')) {
    threadCounter += 1;
    return respond(201, { id: 'thread-' + threadCounter });
  }
  if (failNextRoleAlert && call.body && call.body.includes('<@&')) {
    failNextRoleAlert = false;
    return respond(403, { message: 'Missing permissions' });
  }
  if (call.method === 'PATCH') return respond(200, { id: 'card-1' });
  if (u.includes('/messages')) {
    if (!u.includes('rating-chan-1') && failNextThreadPost) {
      failNextThreadPost = false;
      return respond(403, { message: 'Thread is archived' });
    }
    return respond(200, { id: u.includes('rating-chan-1') ? 'card-1' : 'tmsg-' + fetchCalls.length });
  }
  return respond(404, { error: 'unstubbed ' + u });
};

const { ready } = require('./server.js');
const db = require('./lib/db');
const outbox = require('./lib/outbox');
const { publicRatingBody } = require('./lib/ratings');

// --- helpers ---------------------------------------------------------
function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign(
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      headers || {}
    );
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: h }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: s, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** Like req(), but exposes the response headers (for CORS assertions). */
function rawReq(method, path, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: headers || {} },
      (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s }));
      });
    r.on('error', reject);
    r.end();
  });
}

/** Open an SSE stream and keep it open; used to test the per-principal cap. */
function sseOpen(path, headers) {
  return new Promise((resolve, reject) => {
    const handle = { closed: false, destroy: () => handle.req.destroy() };
    handle.req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => { handle.closed = true; });
        res.on('close', () => { handle.closed = true; });
        // Give the server a moment to close an over-cap older stream.
        setTimeout(() => resolve(handle), 120).unref();
      });
    handle.req.on('error', () => { handle.closed = true; });
    handle.req.end();
    setTimeout(() => reject(new Error('sse open timeout')), 4000).unref();
  });
}

/** Read an SSE stream until the first complete event, then hang up. */
function sseFirstEvent(path, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('event: unread') && buf.includes('\n\n')) {
          resolve({ status: res.statusCode, contentType: res.headers['content-type'], head: buf });
          r.destroy();
        }
      });
      res.on('error', () => {});
    });
    r.on('error', () => {}); // destroy() after resolve triggers a reset; promise already settled
    r.end();
    setTimeout(() => { r.destroy(); reject(new Error('sse timeout')); }, 4000).unref();
  });
}

const bearer = (p, extra) => Object.assign({ Authorization: `Bearer ${p.token}` }, extra || {});
const idem = (key) => ({ 'Idempotency-Key': key });

let interactionCounter = 0;
function signedInteraction(interaction, opts) {
  if (!interaction.id) interaction.id = 'int-' + (++interactionCounter);
  const raw = JSON.stringify(interaction);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = (opts && opts.badSignature)
    ? crypto.randomBytes(64).toString('hex')
    : crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(raw)]), privateKey).toString('hex');
  return req('POST', '/v1/discord/interactions', raw, {
    'x-signature-ed25519': sig,
    'x-signature-timestamp': ts,
  });
}

const staffMember = { roles: ['staff-role-1', 'other-role'], user: { id: 'staff-user-1' } };
const button = (customId, over) => Object.assign({
  type: 3, guild_id: 'guild-1', member: staffMember,
  data: { component_type: 2, custom_id: customId },
}, over);

async function count(sql, params) {
  return Number((await db.query(sql, params)).rows[0].count);
}

const CASE_RE = /^FX-[A-Z2-9]{6,12}$/;
const scores = (over) => Object.assign({ ease: 5, resolved: 5, recommend: 5, overall: 5 }, over);

// --- suite -----------------------------------------------------------
const S = {}; // shared state across ordered checks
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('healthz alive; readyz ready; health keeps legacy shape + db field', async () => {
  const hz = await req('GET', '/healthz');
  const rz = await req('GET', '/readyz');
  const h = await req('GET', '/health');
  return hz.status === 200 && rz.status === 200 && rz.json.migrations === 'applied' &&
    ['running', 'starting'].includes(rz.json.worker) &&
    h.status === 200 && h.json.ok === true && h.json.configured === true && h.json.db === 'ok';
});

check('legacy /feedback still works with v2 mounted', async () => {
  const r = await req('POST', '/feedback', { type: 'Feedback', text: 'legacy path alive' });
  return r.status === 201 && r.json.number === 4242;
});

check('standard error shape: code + message + requestId', async () => {
  const r = await req('GET', '/v1/my-messages');
  return r.status === 401 && r.json.error && r.json.error.code === 'unauthorized' &&
    typeof r.json.error.message === 'string' && /^req_/.test(r.json.error.requestId);
});

check('principals: IN-… id + one-time token; UPPER products only', async () => {
  const a = await req('POST', '/v1/principals',
    { product: 'WINDOWS', appVersion: '5.5.1' }, { 'x-forwarded-for': '10.1.0.1' });
  const b = await req('POST', '/v1/principals',
    { product: 'WINDOWS', appVersion: '5.5.1' }, { 'x-forwarded-for': '10.1.0.2' });
  const c = await req('POST', '/v1/principals',
    { product: 'CHROME', appVersion: '1.2.1' }, { 'x-forwarded-for': '10.1.0.3' });
  const bad = await req('POST', '/v1/principals',
    { product: 'windows', appVersion: '1' }, { 'x-forwarded-for': '10.1.0.4' });
  S.A = a.json; S.B = b.json; S.C = c.json;
  return a.status === 201 && /^IN-[A-Z2-9]{10,20}$/.test(a.json.principalId) &&
    /^[0-9a-f]{64}$/.test(a.json.token) && b.status === 201 && c.status === 201 &&
    bad.status === 400 && bad.json.error.code === 'validation_failed';
});

check('token stored only as hash; tampered token -> 401', async () => {
  const { rows } = await db.query('SELECT token_hash FROM support_principals');
  const tampered = await req('GET', '/v1/my-messages', undefined,
    { Authorization: 'Bearer ' + '0'.repeat(64) });
  return rows.length === 3 &&
    rows.every((r) => Buffer.isBuffer(r.token_hash) && r.token_hash.length === 32) &&
    tampered.status === 401;
});

check('case create: same key + same body -> SAME random FX case, one row', async () => {
  const missing = await req('POST', '/v1/cases',
    { type: 'bug', title: 'x y z', description: 'd' }, bearer(S.A));
  const body = {
    type: 'bug', title: 'Fix **stops** during preflight',
    description: 'The scan completes, but Fix stays disabled after preflight.',
    impact: 'A main feature is blocked', os: 'Windows 11 · 10.0.26200', appVersion: '5.5.1',
  };
  const first = await req('POST', '/v1/cases', body, bearer(S.A, idem('K1')));
  const retry = await req('POST', '/v1/cases', body, bearer(S.A, idem('K1')));
  S.case1 = first.json.caseRef;
  return missing.status === 400 && missing.json.error.code === 'missing_idempotency_key' &&
    first.status === 201 && CASE_RE.test(S.case1) && first.json.state === 'new' &&
    retry.status === 201 && retry.json.caseRef === S.case1 &&
    (await count('SELECT count(*) FROM support_cases')) === 1;
});

check('same key + DIFFERENT body -> 409 idempotency_conflict', async () => {
  const r = await req('POST', '/v1/cases',
    { type: 'bug', title: 'something else', description: 'other' }, bearer(S.A, idem('K1')));
  return r.status === 409 && r.json.error.code === 'idempotency_conflict';
});

check("'Contact' temporarily maps to feedback in the new API", async () => {
  const r = await req('POST', '/v1/cases',
    { type: 'Contact', title: 'Question about the fix', description: 'how does it work?' },
    bearer(S.A, idem('K3')));
  S.case3 = r.json.caseRef;
  const second = await req('POST', '/v1/cases',
    { type: 'bug', title: 'Second bug here', description: 'details' }, bearer(S.A, idem('K2')));
  S.case2 = second.json.caseRef;
  return r.status === 201 && r.json.kind === 'feedback' &&
    second.status === 201 && S.case2 !== S.case1 && CASE_RE.test(S.case2);
});

check('outbox rows committed in the SAME tx (worker off -> rows pending)', async () => {
  return (await count(
    "SELECT count(*) FROM outbox WHERE event_type = 'case.created' AND state = 'pending'")) === 3;
});

check('rating validation strict: -1, 6, fraction, string, missing all 400', async () => {
  const h = bearer(S.B, idem('RX'));
  const probes = [
    await req('POST', '/v1/ratings', scores({ overall: -1 }), h),
    await req('POST', '/v1/ratings', scores({ ease: 6 }), h),
    await req('POST', '/v1/ratings', scores({ recommend: 3.5 }), h),
    await req('POST', '/v1/ratings', scores({ resolved: '4' }), h),
    await req('POST', '/v1/ratings', { ease: 5, recommend: 5, overall: 5 }, h), // resolved unanswered
    await req('POST', '/v1/ratings', scores({ overall: null }), h),
  ];
  return probes.every((r) => r.status === 400 && r.json.error.code === 'validation_failed');
});

check('DIRECTIVE: 0 is a REAL answer — accepted, and any 0-3 opens a case', async () => {
  const r = await req('POST', '/v1/ratings', scores({ ease: 0 }), bearer(S.B, idem('R1')));
  S.ratingCaseB = r.json.caseRef;
  const row = (await db.query('SELECT ease, overall FROM ratings')).rows[0];
  const kind = (await db.query(
    'SELECT kind FROM support_cases WHERE case_ref = $1', [S.ratingCaseB])).rows[0];
  return r.status === 200 && r.json.ratingSaved === true && CASE_RE.test(S.ratingCaseB) &&
    row.ease === 0 && row.overall === 5 && kind.kind === 'rating_feedback';
});

check('replace-not-add: re-rate updates the one row, count cannot grow', async () => {
  const r = await req('POST', '/v1/ratings', scores({}), bearer(S.B, idem('R2')));
  return r.status === 200 && r.json.caseRef === null && // all 4-5, no text -> silent
    (await count('SELECT count(*) FROM ratings')) === 1 &&
    (await count('SELECT count(*) FROM rating_revisions')) === 2 &&
    r.json.snapshot.count === 1;
});

check('DIRECTIVE: all 4-5 and no text -> receipt only, NO case, NO alert', async () => {
  const casesBefore = await count('SELECT count(*) FROM support_cases');
  const alertsBefore = await count("SELECT count(*) FROM outbox WHERE event_type = 'case.created'");
  const r = await req('POST', '/v1/ratings', scores({ ease: 4, overall: 4 }), bearer(S.C, idem('R3')));
  return r.status === 200 && r.json.ratingSaved === true && r.json.caseRef === null &&
    (await count('SELECT count(*) FROM support_cases')) === casesBefore &&
    (await count("SELECT count(*) FROM outbox WHERE event_type = 'case.created'")) === alertsBefore;
});

check('DIRECTIVE: all 5s WITH text -> exactly one case, retry never re-pings', async () => {
  const body = Object.assign(scores({}), { comment: 'love it, but one question' });
  const first = await req('POST', '/v1/ratings', body, bearer(S.C, idem('R4')));
  const retry = await req('POST', '/v1/ratings', body, bearer(S.C, idem('R4')));
  S.ratingCaseC = first.json.caseRef;
  return first.status === 200 && CASE_RE.test(S.ratingCaseC) &&
    retry.json.caseRef === S.ratingCaseC &&
    (await count("SELECT count(*) FROM support_cases WHERE kind = 'rating_feedback'")) === 2 &&
    (await count("SELECT count(*) FROM outbox WHERE event_type = 'case.created' AND payload->>'case_ref' = $1",
      [S.ratingCaseC])) === 1;
});

check('current: average and count separate; product split; window documented', async () => {
  const all = await req('GET', '/v1/ratings/current');
  const windows = await req('GET', '/v1/ratings/current?product=WINDOWS');
  const chrome = await req('GET', '/v1/ratings/current?product=CHROME');
  const badProduct = await req('GET', '/v1/ratings/current?product=LINUX');
  return all.status === 200 && all.json.average === 5 && all.json.count === 2 &&
    all.json.state === 'NOT_ENOUGH_RATINGS' && all.json.verified === true &&
    all.json.window === '90d' && all.json.minimumSample === 10 && all.json.updatedAt &&
    windows.json.count === 1 && chrome.json.count === 1 &&
    badProduct.status === 400;
});

check('contract unit: count rendering 0/1/43/1000; average never concatenates', async () => {
  const now = new Date().toISOString();
  const zero = publicRatingBody({ average: null, count: 0, generatedAt: now });
  const one = publicRatingBody({ average: 5, count: 1, generatedAt: now });
  const c43 = publicRatingBody({ average: 4.3333, count: 43, generatedAt: now });
  const kilo = publicRatingBody({ average: 4.55, count: 1000, generatedAt: now });
  const j43 = JSON.stringify(c43);
  return zero.average === null && zero.count === 0 && zero.state === 'NOT_ENOUGH_RATINGS' &&
    one.average === 5 && one.count === 1 &&
    c43.average === 4.3 && c43.count === 43 &&
    typeof c43.average === 'number' && typeof c43.count === 'number' &&
    j43.includes('"average":4.3') && j43.includes('"count":43') && !j43.includes('4.343') &&
    kilo.average === 4.6 && kilo.count === 1000 && kilo.state === 'VERIFIED';
});

check('contract unit: STALE and UNAVAILABLE states', async () => {
  const stale = publicRatingBody({
    average: 4.5, count: 12, generatedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
  });
  const down = publicRatingBody({ average: null, count: 0, error: true });
  return stale.state === 'STALE' && stale.average === 4.5 &&
    down.state === 'UNAVAILABLE' && down.verified === false && down.average === null;
});

check('interactions: invalid signature -> 401 before any parsing; PING -> PONG', async () => {
  const bad = await signedInteraction(button(`resolve:${S.case1}`), { badSignature: true });
  const noHeaders = await req('POST', '/v1/discord/interactions', JSON.stringify({ type: 1 }));
  const ping = await signedInteraction({ type: 1 });
  return bad.status === 401 && noHeaders.status === 401 && ping.json.type === 1;
});

check('wrong guild + non-staff denied — custom_id is not authorization', async () => {
  const wrongGuild = await signedInteraction(button(`resolve:${S.case1}`, { guild_id: 'evil-guild' }));
  const nonStaff = await signedInteraction(button(`resolve:${S.case1}`,
    { member: { roles: ['random-role'], user: { id: 'rando' } } }));
  const { rows } = await db.query('SELECT state FROM support_cases WHERE case_ref = $1', [S.case1]);
  return wrongGuild.json.data.content === 'Not authorized.' &&
    nonStaff.json.data.content === 'Not authorized.' && rows[0].state === 'new';
});

check('stub buttons acknowledged: assign / diagnostics / more actions', async () => {
  const assign = await signedInteraction(button(`assign:${S.case1}`));
  const diag = await signedInteraction(button(`diag:${S.case1}`));
  const more = await signedInteraction(button(`more:${S.case1}`));
  return [assign, diag, more].every((r) =>
    r.status === 200 && r.json.data.content.includes('not implemented'));
});

check('Reply button -> modal carrying the CURRENT control epoch', async () => {
  const r = await signedInteraction(button(`reply:${S.case1}`));
  return r.status === 200 && r.json.type === 9 &&
    r.json.data.custom_id === `reply_modal:${S.case1}:1`;
});

check('modal submit: staff reply + waiting_for_user + epoch bump + receipt', async () => {
  const r = await signedInteraction({
    type: 5, guild_id: 'guild-1', member: staffMember, id: 'int-modal-1',
    data: {
      custom_id: `reply_modal:${S.case1}:1`,
      components: [
        { type: 1, components: [{ type: 4, custom_id: 'message', value: 'Please send the preflight log.' }] },
        { type: 1, components: [{ type: 4, custom_id: 'status', value: 'waiting' }] },
      ],
    },
  });
  const c = (await db.query('SELECT state, control_epoch FROM support_cases WHERE case_ref = $1', [S.case1])).rows[0];
  return r.status === 200 && r.json.data.content.includes('Reply queued') &&
    c.state === 'waiting_for_user' && c.control_epoch === 2 &&
    (await count("SELECT count(*) FROM case_messages WHERE author = 'staff'")) === 1 &&
    (await count("SELECT count(*) FROM inbox_receipts WHERE state = 'AVAILABLE'")) === 1;
});

check('same interaction id replayed -> no second reply', async () => {
  const r = await signedInteraction({
    type: 5, guild_id: 'guild-1', member: staffMember, id: 'int-modal-1',
    data: {
      custom_id: `reply_modal:${S.case1}:1`,
      components: [{ type: 1, components: [{ type: 4, custom_id: 'message', value: 'dup' }] }],
    },
  });
  return r.json.data.content === 'Already handled.' &&
    (await count("SELECT count(*) FROM case_messages WHERE author = 'staff'")) === 1;
});

check('DIRECTIVE: stale control epoch rejected', async () => {
  const r = await signedInteraction({
    type: 5, guild_id: 'guild-1', member: staffMember,
    data: {
      custom_id: `reply_modal:${S.case1}:1`, // current epoch is 2
      components: [{ type: 1, components: [{ type: 4, custom_id: 'message', value: 'stale' }] }],
    },
  });
  return r.json.data.content.includes('changed since') &&
    (await count("SELECT count(*) FROM case_messages WHERE author = 'staff'")) === 1;
});

check('my-messages: staff reply listed; AVAILABLE -> NOTIFIED on list', async () => {
  const unread1 = await req('GET', '/v1/my-messages/unread-count', undefined, bearer(S.A));
  const list = await req('GET', '/v1/my-messages', undefined, bearer(S.A));
  const m = list.json.messages.find((x) => x.caseRef === S.case1);
  S.staffMsgId = m && m.messageId;
  const after = (await db.query(
    "SELECT r.state FROM inbox_receipts r JOIN case_messages m ON m.id = r.message_id " +
      "WHERE m.public_id = $1", [S.staffMsgId])).rows[0];
  return unread1.json.unread === 1 && list.json.unread === 1 &&
    /^MS-[A-Z2-9]{8,16}$/.test(S.staffMsgId) && m.author === 'staff' &&
    m.body === 'Please send the preflight log.' && after.state === 'NOTIFIED';
});

check('DIRECTIVE: internal note never appears in My Messages', async () => {
  const { rows } = await db.query('SELECT id FROM support_cases WHERE case_ref = $1', [S.case1]);
  await db.query(
    "INSERT INTO internal_notes (case_id, staff_discord_user_id, body) VALUES ($1, 'staff-user-1', 'INTERNAL-SECRET-NOTE')",
    [rows[0].id]
  );
  const list = await req('GET', '/v1/my-messages', undefined, bearer(S.A));
  const unread = await req('GET', '/v1/my-messages/unread-count', undefined, bearer(S.A));
  return !list.body.includes('INTERNAL-SECRET-NOTE') && unread.json.unread === 1;
});

check('read: NOTIFIED -> READ; unread drops to 0; repeat read is a no-op', async () => {
  const r = await req('POST', `/v1/my-messages/${S.staffMsgId}/read`, {}, bearer(S.A));
  const again = await req('POST', `/v1/my-messages/${S.staffMsgId}/read`, {}, bearer(S.A));
  const unread = await req('GET', '/v1/my-messages/unread-count', undefined, bearer(S.A));
  return r.status === 200 && r.json.state === 'READ' && again.status === 200 &&
    unread.json.unread === 0;
});

check('SSE: events stream opens and delivers the unread count', async () => {
  const r = await sseFirstEvent('/v1/my-messages/events', bearer(S.A));
  return r.status === 200 && String(r.contentType).includes('text/event-stream') &&
    r.head.includes('event: unread') && r.head.includes('"unread":0');
});

check('user reply: waiting_for_user -> in_review; receipts flip REPLIED', async () => {
  const r = await req('POST', `/v1/cases/${S.case1}/messages`,
    { body: 'log attached here' }, bearer(S.A, idem('M2')));
  const receipt = (await db.query(
    "SELECT r.state FROM inbox_receipts r JOIN case_messages m ON m.id = r.message_id " +
      "JOIN support_cases c ON c.id = m.case_id WHERE c.case_ref = $1 AND m.author = 'staff'",
    [S.case1])).rows[0];
  return r.status === 201 && r.json.state === 'in_review' && receipt.state === 'REPLIED';
});

check('resolve button -> resolved; user reply reopens', async () => {
  // Controls carry the epoch they were rendered with.
  const epoch = (await db.query(
    'SELECT control_epoch FROM support_cases WHERE case_ref = $1', [S.case1])).rows[0].control_epoch;
  const r = await signedInteraction(button(`resolve:${S.case1}:${epoch}`));
  const reply = await req('POST', `/v1/cases/${S.case1}/messages`,
    { body: 'still broken after the fix' }, bearer(S.A, idem('M3')));
  return r.json.data.content.includes('resolved') && reply.status === 201 &&
    reply.json.state === 'reopened';
});

check('spam locks the case for users (409 case_locked)', async () => {
  await db.query("UPDATE support_cases SET state = 'spam' WHERE case_ref = $1", [S.case2]);
  const r = await req('POST', `/v1/cases/${S.case2}/messages`,
    { body: 'hello?' }, bearer(S.A, idem('M4')));
  return r.status === 409 && r.json.error.code === 'case_locked';
});

check('every transition wrote a case_events audit row', async () => {
  return (await count(
    "SELECT count(*) FROM case_events WHERE event_type = 'state.changed'")) >= 4;
});

check('worker off: every Discord-bound row still pending, zero Discord calls', async () => {
  const pending = await count("SELECT count(*) FROM outbox WHERE state = 'pending'");
  const discordCalls = fetchCalls.filter((c) => c.url.includes('discord.com'));
  return pending >= 10 && discordCalls.length === 0;
});

check('flag on: worker drains outbox; bindings saved; card upserted', async () => {
  process.env.DISCORD_ENABLED = 'true';
  for (let i = 0; i < 4; i++) await outbox.tick();
  const pending = await count("SELECT count(*) FROM outbox WHERE state IN ('pending', 'failed')");
  const bindings = await count('SELECT count(*) FROM discord_case_bindings');
  const forumPosts = fetchCalls.filter((c) => c.url.includes('/channels/forum-1/threads'));
  const cardCalls = fetchCalls.filter((c) => c.url.includes('rating-chan-1'));
  return pending === 0 && bindings === 5 && forumPosts.length === 5 && cardCalls.length >= 1;
});

check('forum posts use Components V2, all five controls, escaped markdown', async () => {
  const posts = fetchCalls
    .filter((c) => c.url.includes('/channels/forum-1/threads'))
    .map((c) => JSON.parse(c.body));
  const k1 = posts.find((p) => p.name.startsWith(S.case1));
  const componentsJson = JSON.stringify(k1.message.components);
  const texts = k1.message.components[0].components
    .map((c) => c.content || '').join('\n');
  return posts.length === 5 && posts.every((p) =>
    p.message.flags === 32768 && !p.message.content && !p.message.embeds) &&
    ['reply:', 'assign:', 'diag:', 'resolve:', 'more:'].every((a) =>
      componentsJson.includes(`"custom_id":"${a}${S.case1}:`)) && // epoch-suffixed
    texts.includes('\\*\\*stops\\*\\*'); // user's ** arrives markdown-escaped
});

check('role alert: exactly once per case, single-role allowlist, never re-pinged', async () => {
  const alerts = fetchCalls.filter((c) =>
    c.url.includes('discord.com') && c.body && c.body.includes('<@&'));
  return alerts.length === 5 && alerts.every((c) => {
    const b = JSON.parse(c.body);
    return b.allowed_mentions.parse.length === 0 &&
      JSON.stringify(b.allowed_mentions.roles) === '["staff-role-1"]';
  });
});

check('DIRECTIVE: archived thread does not block or lose a user reply', async () => {
  const r = await req('POST', `/v1/cases/${S.case1}/messages`,
    { body: 'one more detail' }, bearer(S.A, idem('M5')));
  failNextThreadPost = true; // Discord refuses the archived thread once
  await outbox.tick();
  const failed = await count("SELECT count(*) FROM outbox WHERE state = 'failed'");
  await db.query("UPDATE outbox SET available_at = now() WHERE state = 'failed'"); // skip backoff
  await outbox.tick();
  const pending = await count("SELECT count(*) FROM outbox WHERE state IN ('pending', 'failed')");
  return r.status === 201 && failed === 1 && pending === 0 &&
    (await count("SELECT count(*) FROM case_messages WHERE body = 'one more detail'")) === 1;
});

// --- regression checks for the adversarial review findings -----------

check('REVIEW#1: same key + identical body across principals does not collide', async () => {
  // The cross-principal UNIQUE (key, request_digest) is gone; both principals
  // must succeed independently with a shared key and byte-identical body.
  const body = { type: 'feedback', title: 'Shared key probe', description: 'identical body' };
  const a = await req('POST', '/v1/cases', body, bearer(S.A, idem('SHARED-KEY')));
  const b = await req('POST', '/v1/cases', body, bearer(S.B, idem('SHARED-KEY')));
  return a.status === 201 && b.status === 201 && a.json.caseRef !== b.json.caseRef;
});

check('REVIEW#2: a key reused after expiry is reclaimed, not a permanent 500', async () => {
  const body = { type: 'feedback', title: 'Expiry reclaim probe', description: 'first use' };
  const first = await req('POST', '/v1/cases', body, bearer(S.A, idem('EXPIRING')));
  // Age the stored record past its retention window.
  await db.query(
    "UPDATE idempotency_requests SET expires_at = now() - interval '1 hour' WHERE key = 'EXPIRING'");
  const second = await req('POST', '/v1/cases',
    { type: 'feedback', title: 'Expiry reclaim probe', description: 'second use' },
    bearer(S.A, idem('EXPIRING')));
  return first.status === 201 && second.status === 201 &&
    second.json.caseRef !== first.json.caseRef; // reclaimed, not replayed
});

check('REVIEW#2b: worker tick purges long-expired idempotency rows', async () => {
  await db.query(
    "UPDATE idempotency_requests SET expires_at = now() - interval '2 hours' WHERE key = 'EXPIRING'");
  const before = await count("SELECT count(*) FROM idempotency_requests WHERE key = 'EXPIRING'");
  await outbox.tick();
  const after = await count("SELECT count(*) FROM idempotency_requests WHERE key = 'EXPIRING'");
  return before === 1 && after === 0;
});

check('REVIEW#3: per-principal case budget returns 429 (and does not touch others)', async () => {
  // Dedicated principal so the budget probe cannot couple to other checks.
  const flooder = (await req('POST', '/v1/principals',
    { product: 'WINDOWS', appVersion: '5.5.1' }, { 'x-forwarded-for': '10.1.0.9' })).json;
  let sawLimit = false;
  for (let i = 0; i < 40 && !sawLimit; i++) {
    const r = await req('POST', '/v1/cases',
      { type: 'feedback', title: 'Flood probe ' + i, description: 'flooding' },
      bearer(flooder, idem('FLOOD-' + i)));
    if (r.status === 429 && r.json.error.code === 'rate_limited') sawLimit = true;
  }
  const other = await req('GET', '/v1/cases', undefined, bearer(S.C));
  // Remove the probe's cases and their queued Discord work so this check
  // cannot perturb the outbox assertions that follow.
  await db.query(
    "DELETE FROM outbox WHERE payload->>'case_ref' IN " +
      '(SELECT case_ref FROM support_cases WHERE principal_id = ' +
      '(SELECT id FROM support_principals WHERE public_id = $1))',
    [flooder.principalId]
  );
  await db.query(
    'DELETE FROM support_cases WHERE principal_id = ' +
      '(SELECT id FROM support_principals WHERE public_id = $1)',
    [flooder.principalId]
  );
  return sawLimit && other.status === 200; // budget is per principal, not global
});

check('REVIEW#3b: concurrent SSE streams per principal are capped', async () => {
  const opened = [];
  for (let i = 0; i < 5; i++) opened.push(await sseOpen('/v1/my-messages/events', bearer(S.C)));
  const alive = opened.filter((s) => !s.closed).length;
  opened.forEach((s) => s.destroy());
  return alive <= 3;
});

check('REVIEW#4: role-alert failure never creates a second forum thread', async () => {
  const before = fetchCalls.filter((c) => c.url.includes('/threads')).length;
  const r = await req('POST', '/v1/cases',
    { type: 'bug', title: 'Alert failure probe', description: 'role alert will fail once' },
    bearer(S.A, idem('ALERTFAIL')));
  failNextRoleAlert = true;
  await outbox.tick();                       // post succeeds, alert 403s
  await db.query("UPDATE outbox SET available_at = now() WHERE state = 'failed'");
  await outbox.tick();                       // retry must reuse the thread
  const after = fetchCalls.filter((c) => c.url.includes('/threads')).length;
  const bindings = await count(
    'SELECT count(*) FROM discord_case_bindings b JOIN support_cases c ON c.id = b.case_id ' +
      'WHERE c.case_ref = $1', [r.json.caseRef]);
  const pending = await count("SELECT count(*) FROM outbox WHERE state IN ('pending','failed')");
  return after - before === 1 && bindings === 1 && pending === 0;
});

check('REVIEW#5: re-rating an open case appends the new content for staff', async () => {
  const msgsBefore = await count(
    'SELECT count(*) FROM case_messages m JOIN support_cases c ON c.id = m.case_id ' +
      'WHERE c.case_ref = $1', [S.ratingCaseB]);
  const r = await req('POST', '/v1/ratings',
    scores({ ease: 0, overall: 0, comment: 'it got much worse after the update' }),
    bearer(S.B, idem('R-RERATE')));
  const msgsAfter = await count(
    'SELECT count(*) FROM case_messages m JOIN support_cases c ON c.id = m.case_id ' +
      'WHERE c.case_ref = $1', [S.ratingCaseB]);
  const mirrored = await count(
    "SELECT count(*) FROM outbox WHERE event_type = 'message.created' " +
      "AND payload->>'case_ref' = $1", [S.ratingCaseB]);
  const evented = await count(
    "SELECT count(*) FROM case_events e JOIN support_cases c ON c.id = e.case_id " +
      "WHERE c.case_ref = $1 AND e.event_type = 'rating.updated'", [S.ratingCaseB]);
  return r.json.caseRef === S.ratingCaseB && msgsAfter === msgsBefore + 1 &&
    mirrored >= 1 && evented === 1;
});

check('REVIEW#6: ticks do not stack while one is in flight', async () => {
  const results = await Promise.all([outbox.tick(), outbox.tick(), outbox.tick()]);
  const pending = await count("SELECT count(*) FROM outbox WHERE state IN ('pending','failed')");
  return results.length === 3 && pending === 0;
});

check('REVIEW#6b: a stuck running row is reclaimed after its lease', async () => {
  await db.query(
    "INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, state, locked_at) " +
      "SELECT 'case', id, 'case.card.refresh', jsonb_build_object('case_id', id::text, 'case_ref', case_ref), " +
      "'running', now() - interval '10 minutes' FROM support_cases WHERE case_ref = $1",
    [S.case1]
  );
  await outbox.tick();
  const stuck = await count("SELECT count(*) FROM outbox WHERE state = 'running'");
  return stuck === 0;
});

check('REVIEW#7: a DB failure on SSE connect does not kill the process', async () => {
  // Force the pre-header unread query to fail; the request must error
  // cleanly and the server must still serve legacy /feedback afterwards.
  await db.query('ALTER TABLE inbox_receipts RENAME TO inbox_receipts_hidden');
  let status = 0;
  try {
    const r = await sseFirstEvent('/v1/my-messages/events', bearer(S.A));
    status = r.status;
  } catch { status = 0; }
  await db.query('ALTER TABLE inbox_receipts_hidden RENAME TO inbox_receipts');
  const alive = await req('POST', '/feedback', { type: 'Feedback', text: 'still alive' });
  return status !== 200 && alive.status === 201; // no SSE 200, process survived
});

check('REVIEW#8: stale resolve button is rejected; card refresh is enqueued', async () => {
  const epoch = (await db.query(
    'SELECT control_epoch FROM support_cases WHERE case_ref = $1', [S.case3])).rows[0].control_epoch;
  const stale = await signedInteraction(button(`resolve:${S.case3}:${epoch - 1}`));
  const stateAfterStale = (await db.query(
    'SELECT state FROM support_cases WHERE case_ref = $1', [S.case3])).rows[0].state;
  const fresh = await signedInteraction(button(`resolve:${S.case3}:${epoch}`));
  const refreshes = await count(
    "SELECT count(*) FROM outbox WHERE event_type = 'case.card.refresh' AND payload->>'case_ref' = $1",
    [S.case3]);
  return stale.json.data.content.includes('changed since') && stateAfterStale !== 'resolved' &&
    fresh.json.data.content.includes('resolved') && refreshes >= 1;
});

check('REVIEW#8b: refreshed card carries the new epoch and disables Resolve', async () => {
  await outbox.tick();
  const patches = fetchCalls.filter((c) => c.method === 'PATCH' && c.body && c.body.includes('resolve:'));
  const last = JSON.parse(patches[patches.length - 1].body);
  const j = JSON.stringify(last.components);
  const epoch = (await db.query(
    'SELECT control_epoch FROM support_cases WHERE case_ref = $1', [S.case3])).rows[0].control_epoch;
  return patches.length >= 1 && j.includes(`"custom_id":"resolve:${S.case3}:${epoch}"`) &&
    j.includes('"disabled":true') && j.includes('Resolved');
});

check('REVIEW#9: own case is listed, readable, and lands in My Messages at once', async () => {
  const created = await req('POST', '/v1/cases',
    { type: 'bug', title: 'Visible immediately', description: 'should appear in my messages' },
    bearer(S.C, idem('VISIBLE')));
  const ref = created.json.caseRef;
  const list = await req('GET', '/v1/cases', undefined, bearer(S.C));
  const one = await req('GET', `/v1/cases/${ref}`, undefined, bearer(S.C));
  const inboxList = await req('GET', '/v1/my-messages', undefined, bearer(S.C));
  const foreign = await req('GET', `/v1/cases/${ref}`, undefined, bearer(S.A));
  return list.json.cases.some((c) => c.caseRef === ref) &&
    one.status === 200 && one.json.messages.length === 2 &&
    one.json.messages[0].author === 'user' && one.json.messages[1].author === 'system' &&
    inboxList.json.messages.some((m) => m.caseRef === ref) &&
    foreign.status === 404;
});

check('REVIEW#9b: internal notes stay out of the case transcript too', async () => {
  const { rows } = await db.query('SELECT id FROM support_cases WHERE case_ref = $1', [S.case1]);
  await db.query(
    "INSERT INTO internal_notes (case_id, staff_discord_user_id, body) VALUES ($1, 'staff-user-1', 'TRANSCRIPT-SECRET')",
    [rows[0].id]
  );
  const one = await req('GET', `/v1/cases/${S.case1}`, undefined, bearer(S.A));
  return one.status === 200 && !one.body.includes('TRANSCRIPT-SECRET');
});

check('REVIEW#10: a FAILED interaction retried with the same id re-arms and applies', async () => {
  // A crash after recordInteraction leaves response_state='failed'. Discord
  // redelivers the SAME interaction id; the retry must apply, not dead-end
  // on 'Already handled.'
  const created = await req('POST', '/v1/cases',
    { type: 'bug', title: 'Retry re-arm probe', description: 'a failed attempt must be retryable' },
    bearer(S.C, idem('REARM')));
  const ref = created.json.caseRef;
  const row = (await db.query(
    'SELECT id, control_epoch FROM support_cases WHERE case_ref = $1', [ref])).rows[0];
  await db.query(
    'INSERT INTO discord_interactions (interaction_id, case_id, discord_user_id, action, response_state) ' +
      "VALUES ('int-rearm-1', $1, 'staff-user-1', 'resolve', 'failed')",
    [row.id]);
  const r = await signedInteraction(button(`resolve:${ref}:${row.control_epoch}`, { id: 'int-rearm-1' }));
  const after = (await db.query(
    "SELECT response_state FROM discord_interactions WHERE interaction_id = 'int-rearm-1'")).rows[0];
  const state = (await db.query(
    'SELECT state FROM support_cases WHERE case_ref = $1', [ref])).rows[0].state;
  return r.json.data.content.includes('resolved') && state === 'resolved' &&
    after.response_state === 'applied';
});

check('REVIEW#11: concurrent rating submits build a complete snapshot (no undercount)', async () => {
  // Two installs rate at the same moment; the advisory lock serializes the
  // snapshot rebuilds so the stored aggregate includes both rows.
  const p1 = (await req('POST', '/v1/principals',
    { product: 'WINDOWS', appVersion: '5.5.1' }, { 'x-forwarded-for': '10.2.0.1' })).json;
  const p2 = (await req('POST', '/v1/principals',
    { product: 'WINDOWS', appVersion: '5.5.1' }, { 'x-forwarded-for': '10.2.0.2' })).json;
  const [a, b] = await Promise.all([
    req('POST', '/v1/ratings', scores({}), bearer(p1, idem('CC1'))),
    req('POST', '/v1/ratings', scores({}), bearer(p2, idem('CC2'))),
  ]);
  const current = await req('GET', '/v1/ratings/current');
  const verified = await count("SELECT count(*) FROM ratings WHERE state = 'verified'");
  return a.status === 200 && b.status === 200 &&
    current.status === 200 && current.json.count === verified;
});

check('MINOR: fenced facts cannot be broken out of or forged', async () => {
  const r = await req('POST', '/v1/cases', {
    type: 'bug', title: 'Fence escape probe',
    description: 'body text',
    os: 'Windows\n```\nASSIGNED      admin', impact: 'back`tick',
  }, bearer(S.C, idem('FENCE')));
  await outbox.tick();
  const post = fetchCalls.filter((c) => c.url.includes('/threads')).pop();
  const block = JSON.parse(post.body).message.components[0].components
    .map((c) => c.content || '').find((t) => t.includes('ENVIRONMENT'));
  const lines = block.split('\n');
  const envLine = lines.find((l) => l.startsWith('ENVIRONMENT'));
  const diagLine = lines.find((l) => l.startsWith('DIAGNOSTICS'));
  // The fence itself is backticks; the injected values must carry none, and
  // the newline must not have forged an extra fact row.
  return r.status === 201 && !envLine.includes('`') && !diagLine.includes('`') &&
    !envLine.includes('```') && lines.filter((l) => l.startsWith('ASSIGNED')).length === 1 &&
    envLine.includes('ASSIGNED      admin'); // flattened onto the ENVIRONMENT line
});

check('MINOR: stale Discord signature timestamp is rejected', async () => {
  const interaction = { type: 1, id: 'int-stale-ts' };
  const raw = JSON.stringify(interaction);
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(oldTs), Buffer.from(raw)]), privateKey)
    .toString('hex');
  const r = await req('POST', '/v1/discord/interactions', raw, {
    'x-signature-ed25519': sig, 'x-signature-timestamp': oldTs,
  });
  return r.status === 401;
});

check('MINOR: public rating endpoint is CORS-readable and answers preflight', async () => {
  const get = await rawReq('GET', '/v1/ratings/current');
  const opt = await rawReq('OPTIONS', '/v1/ratings/current');
  const priv = await rawReq('GET', '/v1/my-messages');
  return get.headers['access-control-allow-origin'] === '*' &&
    opt.status === 204 && opt.headers['access-control-allow-origin'] === '*' &&
    priv.headers['access-control-allow-origin'] === undefined;
});

check('MINOR: rating_snapshots are pruned per scope', async () => {
  const perScope = await count(
    'SELECT count(*) FROM rating_snapshots WHERE product IS NULL AND window_days = 90');
  return perScope <= 3;
});

check('MINOR: staff replies are mirrored into the case thread', async () => {
  const staffMirrors = await count(
    "SELECT count(*) FROM outbox WHERE event_type = 'message.created' AND payload->>'author' = 'staff'");
  return staffMirrors >= 1;
});

check('MINOR: readyz reports worker health, not a constant', async () => {
  const r = await req('GET', '/readyz');
  return r.status === 200 && r.json.ok === true &&
    ['running', 'starting'].includes(r.json.worker);
});

check('DARK GUARANTEE: flags off -> exact legacy /health keys, no new routes', async () => {
  // Subprocess with both gates unset: the body must be byte-identical legacy.
  const probe =
    "const http=require('http');process.env.PORT='39131';process.env.GH_ISSUES_TOKEN='x';" +
    "delete process.env.SUPPORT_V2_ENABLED;delete process.env.DATABASE_URL;" +
    "const {ready}=require(" + JSON.stringify(path.join(__dirname, 'server.js')) + ");" +
    "const get=(p)=>new Promise(r=>http.get({host:'127.0.0.1',port:39131,path:p},(s)=>{let b='';" +
    "s.on('data',c=>b+=c);s.on('end',()=>r({status:s.statusCode,body:b}));}));" +
    "ready.then(async()=>{const h=await get('/health');const hz=await get('/healthz');" +
    "const rz=await get('/readyz');const v1=await get('/v1/ratings/current');" +
    "console.log(JSON.stringify({keys:Object.keys(JSON.parse(h.body)),hz:hz.status,rz:rz.status,v1:v1.status}));" +
    "process.exit(0);});";
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  return JSON.stringify(r.keys) === JSON.stringify(['ok', 'service', 'configured']) &&
    r.hz === 404 && r.rz === 404 && r.v1 === 404;
});

check('no client response ever contained a bot token or a token hash', async () => {
  const probes = [
    await req('GET', '/health'),
    await req('GET', '/v1/my-messages', undefined, bearer(S.A)),
    await req('GET', '/v1/ratings/current'),
  ];
  return probes.every((p) => !p.body.includes('FAKE_DISCORD_BOT_TOKEN') &&
    !p.body.includes('token_hash'));
});

// --- screenshot attachments (#141) -----------------------------------

// 1x1 black-pixel PNG, a real decodable image.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');

/** TINY_PNG with a tEXt metadata chunk spliced in before IEND. */
function pngWithText() {
  const data = Buffer.from('GPS\0somewhere');
  const chunk = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data.length); return b; })(),
    Buffer.from('tEXt'), data, Buffer.alloc(4), // CRC bytes irrelevant to the strip walk
  ]);
  const iendAt = TINY_PNG.length - 12; // IEND chunk is exactly 12 bytes
  return Buffer.concat([TINY_PNG.subarray(0, iendAt), chunk, TINY_PNG.subarray(iendAt)]);
}

/** Minimal JPEG whose APP1 segment carries an EXIF payload. */
function jpegWithExif() {
  const exif = Buffer.from('Exif\0\0gps-coordinates-here');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1]), len, exif,
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02]), // SOS
    Buffer.from([0x11, 0x22, 0x33]), Buffer.from([0xff, 0xd9]),
  ]);
}

const shotBody = (buf, over) => Object.assign({
  type: 'bug', title: 'Screenshot probe', description: 'bug with a screenshot',
  screenshot: { data: buf.toString('base64') },
}, over);

async function blobOfCase(caseRef) {
  const { rows } = await db.query(
    'SELECT a.media_type, a.byte_size, a.sha256, a.redaction_state, b.data ' +
      'FROM attachments a JOIN support_cases c ON c.id = a.case_id ' +
      "JOIN attachment_blobs b ON b.id = substring(a.object_key from 4)::uuid " +
      'WHERE c.case_ref = $1',
    [caseRef]
  );
  return rows[0];
}

check('SHOT#1: /health advertises the screenshots capability when the chain is live', async () => {
  const h = await req('GET', '/health');
  return h.status === 200 && h.json.capabilities &&
    h.json.capabilities.screenshots === true;
});

check('SHOT#2: valid PNG attaches — 201, stored blob + sha256 + pending state', async () => {
  const r = await req('POST', '/v1/cases', shotBody(TINY_PNG), bearer(S.B, idem('SHOT-PNG')));
  S.shotCase = r.json.caseRef;
  const a = await blobOfCase(S.shotCase);
  const plain = await req('POST', '/v1/cases',
    { type: 'bug', title: 'No screenshot', description: 'plain bug' }, bearer(S.B, idem('SHOT-NONE')));
  return r.status === 201 && r.json.screenshotAttached === true &&
    plain.status === 201 && plain.json.screenshotAttached === false &&
    a && a.media_type === 'image/png' && a.redaction_state === 'pending' &&
    Number(a.byte_size) === a.data.length &&
    crypto.createHash('sha256').update(a.data).digest().equals(a.sha256);
});

check('SHOT#3: PNG tEXt + JPEG EXIF metadata are stripped before storage', async () => {
  const p = await req('POST', '/v1/cases', shotBody(pngWithText(), { title: 'PNG meta probe' }),
    bearer(S.B, idem('SHOT-PNGMETA')));
  const j = await req('POST', '/v1/cases', shotBody(jpegWithExif(), { title: 'JPEG meta probe' }),
    bearer(S.B, idem('SHOT-JPEGMETA')));
  const pb = await blobOfCase(p.json.caseRef);
  const jb = await blobOfCase(j.json.caseRef);
  S.jpegCase = j.json.caseRef;
  return p.status === 201 && j.status === 201 &&
    !pb.data.includes('tEXt') && !pb.data.includes('GPS') &&
    pb.data.subarray(0, 4).equals(TINY_PNG.subarray(0, 4)) &&
    jb.media_type === 'image/jpeg' && !jb.data.includes('Exif') &&
    jb.data[0] === 0xff && jb.data[1] === 0xd8;
});

check('SHOT#3b: WebP EXIF/XMP chunks are stripped and VP8X flags cleared', async () => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32LE(data.length);
    const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(type, 'latin1'), len, data, pad]);
  };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x0c; // EXIF + XMP presence flags
  const body = Buffer.concat([
    chunk('VP8X', vp8x),
    chunk('VP8 ', Buffer.from([1, 2, 3, 4, 5])),
    chunk('EXIF', Buffer.from('gps-here')),
    chunk('XMP ', Buffer.from('<xmp>loc</xmp>')),
  ]);
  const head = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  head.writeUInt32LE(4 + body.length, 4);
  const webp = Buffer.concat([head, body]);
  const r = await req('POST', '/v1/cases', shotBody(webp, { title: 'WebP meta probe' }),
    bearer(S.B, idem('SHOT-WEBPMETA')));
  const wb = await blobOfCase(r.json.caseRef);
  return r.status === 201 && wb.media_type === 'image/webp' &&
    !wb.data.includes('gps-here') && !wb.data.includes('EXIF') &&
    wb.data[wb.data.indexOf('VP8X') + 8] === 0 &&
    wb.data.includes('VP8 ') &&
    wb.data.readUInt32LE(4) === wb.data.length - 8;
});

check('SHOT#4: non-image rejected by magic bytes, not extension or claimed MIME', async () => {
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 1)]);
  const r = await req('POST', '/v1/cases',
    shotBody(exe, { screenshot: { data: exe.toString('base64'), mediaType: 'image/png' } }),
    bearer(S.B, idem('SHOT-EXE')));
  return r.status === 400 && r.json.error.code === 'validation_failed' &&
    r.json.error.message.includes('Only image files');
});

check('SHOT#5: oversized image rejected with the truthful 5 MB message', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);
  TINY_PNG.copy(big, 0); // real PNG magic so only the size check can reject it
  const r = await req('POST', '/v1/cases', shotBody(big), bearer(S.B, idem('SHOT-BIG')));
  return r.status === 400 && r.json.error.code === 'validation_failed' &&
    r.json.error.message.includes('5 MB');
});

check('SHOT#6: request body over the create cap -> 413, never a hang or 500', async () => {
  const r = await req('POST', '/v1/cases',
    JSON.stringify({ type: 'bug', title: 'x', description: 'y', screenshot: { data: 'A'.repeat(9 * 1024 * 1024) } }),
    bearer(S.B, idem('SHOT-HUGE')));
  return r.status === 413 && r.json.error.code === 'too_large';
});

check('SHOT#7: dispatch posts the screenshot once as multipart; state flips approved', async () => {
  await outbox.tick();
  await outbox.tick(); // second pass must not double-post (claimed pending->approved)
  const shotPosts = fetchCalls.filter((c) =>
    c.url.includes('discord.com') && c.body && c.body.includes('Screenshot attached to'));
  const a = await blobOfCase(S.shotCase);
  const one = shotPosts.find((c) => c.body.includes(S.shotCase));
  return shotPosts.filter((c) => c.body.includes(S.shotCase)).length === 1 &&
    a.redaction_state === 'approved' && Buffer.isBuffer(one.body) &&
    one.body.includes('payload_json') &&
    one.body.includes('filename="screenshot.png"') &&
    one.body.includes('Content-Type: image/png');
});

check('SHOT#9: client CORS — extension can preflight + POST /v1/cases and probe /health', async () => {
  const opt = await rawReq('OPTIONS', '/v1/cases');
  const optReg = await rawReq('OPTIONS', '/v1/principals');
  const health = await rawReq('GET', '/health');
  const post = await rawReq('POST', '/v1/cases'); // 401 body, but headers must carry CORS
  const inboxPriv = await rawReq('GET', '/v1/my-messages');
  return opt.status === 204 &&
    opt.headers['access-control-allow-origin'] === '*' &&
    opt.headers['access-control-allow-headers'].includes('Idempotency-Key') &&
    optReg.status === 204 &&
    health.headers['access-control-allow-origin'] === '*' &&
    post.headers['access-control-allow-origin'] === '*' &&
    inboxPriv.headers['access-control-allow-origin'] === undefined;
});

check('SHOT#8: expired attachments and blobs are purged by the worker', async () => {
  await db.query('UPDATE attachments SET expires_at = now() - interval \'1 day\'');
  await outbox.tick();
  const rows = await count('SELECT count(*) FROM attachments');
  const blobs = await count('SELECT count(*) FROM attachment_blobs');
  return rows === 0 && blobs === 0;
});

// --- run -------------------------------------------------------------
(async () => {
  console.log('=== support-framework suite (final directive) ===');
  console.log('');
  await ready;
  await db.query(
    'TRUNCATE discord_interactions, outbox, idempotency_requests, case_events, ' +
      'rating_snapshots, rating_revisions, ratings, inbox_receipts, internal_notes, ' +
      'attachments, attachment_blobs, case_messages, discord_case_bindings, support_cases, support_principals CASCADE'
  );

  let pass = true;
  for (const c of checks) {
    let ok = false;
    try { ok = await c.fn(); } catch (e) { ok = false; console.log('   threw: ' + e.message); }
    if (!ok) pass = false;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  console.log('');
  console.log(pass ? 'ALL PASS' : 'FAILURES PRESENT');
  await db.close();
  process.exit(pass ? 0 : 1);
})();
