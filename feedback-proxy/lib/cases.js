/**
 * Support cases (final directive schema: support_cases / case_messages /
 * case_events / inbox_receipts / discord_case_bindings).
 *
 * Public identifier is the random caseRef ('FX-…'); message ids are random
 * 'MS-…'. Client responses never contain database ids, Discord ids,
 * priority, or assignee. Staff-only notes live in internal_notes and are
 * never queried by any user-facing path.
 *
 * State machine: user replies move waiting_for_user -> in_review and
 * resolved -> reopened; spam locks the case for users; staff transitions
 * come only through verified Discord interactions. Every state change bumps
 * support_cases.control_epoch (stale Discord controls are rejected) and
 * writes a case_events row.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const ids = require('./ids');
const outbox = require('./outbox');
const inbox = require('./inbox');
const { withIdempotency } = require('./idempotency');
const { json, fail, readBody, clean } = require('./http');

const MAX_BODY_BYTES = 32 * 1024;
const SUBJECT_MIN = 3;
const SUBJECT_MAX = 120;
const SUMMARY_MAX = 8000;

// Temporary compatibility map for the new API only: older clients say
// 'Contact'; the stable API value is 'feedback'. Remove after client cutover.
const KIND_ALIASES = new Map([
  ['bug', 'bug'],
  ['feedback', 'feedback'],
  ['Contact', 'feedback'],
  ['contact', 'feedback'],
]);

// ---- helpers --------------------------------------------------------

/** Error body in the standard shape, for responses stored/replayed by the idempotency layer. */
function errBody(code, message) {
  return { error: { code, message, requestId: 'req_' + crypto.randomBytes(4).toString('hex').toUpperCase() } };
}

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

function addCaseEvent(client, caseId, actorType, actorRef, eventType, data) {
  return client.query(
    'INSERT INTO case_events (case_id, actor_type, actor_ref, event_type, data) ' +
      'VALUES ($1, $2, $3, $4, $5)',
    [caseId, actorType, actorRef, eventType, JSON.stringify(data || {})]
  );
}

async function nextCaseSeq(client, caseId) {
  const { rows } = await client.query(
    'SELECT coalesce(max(case_seq), 0) + 1 AS n FROM case_messages WHERE case_id = $1',
    [caseId]
  );
  return Number(rows[0].n);
}

async function insertMessage(client, caseRow, author, body, opts) {
  const seq = await nextCaseSeq(client, caseRow.id);
  const { rows } = await client.query(
    'INSERT INTO case_messages (public_id, case_id, case_seq, author, body, staff_discord_user_id, idempotency_key) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, public_id, case_seq, created_at',
    [ids.newMessageId(), caseRow.id, seq, author, body,
     (opts && opts.staffUserId) || null, opts.idempotencyKey]
  );
  return rows[0];
}

/**
 * Insert a case + first user message + audit event + outbox alert on the
 * caller's transaction. Also used by ratings.js (kind 'rating_feedback').
 */
async function insertCase(client, principal, fields, idemKey) {
  const caseRef = ids.newCaseRef();
  const { rows } = await client.query(
    'INSERT INTO support_cases ' +
      '(case_ref, principal_id, kind, product, app_version, subject, summary, environment, diagnostics_consent) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
    [caseRef, principal.id, fields.kind, principal.product,
     fields.appVersion || principal.app_version,
     fields.subject, fields.summary, JSON.stringify(fields.environment || {}),
     Boolean(fields.diagnosticsConsent)]
  );
  const c = rows[0];
  await insertMessage(client, c, 'user', fields.summary, { idempotencyKey: idemKey + ':initial' });
  await addCaseEvent(client, c.id, 'user', principal.public_id, 'case.created', { kind: fields.kind });
  await outbox.enqueue(client, 'case', c.id, 'case.created', {
    case_id: c.id,
    case_ref: c.case_ref,
    kind: c.kind,
    state: c.state,
    priority: c.priority,
    product: c.product,
    app_version: c.app_version,
    subject: c.subject,
    summary: c.summary,
    environment: fields.environment || {},
    created_at: c.created_at.toISOString(),
  });
  return c;
}

/** Directive state rules: what a user reply does to the case. */
function userReplyState(state) {
  if (state === 'waiting_for_user') return 'in_review';
  if (state === 'resolved') return 'reopened';
  return null; // unchanged
}

async function setState(client, caseRow, toState, actorType, actorRef) {
  // $1 appears twice; explicit casts keep parameter typing consistent.
  await client.query(
    'UPDATE support_cases SET state = $1::case_state, control_epoch = control_epoch + 1, updated_at = now(), ' +
      "resolved_at = CASE WHEN $1::text = 'resolved' THEN now() ELSE resolved_at END WHERE id = $2",
    [toState, caseRow.id]
  );
  await addCaseEvent(client, caseRow.id, actorType, actorRef, 'state.changed',
    { from: caseRow.state, to: toState });
}

// ---- client route handlers ------------------------------------------

