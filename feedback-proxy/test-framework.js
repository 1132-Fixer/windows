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
process.env.INSTALL_CREDENTIAL_PEPPER = 'test-pepper';
process.env.DISCORD_ENABLED = 'false'; // worker must NOT dispatch: proves rows persist
process.env.DISCORD_BOT_TOKEN = 'FAKE_DISCORD_BOT_TOKEN';
process.env.DISCORD_GUILD_ID = 'guild-1';
process.env.DISCORD_SUPPORT_FORUM_ID = 'forum-1';
process.env.DISCORD_RATING_CHANNEL_ID = 'rating-chan-1';
process.env.DISCORD_STAFF_ROLE_IDS = 'staff-role-1,staff-role-2';

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
  if (call.method === 'PATCH') return respond(200, { id: 'dash-1' });
  if (u.includes('/messages')) return respond(200, { id: u.includes('rating-chan-1') ? 'dash-1' : 'tmsg-' + fetchCalls.length });
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

const bearer = (inst) => ({ Authorization: `Bearer ${inst.installation_id}.${inst.credential}` });

function signedInteraction(interaction, opts) {
  const raw = JSON.stringify(interaction);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = (opts && opts.badSignature)
    ? crypto.randomBytes(64).toString('hex')
    : crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(raw)]), privateKey).toString('hex');
  return req('POST', '/discord/interactions', raw, {
    'x-signature-ed25519': sig,
    'x-signature-timestamp': ts,
  });
}

const staffMember = { roles: ['staff-role-1', 'other-role'] };
const button = (customId, over) => Object.assign({
  type: 3, guild_id: 'guild-1', member: staffMember,
  data: { component_type: 2, custom_id: customId },
}, over);

async function count(sql, params) {
  return Number((await db.query(sql, params)).rows[0].count);
}

// --- suite -----------------------------------------------------------
const S = {}; // shared state across ordered checks
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('readyz 200 with db ok; health gains db field, keeps legacy shape', async () => {
  const r = await req('GET', '/readyz');
  const h = await req('GET', '/health');
  return r.status === 200 && r.json.db === 'ok' &&
    h.status === 200 && h.json.ok === true && h.json.configured === true && h.json.db === 'ok';
});

check('legacy /feedback still works with the database mounted', async () => {
  const r = await req('POST', '/feedback', { type: 'Feedback', text: 'legacy path alive' });
  return r.status === 201 && r.json.number === 4242;
});

check('register issues installation_id + one-time credential', async () => {
  const a = await req('POST', '/v1/installations/register', {}, { 'x-forwarded-for': '10.1.0.1' });
  const b = await req('POST', '/v1/installations/register', {}, { 'x-forwarded-for': '10.1.0.2' });
  const c = await req('POST', '/v1/installations/register', {}, { 'x-forwarded-for': '10.1.0.3' });
  S.A = a.json; S.B = b.json; S.C = c.json;
  return a.status === 201 && /^[0-9a-f]{32}$/.test(a.json.installation_id) &&
    /^[0-9a-f]{64}$/.test(a.json.credential) && b.status === 201 && c.status === 201;
});

check('credential is stored only as a hash', async () => {
  const { rows } = await db.query('SELECT credential_hash FROM installations');
  return rows.length === 3 && rows.every((r) =>
    /^[0-9a-f]{64}$/.test(r.credential_hash) && r.credential_hash !== S.A.credential);
});

check('auth: bad credential and missing header both 401', async () => {
  const bad = await req('GET', '/v1/tickets', undefined,
    { Authorization: `Bearer ${S.A.installation_id}.${'0'.repeat(64)}` });
  const none = await req('GET', '/v1/tickets');
  return bad.status === 401 && none.status === 401;
});

check('ticket create requires Idempotency-Key', async () => {
  const r = await req('POST', '/v1/tickets',
    { type: 'bug', subject: 'x', body: 'y' }, bearer(S.A));
  return r.status === 400 && r.json.error === 'missing_idempotency_key';
});

check('ticket create: same key twice -> SAME case, one row', async () => {
  const h = Object.assign({ 'Idempotency-Key': 'K1' }, bearer(S.A));
  const first = await req('POST', '/v1/tickets',
    { type: 'bug', subject: 'Fix stops during preflight', body: 'it hangs at 40%', app_version: '5.4.0', os_info: 'Windows 11 26200' }, h);
  const retry = await req('POST', '/v1/tickets',
    { type: 'bug', subject: 'Fix stops during preflight', body: 'it hangs at 40%', app_version: '5.4.0', os_info: 'Windows 11 26200' }, h);
  S.case1 = first.json.ticket.id;
  return first.status === 201 && S.case1 === 'F-0001' && first.json.ticket.status === 'NEW' &&
    retry.json.ticket.id === S.case1 && (await count('SELECT count(*) FROM tickets')) === 1;
});

