/**
 * Support cases (operator schema: support_cases / case_messages / case_events).
 *
 * Public identifier is the random case id ('FX-…'). Client responses never
 * contain database ids, Discord ids, priority, assignee, or internal
 * messages (visibility = 'internal' is filtered in SQL, not in JS).
 *
 * State machine (framework spec): user replies move waiting_for_user ->
 * in_review and resolved -> reopened; spam locks the case for users; staff
 * transitions come only through verified Discord interactions. Every state
 * change bumps support_cases.version (optimistic lock for stale buttons)
 * and writes a case_events row.
 */
'use strict';

const db = require('./db');
const ids = require('./ids');
const outbox = require('./outbox');
const { withIdempotency } = require('./idempotency');
const { json, fail, readBody, clean } = require('./http');

const MAX_BODY_BYTES = 32 * 1024;
const SUBJECT_MIN = 3;
const SUBJECT_MAX = 120;
const SUMMARY_MAX = 8000;
const KINDS = new Set(['bug', 'feedback']); // rating_feedback is created only by ratings routing
const TOPICS = new Set(['compliment', 'suggestion', 'concern', 'general', 'other']);

// ---- serialization --------------------------------------------------

function toClientCase(c) {
  return {
    caseId: c.public_id,
    kind: c.kind,
    state: c.state,
    subject: c.subject,
    appVersion: c.app_version,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function toClientMessage(m) {
  return { author: m.author, body: m.body, createdAt: m.created_at, delivery: m.delivery };
}

// ---- shared helpers -------------------------------------------------

async function readRaw(req, res) {
  try {
    return await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e && e.code === 413) fail(res, 413, 'too_large', 'Request body is too large.');
    else fail(res, 400, 'bad_request', 'Could not read the request.');
    return null;
  }
}

function parseJson(raw, res) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    fail(res, 400, 'bad_json', 'Send a JSON body.');
    return null;
  }
}

function requireIdemKey(req, res) {
  const key = clean(req.headers['idempotency-key'], 100);
  if (!key) fail(res, 400, 'missing_idempotency_key', 'Send an Idempotency-Key header.');
  return key || null;
}

/** Error body in the standard shape, for responses stored/replayed by the idempotency layer. */
function errBody(code, message) {
  const crypto = require('crypto');
  return { error: { code, message, requestId: 'req_' + crypto.randomBytes(4).toString('hex').toUpperCase() } };
}

function addCaseEvent(client, caseId, actorType, actorRef, eventType, data) {
  return client.query(
    'INSERT INTO case_events (case_id, actor_type, actor_ref, event_type, data) ' +
      'VALUES ($1, $2, $3, $4, $5)',
    [caseId, actorType, actorRef, eventType, JSON.stringify(data || {})]
  );
}

/**
 * Insert a case + first user message + audit event + outbox alert on the
 * caller's transaction. Also used by ratings.js (kind 'rating_feedback')
 * and the feedback route.
 */
async function insertCase(client, inst, fields, idemKey) {
  const publicId = ids.newCaseId();
  const { rows } = await client.query(
    'INSERT INTO support_cases ' +
      '(public_id, installation_id, kind, source, app_version, subject, summary, environment, diagnostics_consent) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
    [publicId, inst.id, fields.kind, inst.source, fields.appVersion || inst.app_version,
     fields.subject, fields.summary, JSON.stringify(fields.environment || {}),
     Boolean(fields.diagnosticsConsent)]
  );
  const c = rows[0];
  await client.query(
    "INSERT INTO case_messages (case_id, author, visibility, body, delivery, available_at, idempotency_key) " +
      "VALUES ($1, 'user', 'user', $2, 'available', now(), $3)",
    [c.id, fields.summary, idemKey + ':initial']
  );
  await addCaseEvent(client, c.id, 'user', inst.public_id, 'case.created', { kind: fields.kind });
  await outbox.enqueue(client, 'case', c.id, 'case.created', {
    case_id: c.id,
    public_id: c.public_id,
    kind: c.kind,
    state: c.state,
    priority: c.priority,
    source: c.source,
    app_version: c.app_version,
    subject: c.subject,
    summary: c.summary,
    environment: fields.environment || {},
    created_at: c.created_at.toISOString(),
  });
  return c;
}

/** Framework §case-state: what a user reply does to the case. */
function userReplyState(state) {
  if (state === 'waiting_for_user') return 'in_review';
  if (state === 'resolved') return 'reopened';
  return null; // unchanged
}

async function setState(client, caseRow, toState, actorType, actorRef) {
  // $1 appears twice ($1::case_state assignment + $1::text comparison); the
  // explicit casts keep Postgres from deducing inconsistent parameter types.
  await client.query(
    'UPDATE support_cases SET state = $1::case_state, version = version + 1, updated_at = now(), ' +
      "resolved_at = CASE WHEN $1::text = 'resolved' THEN now() ELSE resolved_at END WHERE id = $2",
    [toState, caseRow.id]
  );
  await addCaseEvent(client, caseRow.id, actorType, actorRef, 'state.changed',
    { from: caseRow.state, to: toState });
}

