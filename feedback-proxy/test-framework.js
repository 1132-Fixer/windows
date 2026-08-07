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

const PORT = 39118;
process.env.PORT = String(PORT);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SUPPORT_V2_ENABLED = 'true';
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
let failNextThreadPost = false; // simulates an archived thread once
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
    rz.json.worker === 'running' &&
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
  const after = (await db.query("SELECT state FROM inbox_receipts")).rows[0];
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
  const receipt = (await db.query('SELECT state FROM inbox_receipts')).rows[0];
  return r.status === 201 && r.json.state === 'in_review' && receipt.state === 'REPLIED';
});

check('resolve button -> resolved; user reply reopens', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`));
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
      componentsJson.includes(`"custom_id":"${a}${S.case1}"`)) &&
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

check('no client response ever contained a bot token or a token hash', async () => {
  const probes = [
    await req('GET', '/health'),
    await req('GET', '/v1/my-messages', undefined, bearer(S.A)),
    await req('GET', '/v1/ratings/current'),
  ];
  return probes.every((p) => !p.body.includes('FAKE_DISCORD_BOT_TOKEN') &&
    !p.body.includes('token_hash'));
});

// --- run -------------------------------------------------------------
(async () => {
  console.log('=== support-framework suite (final directive) ===');
  console.log('');
  await ready;
  await db.query(
    'TRUNCATE discord_interactions, outbox, idempotency_requests, case_events, ' +
      'rating_snapshots, rating_revisions, ratings, inbox_receipts, internal_notes, ' +
      'attachments, case_messages, discord_case_bindings, support_cases, support_principals CASCADE'
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