check('client ticket JSON hides internals (priority/assignee/discord ids)', async () => {
  const r = await req('GET', '/v1/tickets', undefined, bearer(S.A));
  const keys = Object.keys(r.json.tickets[0]);
  return r.status === 200 && !keys.some((k) =>
    ['priority', 'assignee', 'installation_id', 'idempotency_key'].includes(k) || k.startsWith('discord_'));
});

check('outbox row committed in the SAME tx (worker off -> row persists pending)', async () => {
  return (await count(
    "SELECT count(*) FROM outbox WHERE kind = 'ticket.created' AND delivered_at IS NULL")) === 1;
});

check('second ticket gets the next case ref', async () => {
  const r = await req('POST', '/v1/tickets', { type: 'message', subject: 'question about fix 1132' },
    Object.assign({ 'Idempotency-Key': 'K2' }, bearer(S.A)));
  return r.status === 201 && r.json.ticket.id === 'F-0002';
});

check('direct rating-type ticket creation is rejected', async () => {
  const r = await req('POST', '/v1/tickets', { type: 'rating', subject: 'nope' },
    Object.assign({ 'Idempotency-Key': 'K3' }, bearer(S.A)));
  return r.status === 400 && r.json.error === 'bad_type';
});

check('user message: idempotent, sequence assigned after the create message', async () => {
  const h = Object.assign({ 'Idempotency-Key': 'M1' }, bearer(S.A));
  const first = await req('POST', `/v1/tickets/${S.case1}/messages`, { body: 'more info: log attached' }, h);
  const retry = await req('POST', `/v1/tickets/${S.case1}/messages`, { body: 'more info: log attached' }, h);
  return first.status === 201 && first.json.message.sequence === 2 &&
    retry.json.message.sequence === 2 &&
    (await count('SELECT count(*) FROM ticket_messages')) === 2;
});

check('messages?after= returns only later sequences, in order', async () => {
  const all = await req('GET', `/v1/tickets/${S.case1}/messages?after=0`, undefined, bearer(S.A));
  const tail = await req('GET', `/v1/tickets/${S.case1}/messages?after=1`, undefined, bearer(S.A));
  return all.json.messages.map((m) => m.sequence).join(',') === '1,2' &&
    tail.json.messages.map((m) => m.sequence).join(',') === '2';
});

check("another installation cannot see A's ticket", async () => {
  const r = await req('GET', `/v1/tickets/${S.case1}`, undefined, bearer(S.B));
  return r.status === 404;
});

check('interactions: invalid signature -> 401 before any parsing', async () => {
  const r = await signedInteraction({ type: 1 }, { badSignature: true });
  const noHeaders = await req('POST', '/discord/interactions', JSON.stringify({ type: 1 }));
  return r.status === 401 && noHeaders.status === 401;
});

check('interactions: PING -> PONG', async () => {
  const r = await signedInteraction({ type: 1 });
  return r.status === 200 && r.json.type === 1;
});

check('interactions: wrong guild denied, nothing changes', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`, { guild_id: 'evil-guild' }));
  const t = await req('GET', `/v1/tickets/${S.case1}`, undefined, bearer(S.A));
  return r.json.data.content === 'Not authorized.' && t.json.ticket.status === 'NEW';
});

check('interactions: non-staff member denied — custom_id is not authorization', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`,
    { member: { roles: ['random-role'] } }));
  const t = await req('GET', `/v1/tickets/${S.case1}`, undefined, bearer(S.A));
  return r.json.data.content === 'Not authorized.' && t.json.ticket.status === 'NEW';
});

check('interactions: Reply button -> modal for the case', async () => {
  const r = await signedInteraction(button(`reply:${S.case1}`));
  return r.status === 200 && r.json.type === 9 &&
    r.json.data.custom_id === `reply_modal:${S.case1}`;
});

check('modal submit stores staff reply + WAITING_FOR_USER', async () => {
  const r = await signedInteraction({
    type: 5, guild_id: 'guild-1', member: staffMember,
    data: {
      custom_id: `reply_modal:${S.case1}`,
      components: [
        { type: 1, components: [{ type: 4, custom_id: 'message', value: 'Please send the preflight log.' }] },
        { type: 1, components: [{ type: 4, custom_id: 'status', value: 'waiting' }] },
      ],
    },
  });
  const t = await req('GET', `/v1/tickets/${S.case1}`, undefined, bearer(S.A));
  const staffRows = await count("SELECT count(*) FROM ticket_messages WHERE author = 'staff'");
  return r.status === 200 && t.json.ticket.status === 'WAITING_FOR_USER' && staffRows === 1;
});