/** POST /v1/cases — bug | feedback ('Contact' temporarily mapped to feedback). */
async function create(req, res, principal) {
  const raw = await readRaw(req, res);
  if (!raw) return;
  const idemKey = requireIdemKey(req, res);
  if (!idemKey) return;
  const payload = parseJson(raw, res);
  if (!payload) return;

  const kind = KIND_ALIASES.get(clean(payload.type, 20));
  if (!kind) {
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

  return withIdempotency(res, principal, idemKey, raw, async (client) => {
    const c = await insertCase(client, principal, fields, idemKey);
    return {
      status: 201,
      body: { caseRef: c.case_ref, kind: c.kind, state: c.state, subject: c.subject, createdAt: c.created_at },
    };
  });
}

/** POST /v1/cases/{caseRef}/messages — user reply. */
async function addMessage(req, res, principal, caseRef) {
  const raw = await readRaw(req, res);
  if (!raw) return;
  const idemKey = requireIdemKey(req, res);
  if (!idemKey) return;
  const payload = parseJson(raw, res);
  if (!payload) return;
  const body = clean(payload.body, SUMMARY_MAX);
  if (!body) return fail(res, 400, 'validation_failed', 'body is required.');

  return withIdempotency(res, principal, idemKey, raw, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM support_cases WHERE case_ref = $1 AND principal_id = $2 FOR UPDATE',
      [caseRef, principal.id]
    );
    const c = rows[0];
    if (!c) return { status: 404, body: errBody('not_found', 'No such case.') };
    if (c.state === 'spam') {
      return { status: 409, body: errBody('case_locked', 'This case does not accept replies.') };
    }
    const m = await insertMessage(client, c, 'user', body, { idempotencyKey: idemKey });
    const to = userReplyState(c.state);
    if (to) await setState(client, c, to, 'user', principal.public_id);
    else await client.query('UPDATE support_cases SET updated_at = now() WHERE id = $1', [c.id]);
    await addCaseEvent(client, c.id, 'user', principal.public_id, 'message.created', { case_seq: m.case_seq });
    await inbox.markCaseReplied(client, c.id);
    await outbox.enqueue(client, 'message', m.id, 'message.created', {
      case_id: c.id, case_ref: c.case_ref, author: 'user', body,
    });
    return {
      status: 201,
      body: {
        caseRef: c.case_ref,
        state: to || c.state,
        message: { messageId: m.public_id, author: 'user', body, createdAt: m.created_at },
      },
    };
  });
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

async function lockCase(client, caseRef) {
  const { rows } = await client.query(
    'SELECT * FROM support_cases WHERE case_ref = $1 FOR UPDATE', [caseRef]
  );
  if (!rows[0]) throw staffError('case_not_found');
  if (rows[0].state === 'spam') throw staffError('case_locked');
  return rows[0];
}

/** Current control epoch, for embedding into the reply modal's custom_id. */
async function currentEpoch(caseRef) {
  const { rows } = await db.query(
    'SELECT control_epoch FROM support_cases WHERE case_ref = $1', [caseRef]
  );
  if (!rows[0]) throw staffError('case_not_found');
  return rows[0].control_epoch;
}

/**
 * Staff reply from the Discord modal. expectedEpoch is the control epoch
 * captured when the modal was opened — a mismatch means the case changed
 * underneath the form (stale controls cannot change a newer case).
 */
async function staffReply(caseRef, { body, statusWord, staffUserId, interactionId, expectedEpoch }) {
  const to = STAFF_STATUS_WORDS.get(statusWord);
  if (!to) throw staffError('bad_status_word');
  const out = await db.tx(async (client) => {
    const c = await lockCase(client, caseRef);
    if (c.control_epoch !== expectedEpoch) throw staffError('stale_epoch');
    const m = await insertMessage(client, c, 'staff', body,
      { staffUserId, idempotencyKey: 'discord:' + interactionId });
    await inbox.addReceipt(client, m.id, c.principal_id);
    await addCaseEvent(client, c.id, 'staff', staffUserId, 'message.created', { case_seq: m.case_seq });
    if (to !== c.state) await setState(client, c, to, 'staff', staffUserId);
    else await client.query('UPDATE support_cases SET updated_at = now() WHERE id = $1', [c.id]);
    return { caseRef: c.case_ref, state: to, principalId: c.principal_id };
  });
  inbox.notifyPrincipal(out.principalId); // post-commit SSE nudge
  return out;
}

/** Resolve button. Idempotent: an already resolved case stays resolved. */
async function staffResolve(caseRef, staffUserId) {
  return db.tx(async (client) => {
    const c = await lockCase(client, caseRef);
    if (c.state !== 'resolved') await setState(client, c, 'resolved', 'staff', staffUserId);
    return { caseRef: c.case_ref, state: 'resolved' };
  });
}

module.exports = {
  create, addMessage,
  insertCase, staffReply, staffResolve, currentEpoch,
};
