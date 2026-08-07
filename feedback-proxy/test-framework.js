/**
 * Support-framework test suite (node script, no framework — test.js style).
 *
 * Needs a throwaway Postgres via TEST_DATABASE_URL; without it the suite
 * SKIPS with exit 0 so machines without a database stay green. All Discord
 * and GitHub traffic is stubbed through global.fetch — nothing external is
 * ever called. Tables are TRUNCATEd at start: point this at a scratch
 * database only.
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

const PORT = 39118;
process.env.PORT = String(PORT);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.GH_ISSUES_TOKEN = 'github_pat_FAKE_TOKEN_FOR_TESTS_ONLY';
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
  if (call.method === 'PATCH') return respond(200, { id: 'card-1' });
  if (u.includes('/messages')) {
    return respond(200, { id: u.includes('rating-chan-1') ? 'card-1' : 'tmsg-' + fetchCalls.length });
  }
  return respond(404, { error: 'unstubbed ' + u });
};

const { ready } = require('./server.js');
const db = require('./lib/db');
const outbox = require('./lib/outbox');

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

const bearer = (inst, extra) => Object.assign({ Authorization: `Bearer ${inst.token}` }, extra || {});
const idem = (key) => ({ 'Idempotency-Key': key });

let interactionCounter = 0;
function signedInteraction(interaction, opts) {
  if (!interaction.id) interaction.id = 'int-' + (++interactionCounter);
  const raw = JSON.stringify(interaction);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = (opts && opts.badSignature)
    ? crypto.randomBytes(64).toString('hex')
    : crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(raw)]), privateKey).toString('hex');
  return req('POST', '/integrations/discord/interactions', raw, {
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
const goodRating = (overall, extra) => Object.assign(
  { ease: 5, resolved: 5, recommend: 5, overall, appVersion: '5.5.1' }, extra || {});

// --- suite -----------------------------------------------------------
const S = {}; // shared state across ordered checks
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('ready 200 with db ok; health keeps legacy shape + db field', async () => {
  const r = await req('GET', '/ready');
  const h = await req('GET', '/health');
  return r.status === 200 && r.json.db === 'ok' &&
    h.status === 200 && h.json.ok === true && h.json.configured === true && h.json.db === 'ok';
});

check('legacy /feedback still works with the database mounted', async () => {
  const r = await req('POST', '/feedback', { type: 'Feedback', text: 'legacy path alive' });
  return r.status === 201 && r.json.number === 4242;
});

check('standard error shape: code + message + requestId', async () => {
  const r = await req('GET', '/api/v1/cases');
  return r.status === 401 && r.json.error && r.json.error.code === 'unauthorized' &&
    typeof r.json.error.message === 'string' && /^req_/.test(r.json.error.requestId);
});

check('register issues IN-… id + one-time token; bad source rejected', async () => {
  const a = await req('POST', '/api/v1/installations',
    { source: 'windows', appVersion: '5.5.1' }, { 'x-forwarded-for': '10.1.0.1' });
  const b = await req('POST', '/api/v1/installations',
    { source: 'windows', appVersion: '5.5.1' }, { 'x-forwarded-for': '10.1.0.2' });
  const c = await req('POST', '/api/v1/installations',
    { source: 'windows', appVersion: '5.5.0' }, { 'x-forwarded-for': '10.1.0.3' });
  const bad = await req('POST', '/api/v1/installations',
    { source: 'linux', appVersion: '1' }, { 'x-forwarded-for': '10.1.0.4' });
  S.A = a.json; S.B = b.json; S.C = c.json;
  return a.status === 201 && /^IN-[A-Z2-9]{10,20}$/.test(a.json.installationId) &&
    /^[0-9a-f]{64}$/.test(a.json.token) && b.status === 201 && c.status === 201 &&
    bad.status === 400 && bad.json.error.code === 'validation_failed';
});

check('token stored only as hash; tampered token -> 401', async () => {
  const { rows } = await db.query('SELECT token_hash FROM installations');
  const tampered = await req('GET', '/api/v1/cases', undefined,
    { Authorization: 'Bearer ' + '0'.repeat(64) });
  return rows.length === 3 &&
    rows.every((r) => Buffer.isBuffer(r.token_hash) && r.token_hash.length === 32) &&
    tampered.status === 401;
});

check('case create requires Idempotency-Key', async () => {
  const r = await req('POST', '/api/v1/cases',
    { type: 'bug', title: 'x y z', description: 'd' }, bearer(S.A));
  return r.status === 400 && r.json.error.code === 'missing_idempotency_key';
});

check('case create: same key + same body -> SAME random FX case, one row', async () => {
  const body = {
    type: 'bug', title: 'Fix stops during preflight',
    description: 'The scan completes, but Fix stays disabled after preflight.',
    impact: 'A main feature is blocked', os: 'Windows 11 · 10.0.26200', appVersion: '5.5.1',
  };
  const first = await req('POST', '/api/v1/cases', body, bearer(S.A, idem('K1')));
  const retry = await req('POST', '/api/v1/cases', body, bearer(S.A, idem('K1')));
  S.case1 = first.json.case && first.json.case.caseId;
  return first.status === 201 && CASE_RE.test(S.case1) && first.json.case.state === 'new' &&
    retry.status === 201 && retry.json.case.caseId === S.case1 &&
    (await count('SELECT count(*) FROM support_cases')) === 1;
});

check('same key + DIFFERENT body -> 409 idempotency_conflict', async () => {
  const r = await req('POST', '/api/v1/cases',
    { type: 'bug', title: 'something else', description: 'other' }, bearer(S.A, idem('K1')));
  return r.status === 409 && r.json.error.code === 'idempotency_conflict';
});

check('second case gets a different random id (not sequential)', async () => {
  const r = await req('POST', '/api/v1/cases',
    { type: 'bug', title: 'Second bug here', description: 'details' }, bearer(S.A, idem('K2')));
  S.case2 = r.json.case.caseId;
  return r.status === 201 && CASE_RE.test(S.case2) && S.case2 !== S.case1;
});

check('outbox rows committed in the SAME tx (worker off -> rows pending)', async () => {
  return (await count(
    "SELECT count(*) FROM outbox_events WHERE event_type = 'case.created' AND state = 'pending'")) === 2;
});

check('OPERATOR RULE: compliment -> counted, NO case, NO alert', async () => {
  const r = await req('POST', '/api/v1/feedback',
    { topic: 'compliment', message: 'love it, thanks!' }, bearer(S.A, idem('F1')));
  return r.status === 201 && r.json.saved === true &&
    (await count('SELECT count(*) FROM positive_feedback')) === 1 &&
    (await count('SELECT count(*) FROM support_cases')) === 2 &&
    (await count("SELECT count(*) FROM outbox_events WHERE event_type = 'case.created'")) === 2;
});

check('suggestion -> feedback case + alert', async () => {
  const r = await req('POST', '/api/v1/feedback',
    { topic: 'suggestion', message: 'add a dark mode toggle' }, bearer(S.A, idem('F2')));
  return r.status === 201 && r.json.case.kind === 'feedback' &&
    r.json.case.subject === 'Feedback — suggestion' &&
    (await count("SELECT count(*) FROM outbox_events WHERE event_type = 'case.created'")) === 3;
});

check('case list hides internals; unreadCount present', async () => {
  const r = await req('GET', '/api/v1/cases', undefined, bearer(S.A));
  const allowed = new Set(['caseId', 'kind', 'state', 'subject', 'appVersion', 'createdAt', 'updatedAt']);
  return r.status === 200 && r.json.unreadCount === 0 && r.json.cases.length === 3 &&
    r.json.cases.every((c) => Object.keys(c).every((k) => allowed.has(k)));
});

check("another installation cannot see A's case", async () => {
  const r = await req('GET', `/api/v1/cases/${S.case1}`, undefined, bearer(S.B));
  return r.status === 404;
});

check('user message: idempotent; initial message listed first', async () => {
  const first = await req('POST', `/api/v1/cases/${S.case1}/messages`,
    { body: 'more info: log attached' }, bearer(S.A, idem('M1')));
  const retry = await req('POST', `/api/v1/cases/${S.case1}/messages`,
    { body: 'more info: log attached' }, bearer(S.A, idem('M1')));
  const g = await req('GET', `/api/v1/cases/${S.case1}`, undefined, bearer(S.A));
  return first.status === 201 && first.json.state === 'new' &&
    retry.json.message.body === 'more info: log attached' &&
    g.json.messages.length === 2 && g.json.messages[0].author === 'user' &&
    g.json.messages[1].body === 'more info: log attached';
});

check('interactions: invalid signature -> 401 before any parsing', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`), { badSignature: true });
  const noHeaders = await req('POST', '/integrations/discord/interactions', JSON.stringify({ type: 1 }));
  return r.status === 401 && noHeaders.status === 401;
});

check('interactions: PING -> PONG', async () => {
  const r = await signedInteraction({ type: 1 });
  return r.status === 200 && r.json.type === 1;
});

check('wrong guild denied — custom_id is not authorization', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`, { guild_id: 'evil-guild' }));
  const c = await req('GET', `/api/v1/cases/${S.case1}`, undefined, bearer(S.A));
  return r.json.data.content === 'Not authorized.' && c.json.case.state === 'new';
});

check('non-staff member denied', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`,
    { member: { roles: ['random-role'], user: { id: 'rando' } } }));
  const c = await req('GET', `/api/v1/cases/${S.case1}`, undefined, bearer(S.A));
  return r.json.data.content === 'Not authorized.' && c.json.case.state === 'new';
});

check('Reply button -> modal carrying the CURRENT case version', async () => {
  const r = await signedInteraction(button(`reply:${S.case1}`));
  return r.status === 200 && r.json.type === 9 &&
    r.json.data.custom_id === `reply_modal:${S.case1}:1`;
});

check('modal submit stores staff reply + waiting_for_user + version bump', async () => {
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
  const c = await req('GET', `/api/v1/cases/${S.case1}`, undefined, bearer(S.A));
  const { rows } = await db.query(
    "SELECT version FROM support_cases WHERE public_id = $1", [S.case1]);
  return r.status === 200 && r.json.data.content.includes('Reply queued') &&
    c.json.case.state === 'waiting_for_user' && rows[0].version === 2 &&
    (await count("SELECT count(*) FROM case_messages WHERE author = 'staff'")) === 1;
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

check('stale version modal submit rejected (optimistic lock)', async () => {
  const r = await signedInteraction({
    type: 5, guild_id: 'guild-1', member: staffMember,
    data: {
      custom_id: `reply_modal:${S.case1}:1`, // current version is 2
      components: [{ type: 1, components: [{ type: 4, custom_id: 'message', value: 'stale' }] }],
    },
  });
  return r.json.data.content.includes('changed since') &&
    (await count("SELECT count(*) FROM case_messages WHERE author = 'staff'")) === 1;
});

check('delivery ladder: queued -> available on fetch -> read on /read', async () => {
  const before = await db.query(
    "SELECT delivery FROM case_messages WHERE author = 'staff'");
  const list1 = await req('GET', '/api/v1/cases', undefined, bearer(S.A));
  await req('GET', `/api/v1/cases/${S.case1}`, undefined, bearer(S.A)); // flips to available
  const mid = await db.query("SELECT delivery FROM case_messages WHERE author = 'staff'");
  const rr = await req('POST', `/api/v1/cases/${S.case1}/read`, {}, bearer(S.A));
  const after = await db.query("SELECT delivery FROM case_messages WHERE author = 'staff'");
  return before.rows[0].delivery === 'available' || before.rows[0].delivery === 'queued'
    ? (list1.json.unreadCount === 1 && mid.rows[0].delivery === 'available' &&
       rr.json.unreadCount === 0 && after.rows[0].delivery === 'read')
    : false;
});

check('state machine: user reply to waiting_for_user -> in_review', async () => {
  const r = await req('POST', `/api/v1/cases/${S.case1}/messages`,
    { body: 'log attached here' }, bearer(S.A, idem('M2')));
  return r.status === 201 && r.json.state === 'in_review';
});

check('resolve button -> resolved', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`));
  const c = await req('GET', `/api/v1/cases/${S.case1}`, undefined, bearer(S.A));
  return r.json.data.content.includes('resolved') && c.json.case.state === 'resolved';
});

check('state machine: user reply to resolved -> reopened', async () => {
  const r = await req('POST', `/api/v1/cases/${S.case1}/messages`,
    { body: 'still broken after the fix' }, bearer(S.A, idem('M3')));
  return r.status === 201 && r.json.state === 'reopened';
});

check('spam locks the case for users (409 case_locked)', async () => {
  await db.query("UPDATE support_cases SET state = 'spam' WHERE public_id = $1", [S.case2]);
  const r = await req('POST', `/api/v1/cases/${S.case2}/messages`,
    { body: 'hello?' }, bearer(S.A, idem('M4')));
  return r.status === 409 && r.json.error.code === 'case_locked';
});

check('every transition wrote a case_events audit row', async () => {
  return (await count(
    "SELECT count(*) FROM case_events WHERE event_type = 'state.changed'")) >= 4;
});

check('rating before any eligible product event -> 422 not_eligible', async () => {
  const r = await req('PUT', '/api/v1/ratings/me', goodRating(5), bearer(S.B, idem('RB0')));
  return r.status === 422 && r.json.error.code === 'not_eligible';
});

check('product-events: recorded once, replayed on retry', async () => {
  const body = { kind: 'fix_completed', appVersion: '5.5.1', occurredAt: new Date().toISOString() };
  const first = await req('POST', '/api/v1/product-events', body, bearer(S.A, idem('E1')));
  const retry = await req('POST', '/api/v1/product-events', body, bearer(S.A, idem('E1')));
  return first.status === 201 && first.json.recorded === true &&
    retry.status === 201 &&
    (await count('SELECT count(*) FROM product_events')) === 1;
});

check('rating validation strict: fraction, zero, missing, string all 400', async () => {
  const h = bearer(S.A, idem('RX'));
  const probes = [
    await req('PUT', '/api/v1/ratings/me', goodRating(3.5), h),
    await req('PUT', '/api/v1/ratings/me', goodRating(5, { ease: 0 }), h),
    await req('PUT', '/api/v1/ratings/me', { ease: 5, resolved: 5, overall: 5, appVersion: 'v' }, h),
    await req('PUT', '/api/v1/ratings/me', goodRating(5, { recommend: '4' }), h),
  ];
  return probes.every((r) => r.status === 400 && r.json.error.code === 'validation_failed');
});

check('OPERATOR RULE: rating 5, no follow-up -> live score only, NO case', async () => {
  const casesBefore = await count('SELECT count(*) FROM support_cases');
  const r = await req('PUT', '/api/v1/ratings/me',
    goodRating(5, { comment: 'works great' }), bearer(S.A, idem('R1')));
  return r.status === 200 && r.json.state === 'verified' && r.json.caseId === null &&
    r.json.snapshot.state === 'collecting' && r.json.snapshot.count === 1 &&
    (await count('SELECT count(*) FROM support_cases')) === casesBefore &&
    (await count("SELECT count(*) FROM outbox_events WHERE event_type = 'rating.snapshot.changed' AND state = 'pending'")) >= 1;
});

check('GET /api/v1/ratings/current is public and honest below 10 samples', async () => {
  const r = await req('GET', '/api/v1/ratings/current');
  return r.status === 200 && r.json.state === 'collecting' && r.json.count === 1 &&
    r.json.window === '90d' && r.json.score === undefined;
});

check('re-rate upserts the one row per (installation, source) + revisions', async () => {
  const r = await req('PUT', '/api/v1/ratings/me', goodRating(4), bearer(S.A, idem('R2')));
  return r.status === 200 &&
    (await count('SELECT count(*) FROM ratings')) === 1 &&
    (await count('SELECT count(*) FROM rating_revisions')) === 2;
});

check('OPERATOR RULE: rating 2 -> rating_feedback case + alert', async () => {
  await req('POST', '/api/v1/product-events',
    { kind: 'fix_failed', occurredAt: new Date().toISOString() }, bearer(S.B, idem('E2')));
  const r = await req('PUT', '/api/v1/ratings/me',
    goodRating(2, { comment: 'made it worse' }), bearer(S.B, idem('R3')));
  S.ratingCase = r.json.caseId;
  const kind = (await db.query(
    'SELECT kind FROM support_cases WHERE public_id = $1', [S.ratingCase])).rows[0];
  return r.status === 200 && CASE_RE.test(S.ratingCase) && kind.kind === 'rating_feedback' &&
    (await count("SELECT count(*) FROM outbox_events WHERE event_type = 'case.created'")) === 4;
});

check('retry with same key replays the SAME case; re-rate reuses the open case', async () => {
  const retry = await req('PUT', '/api/v1/ratings/me',
    goodRating(2, { comment: 'made it worse' }), bearer(S.B, idem('R3')));
  const rerate = await req('PUT', '/api/v1/ratings/me',
    goodRating(1, { comment: 'even worse now' }), bearer(S.B, idem('R4')));
  return retry.json.caseId === S.ratingCase && rerate.json.caseId === S.ratingCase &&
    (await count("SELECT count(*) FROM support_cases WHERE kind = 'rating_feedback'")) === 1;
});

check('rating case is visible to its user via the client API (My Messages)', async () => {
  const list = await req('GET', '/api/v1/cases', undefined, bearer(S.B));
  const one = await req('GET', `/api/v1/cases/${S.ratingCase}`, undefined, bearer(S.B));
  return list.json.cases.some((c) => c.caseId === S.ratingCase) &&
    one.json.messages.length >= 1 && one.json.messages[0].body === 'made it worse';
});

check('OPERATOR RULE: rating 4-5 WITH follow-up requested -> case + alert', async () => {
  await req('POST', '/api/v1/product-events',
    { kind: 'fix_completed', occurredAt: new Date().toISOString() }, bearer(S.C, idem('E3')));
  const r = await req('PUT', '/api/v1/ratings/me',
    goodRating(5, { comment: 'great but one question', followUpRequested: true }),
    bearer(S.C, idem('R5')));
  return r.status === 200 && CASE_RE.test(r.json.caseId) &&
    (await count("SELECT count(*) FROM outbox_events WHERE event_type = 'case.created'")) === 5;
});

check('DELETE withdraws the rating and drops it from the snapshot', async () => {
  const r = await req('DELETE', '/api/v1/ratings/me', undefined, bearer(S.A));
  const again = await req('DELETE', '/api/v1/ratings/me', undefined, bearer(S.A));
  const cur = await req('GET', '/api/v1/ratings/current');
  return r.status === 200 && r.json.state === 'withdrawn' && again.status === 200 &&
    cur.json.count === 2; // B (overall 1) + C (overall 5) remain verified
});

check('worker off: every Discord-bound row still pending, zero Discord calls', async () => {
  const pending = await count(
    "SELECT count(*) FROM outbox_events WHERE state = 'pending'");
  const discordCalls = fetchCalls.filter((c) => c.url.includes('discord.com'));
  return pending >= 10 && discordCalls.length === 0;
});

check('flag on: worker drains outbox, saves thread ids, upserts rating card', async () => {
  process.env.DISCORD_ENABLED = 'true';
  for (let i = 0; i < 4; i++) await outbox.tick();
  const pending = await count(
    "SELECT count(*) FROM outbox_events WHERE state IN ('pending', 'failed')");
  const threads = await count(
    'SELECT count(*) FROM support_cases WHERE discord_forum_thread_id IS NOT NULL');
  const forumPosts = fetchCalls.filter((c) => c.url.includes('/channels/forum-1/threads'));
  const cardCalls = fetchCalls.filter((c) => c.url.includes('rating-chan-1'));
  return pending === 0 && threads === 5 && forumPosts.length === 5 && cardCalls.length >= 1;
});

check('forum posts use Components V2 and carry the case controls', async () => {
  const posts = fetchCalls
    .filter((c) => c.url.includes('/channels/forum-1/threads'))
    .map((c) => JSON.parse(c.body));
  return posts.length === 5 && posts.every((p) =>
    p.message.flags === 32768 && !p.message.content && !p.message.embeds &&
    JSON.stringify(p.message.components).includes('"custom_id":"reply:'));
});

check('user text never pings; the one role alert allowlists exactly one role', async () => {
  const discordMsgs = fetchCalls.filter((c) =>
    c.url.includes('discord.com') && c.body && (c.method === 'POST' || c.method === 'PATCH'));
  const alerts = discordMsgs.filter((c) => c.body.includes('<@&'));
  return discordMsgs.every((c) => c.body.includes('"allowed_mentions"')) &&
    alerts.length === 5 && alerts.every((c) => {
      const b = JSON.parse(c.body);
      return b.allowed_mentions.parse.length === 0 &&
        JSON.stringify(b.allowed_mentions.roles) === '["staff-role-1"]';
    });
});

check('no client response ever contained a bot token or a token hash', async () => {
  const probes = [
    await req('GET', '/health'),
    await req('GET', '/api/v1/cases', undefined, bearer(S.A)),
    await req('GET', '/api/v1/ratings/current'),
  ];
  return probes.every((p) => !p.body.includes('FAKE_DISCORD_BOT_TOKEN') &&
    !p.body.includes('token_hash'));
});

// --- run -------------------------------------------------------------
(async () => {
  console.log('=== support-framework suite ===');
  console.log('');
  await ready;
  await db.query(
    'TRUNCATE discord_interactions, outbox_events, idempotency_records, case_events, ' +
      'rating_snapshots, rating_revisions, positive_feedback, ratings, case_attachments, ' +
      'case_messages, support_cases, product_events, installations CASCADE'
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