check('state machine: user reply to WAITING_FOR_USER -> USER_REPLIED', async () => {
  const r = await req('POST', `/v1/tickets/${S.case1}/messages`, { body: 'log attached here' },
    Object.assign({ 'Idempotency-Key': 'M2' }, bearer(S.A)));
  return r.status === 201 && r.json.status === 'USER_REPLIED';
});

check('resolve button -> RESOLVED (staff)', async () => {
  const r = await signedInteraction(button(`resolve:${S.case1}`));
  const t = await req('GET', `/v1/tickets/${S.case1}`, undefined, bearer(S.A));
  return r.json.data.content.includes('RESOLVED') && t.json.ticket.status === 'RESOLVED';
});

check('state machine: user reply to RESOLVED reopens -> USER_REPLIED', async () => {
  const r = await req('POST', `/v1/tickets/${S.case1}/messages`, { body: 'still broken after fix' },
    Object.assign({ 'Idempotency-Key': 'M3' }, bearer(S.A)));
  return r.status === 201 && r.json.status === 'USER_REPLIED';
});

check('CLOSED needs staff: user message on closed case -> 409', async () => {
  await db.query("UPDATE tickets SET status = 'CLOSED' WHERE case_ref = $1", [S.case1]);
  const r = await req('POST', `/v1/tickets/${S.case1}/messages`, { body: 'hello?' },
    Object.assign({ 'Idempotency-Key': 'M4' }, bearer(S.A)));
  await db.query("UPDATE tickets SET status = 'RESOLVED' WHERE case_ref = $1", [S.case1]);
  return r.status === 409 && r.json.error === 'closed';
});

check('every transition wrote an audit event', async () => {
  const { rows } = await db.query(
    "SELECT count(*)::int AS count FROM ticket_events WHERE event = 'status.changed'");
  return rows[0].count >= 4; // waiting, user_replied, resolved, reopened
});

check('staff replies flip delivered_to_client when the client fetches them', async () => {
  await req('GET', `/v1/tickets/${S.case1}/messages?after=0`, undefined, bearer(S.A));
  const undelivered = await count(
    "SELECT count(*) FROM ticket_messages WHERE author = 'staff' AND NOT delivered_to_client");
  return undelivered === 0;
});

check('rating validation is strict: 0, 6, 3.5, "4", missing version/key all 400', async () => {
  const h = Object.assign({ 'Idempotency-Key': 'RX' }, bearer(S.A));
  const cases_ = [
    await req('POST', '/v1/ratings', { score: 0, app_version: 'v' }, h),
    await req('POST', '/v1/ratings', { score: 6, app_version: 'v' }, h),
    await req('POST', '/v1/ratings', { score: 3.5, app_version: 'v' }, h),
    await req('POST', '/v1/ratings', { score: '4', app_version: 'v' }, h),
    await req('POST', '/v1/ratings', { score: 4 }, h),
    await req('POST', '/v1/ratings', { score: 4, app_version: 'v' }, bearer(S.A)),
  ];
  return cases_.every((r) => r.status === 400);
});

check('OPERATOR RULE: positive rating -> live score only, NO case, NO forum alert', async () => {
  const before = await count('SELECT count(*) FROM tickets');
  const beforeCreated = await count("SELECT count(*) FROM outbox WHERE kind = 'ticket.created'");
  const r = await req('POST', '/v1/ratings',
    { score: 5, app_version: '5.4.0', comment: 'works great, thanks!' },
    Object.assign({ 'Idempotency-Key': 'R1' }, bearer(S.A)));
  const after = await count('SELECT count(*) FROM tickets');
  const afterCreated = await count("SELECT count(*) FROM outbox WHERE kind = 'ticket.created'");
  const dashRows = await count(
    "SELECT count(*) FROM outbox WHERE kind = 'rating.changed' AND delivered_at IS NULL");
  return r.status === 200 && r.json.case === null &&
    after === before && afterCreated === beforeCreated && dashRows >= 1;
});

check('badge honestly grey below the minimum sample', async () => {
  const r = await req('GET', '/v1/ratings/badge');
  return r.status === 200 && r.json.schemaVersion === 1 &&
    r.json.message === 'not enough verified ratings' && r.json.color === 'lightgrey';
});

check('re-rating upserts the one row per installation+version', async () => {
  const r = await req('POST', '/v1/ratings', { score: 4, app_version: '5.4.0' },
    Object.assign({ 'Idempotency-Key': 'R2' }, bearer(S.A)));
  const { rows } = await db.query('SELECT score, comment FROM ratings WHERE app_version = $1', ['5.4.0']);
  return r.status === 200 && rows.length === 1 && rows[0].score === 4 && rows[0].comment === null;
});