// ---- client route handlers ------------------------------------------

async function create(req, res, inst) {
  const raw = await readRaw(req, res);
  if (!raw) return;
  const idemKey = requireIdemKey(req, res);
  if (!idemKey) return;
  const payload = parseJson(raw, res);
  if (!payload) return;

  const kind = clean(payload.type, 20);
  if (!KINDS.has(kind)) {
    return fail(res, 400, 'validation_failed', 'type must be bug or feedback.');
  }
  const subject = clean(payload.title, SUBJECT_MAX);
  if (subject.length < SUBJECT_MIN) {
    return fail(res, 400, 'validation_failed', `title must be ${SUBJECT_MIN}-${SUBJECT_MAX} characters.`);
  }
  const summary = clean(payload.description, SUMMARY_MAX);
  if (!summary) return fail(res, 400, 'validation_failed', 'description is required.');

  const environment = {};
  for (const k of ['impact', 'steps', 'expectedResult', 'actualResult', 'os']) {
    const v = clean(payload[k], 1000);
    if (v) environment[k] = v;
  }
  const fields = {
    kind, subject, summary, environment,
    appVersion: clean(payload.appVersion, 40) || null,
    diagnosticsConsent: payload.diagnosticsConsent === true,
  };

  return withIdempotency(res, inst, idemKey, raw, async (client) => {
    const c = await insertCase(client, inst, fields, idemKey);
    return { status: 201, body: { case: toClientCase(c) } };
  });
}

/** POST /api/v1/feedback — compliments are counted, everything else is a case. */
async function feedback(req, res, inst) {
  const raw = await readRaw(req, res);
  if (!raw) return;
  const idemKey = requireIdemKey(req, res);
  if (!idemKey) return;
  const payload = parseJson(raw, res);
  if (!payload) return;

  const topic = clean(payload.topic, 20);
  if (!TOPICS.has(topic)) {
    return fail(res, 400, 'validation_failed',
      'topic must be compliment, suggestion, concern, general, or other.');
  }
  const message = clean(payload.message, 4000);
  if (topic !== 'compliment' && !message) {
    return fail(res, 400, 'validation_failed', 'message is required.');
  }

  if (topic === 'compliment') {
    // Operator routing rule: positive compliment -> saved and counted,
    // NO case, NO Discord message, NO alert.
    return withIdempotency(res, inst, idemKey, raw, async (client) => {
      await client.query(
        'INSERT INTO positive_feedback (installation_id, source, app_version, body, idempotency_key) ' +
          'VALUES ($1, $2, $3, $4, $5)',
        [inst.id, inst.source, clean(payload.appVersion, 40) || inst.app_version, message || null, idemKey]
      );
      return { status: 201, body: { saved: true, topic: 'compliment' } };
    });
  }

  const fields = {
    kind: 'feedback',
    subject: `Feedback — ${topic}`,
    summary: message,
    environment: {},
    appVersion: clean(payload.appVersion, 40) || null,
  };
  return withIdempotency(res, inst, idemKey, raw, async (client) => {
    const c = await insertCase(client, inst, fields, idemKey);
    return { status: 201, body: { case: toClientCase(c) } };
  });
}

async function unreadCount(installationId) {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM case_messages m JOIN support_cases c ON c.id = m.case_id " +
      "WHERE c.installation_id = $1 AND m.visibility = 'user' AND m.author <> 'user' AND m.delivery <> 'read'",
    [installationId]
  );
  return rows[0].n;
}

async function list(req, res, inst) {
  const { rows } = await db.query(
    'SELECT * FROM support_cases WHERE installation_id = $1 ORDER BY updated_at DESC LIMIT 100',
    [inst.id]
  );
  return json(res, 200, { cases: rows.map(toClientCase), unreadCount: await unreadCount(inst.id) });
}

async function getCaseRow(inst, casePublicId) {
  const { rows } = await db.query(
    'SELECT * FROM support_cases WHERE public_id = $1 AND installation_id = $2',
    [casePublicId, inst.id]
  );
  return rows[0] || null;
}

async function get(req, res, inst, casePublicId) {
  const c = await getCaseRow(inst, casePublicId);
  if (!c) return fail(res, 404, 'not_found', 'No such case.');
  const { rows } = await db.query(
    "SELECT author, body, delivery, created_at FROM case_messages " +
      "WHERE case_id = $1 AND visibility = 'user' ORDER BY created_at",
    [c.id]
  );
  // Delivered = stored and available to the client (plan non-negotiable).
  await db.query(
    "UPDATE case_messages SET delivery = 'available', available_at = now() " +
      "WHERE case_id = $1 AND visibility = 'user' AND author <> 'user' AND delivery = 'queued'",
    [c.id]
  );
  return json(res, 200, { case: toClientCase(c), messages: rows.map(toClientMessage) });
}