check('OPERATOR RULE: negative rating -> ratings row + case + forum alert', async () => {
  const r = await req('POST', '/v1/ratings',
    { score: 2, app_version: '5.4.0', comment: 'fixer made it worse' },
    Object.assign({ 'Idempotency-Key': 'R3' }, bearer(S.B)));
  S.ratingCase = r.json.case;
  const t = (await db.query('SELECT * FROM tickets WHERE case_ref = $1', [S.ratingCase])).rows[0];
  const alert = await count(
    "SELECT count(*) FROM outbox WHERE kind = 'ticket.created' AND payload->>'case_ref' = $1",
    [S.ratingCase]);
  return r.status === 200 && S.ratingCase === 'F-0003' && t && t.type === 'rating' &&
    t.subject === 'Rating 2/5 — 5.4.0' && alert === 1;
});

check('negative rating retry with same key does not open a second case', async () => {
  const before = await count('SELECT count(*) FROM tickets');
  const r = await req('POST', '/v1/ratings',
    { score: 2, app_version: '5.4.0', comment: 'fixer made it worse' },
    Object.assign({ 'Idempotency-Key': 'R3' }, bearer(S.B)));
  return r.status === 200 && r.json.case === S.ratingCase &&
    (await count('SELECT count(*) FROM tickets')) === before;
});

check('rating case is visible to its user via the client API (My Messages)', async () => {
  const list = await req('GET', '/v1/tickets', undefined, bearer(S.B));
  const msgs = await req('GET', `/v1/tickets/${S.ratingCase}/messages?after=0`, undefined, bearer(S.B));
  return list.json.tickets.some((t) => t.id === S.ratingCase && t.type === 'rating') &&
    msgs.json.messages.length === 1 && msgs.json.messages[0].body === 'fixer made it worse';
});

check('summary math over 30d latest-per-installation+version', async () => {
  await req('POST', '/v1/ratings', { score: 3, app_version: '5.3.11' },
    Object.assign({ 'Idempotency-Key': 'R4' }, bearer(S.C))); // negative -> case F-0004
  const s = await req('GET', '/v1/ratings/summary?version=5.4.0', undefined, bearer(S.A));
  return s.json.score === 3.0 && s.json.count === 3 && s.json.enough_data === true &&
    s.json.version_score === 3.0 && s.json.version_count === 2 &&
    s.json.distribution['2'] === 1 && s.json.distribution['3'] === 1 && s.json.distribution['4'] === 1;
});

check('badge shows score, count, and threshold color once sample is enough', async () => {
  const r = await req('GET', '/v1/ratings/badge');
  return r.json.message === '3.0/5 (3 verified)' && r.json.color === 'green';
});

check('worker off: every Discord-bound row is still pending (kill-safe)', async () => {
  const pending = await count('SELECT count(*) FROM outbox WHERE delivered_at IS NULL');
  const discordCalls = fetchCalls.filter((c) => c.url.includes('discord.com'));
  return pending >= 8 && discordCalls.length === 0;
});

check('flag on: worker drains outbox, saves thread ids, upserts dashboard', async () => {
  process.env.DISCORD_ENABLED = 'true';
  await outbox.tick();
  await outbox.tick();
  await outbox.tick();
  const pending = await count('SELECT count(*) FROM outbox WHERE delivered_at IS NULL');
  const threads = await count('SELECT count(*) FROM tickets WHERE discord_thread_id IS NOT NULL');
  const dash = (await db.query("SELECT * FROM dashboard_messages WHERE key = 'rating'")).rows[0];
  const forumPosts = fetchCalls.filter((c) => c.url.includes('/channels/forum-1/threads'));
  return pending === 0 && threads === 4 && Boolean(dash) && dash.message_id === 'dash-1' &&
    forumPosts.length === 4;
});

check('every Discord message payload disarms mentions', async () => {
  const messagePosts = fetchCalls.filter((c) => c.url.includes('discord.com') && c.body &&
    (c.body.includes('"content"') || c.body.includes('"embeds"')));
  return messagePosts.length > 0 && messagePosts.every((c) =>
    c.body.includes('"allowed_mentions":{"parse":[]}'));
});

check('no client response ever contained a bot token or credential hash', async () => {
  // Spot check the surfaces a client can reach.
  const probes = [
    await req('GET', '/health'),
    await req('GET', '/v1/tickets', undefined, bearer(S.A)),
    await req('GET', '/v1/ratings/badge'),
  ];
  return probes.every((p) => !p.body.includes('FAKE_DISCORD_BOT_TOKEN') &&
    !p.body.includes('credential_hash'));
});

// --- run -------------------------------------------------------------
(async () => {
  console.log('=== support-framework suite ===');
  console.log('');
  await ready;
  await db.query(
    'TRUNCATE dashboard_messages, outbox, ticket_events, ratings, ticket_messages, tickets, installations RESTART IDENTITY CASCADE'
  );
  await db.query('ALTER SEQUENCE ticket_case_seq RESTART WITH 1');

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