async function addMessage(req, res, inst, casePublicId) {
  const raw = await readRaw(req, res);
  if (!raw) return;
  const idemKey = requireIdemKey(req, res);
  if (!idemKey) return;
  const payload = parseJson(raw, res);
  if (!payload) return;
  const body = clean(payload.body, SUMMARY_MAX);
  if (!body) return fail(res, 400, 'validation_failed', 'body is required.');

  return withIdempotency(res, inst, idemKey, raw, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM support_cases WHERE public_id = $1 AND installation_id = $2 FOR UPDATE',
      [casePublicId, inst.id]
    );
    const c = rows[0];
    if (!c) return { status: 404, body: errBody('not_found', 'No such case.') };
    if (c.state === 'spam') {
      return { status: 409, body: errBody('case_locked', 'This case does not accept replies.') };
    }
    const ins = await client.query(
      "INSERT INTO case_messages (case_id, author, visibility, body, delivery, available_at, idempotency_key) " +
        "VALUES ($1, 'user', 'user', $2, 'available', now(), $3) RETURNING author, body, delivery, created_at",
      [c.id, body, idemKey]
    );
    const to = userReplyState(c.state);
    if (to) await setState(client, c, to, 'user', inst.public_id);
    else await client.query('UPDATE support_cases SET updated_at = now() WHERE id = $1', [c.id]);
    await addCaseEvent(client, c.id, 'user', inst.public_id, 'message.created', {});
    await outbox.enqueue(client, 'message', c.id, 'message.created', {
      case_id: c.id, public_id: c.public_id, author: 'user', body,
    });
    return {
      status: 201,
      body: { caseId: c.public_id, state: to || c.state, message: toClientMessage(ins.rows[0]) },
    };
  });
}

async function markRead(req, res, inst, casePublicId) {
  const c = await getCaseRow(inst, casePublicId);
  if (!c) return fail(res, 404, 'not_found', 'No such case.');
  await db.query(
    "UPDATE case_messages SET delivery = 'read', read_at = now() " +
      "WHERE case_id = $1 AND visibility = 'user' AND author <> 'user' AND delivery <> 'read'",
    [c.id]
  );
  return json(res, 200, { caseId: c.public_id, unreadCount: await unreadCount(inst.id) });
}

// ---- staff operations (verified Discord interactions only) ----------

function staffError(code) {
  return Object.assign(new Error(code), { staff: true, code });
}

const STAFF_STATUS_WORDS = new Map([
  ['', 'waiting_for_user'],
  ['waiting', 'waiting_for_user'],
  ['review', 'in_review'],
  ['resolve', 'resolved'],
]);

async function lockCase(client, casePublicId) {
  const { rows } = await client.query(
    'SELECT * FROM support_cases WHERE public_id = $1 FOR UPDATE', [casePublicId]
  );
  if (!rows[0]) throw staffError('case_not_found');
  if (rows[0].state === 'spam') throw staffError('case_locked');
  return rows[0];
}

/** Current version, for embedding into the reply modal's custom_id. */
async function currentVersion(casePublicId) {
  const { rows } = await db.query(
    'SELECT version FROM support_cases WHERE public_id = $1', [casePublicId]
  );
  if (!rows[0]) throw staffError('case_not_found');
  return rows[0].version;
}

/**
 * Staff reply from the Discord modal. expectedVersion is the case version
 * captured when the modal was opened — a mismatch means the case changed
 * underneath the form (optimistic lock, spec pack requirement).
 */
async function staffReply(casePublicId, { body, statusWord, staffUserId, interactionId, expectedVersion }) {
  const to = STAFF_STATUS_WORDS.get(statusWord);
  if (!to) throw staffError('bad_status_word');
  return db.tx(async (client) => {
    const c = await lockCase(client, casePublicId);
    if (c.version !== expectedVersion) throw staffError('stale_version');
    await client.query(
      "INSERT INTO case_messages (case_id, author, visibility, body, staff_discord_user_id, idempotency_key) " +
        "VALUES ($1, 'staff', 'user', $2, $3, $4)",
      [c.id, body, staffUserId, 'discord:' + interactionId]
    );
    await addCaseEvent(client, c.id, 'staff', staffUserId, 'message.created', {});
    if (to !== c.state) await setState(client, c, to, 'staff', staffUserId);
    else await client.query('UPDATE support_cases SET updated_at = now() WHERE id = $1', [c.id]);
    return { caseId: c.public_id, state: to };
  });
}

/** Resolve button. Idempotent: an already resolved case stays resolved. */
async function staffResolve(casePublicId, staffUserId) {
  return db.tx(async (client) => {
    const c = await lockCase(client, casePublicId);
    if (c.state !== 'resolved') await setState(client, c, 'resolved', 'staff', staffUserId);
    return { caseId: c.public_id, state: 'resolved' };
  });
}

module.exports = {
  create, feedback, list, get, addMessage, markRead,
  insertCase, staffReply, staffResolve, currentVersion,
};
