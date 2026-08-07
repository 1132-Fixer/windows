/**
 * My Messages: the user-facing read surface for staff and system replies,
 * backed by inbox_receipts with the AVAILABLE -> NOTIFIED -> READ -> REPLIED
 * ladder.
 *
 * internal_notes is a separate table and is never queried here — an internal
 * note cannot appear in My Messages by construction.
 *
 * SSE: GET /v1/my-messages/events streams unread-count events. Single-replica
 * design (in-process emitter); concurrent streams per principal are capped
 * and the oldest is closed.
 */
'use strict';

const { EventEmitter } = require('events');
const db = require('./db');
const ids = require('./ids');
const { json, fail } = require('./http');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const HEARTBEAT_MS = 25000;
const MAX_STREAMS_PER_PRINCIPAL = 3;

// principal id -> array of open stream handles (oldest first)
const streams = new Map();

async function unreadCount(principalId) {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM inbox_receipts " +
      "WHERE principal_id = $1 AND state IN ('AVAILABLE', 'NOTIFIED')",
    [principalId]
  );
  return rows[0].n;
}

/** Fire after a staff/system message commit so SSE clients update at once. */
async function notifyPrincipal(principalId) {
  try {
    emitter.emit('p:' + principalId, await unreadCount(principalId));
  } catch (e) {
    console.error('[inbox] notify failed: ' + e.message);
  }
}

/** GET /v1/my-messages — staff/system replies across the principal's cases. */
async function list(req, res, principal) {
  // Consume the notification BEFORE reading, so the states returned match
  // what is persisted (a client rendering "new" badges cannot disagree).
  await db.query(
    "UPDATE inbox_receipts SET state = 'NOTIFIED', notified_at = now(), updated_at = now() " +
      "WHERE principal_id = $1 AND state = 'AVAILABLE'",
    [principal.id]
  );
  const { rows } = await db.query(
    'SELECT m.public_id, m.author, m.body, m.created_at, r.state AS receipt_state, ' +
      'c.case_ref, c.subject ' +
      'FROM inbox_receipts r ' +
      'JOIN case_messages m ON m.id = r.message_id ' +
      'JOIN support_cases c ON c.id = m.case_id ' +
      'WHERE r.principal_id = $1 ORDER BY m.created_at DESC LIMIT 200',
    [principal.id]
  );
  return json(res, 200, {
    messages: rows.map((m) => ({
      messageId: m.public_id,
      caseRef: m.case_ref,
      subject: m.subject,
      author: m.author,
      body: m.body,
      state: m.receipt_state,
      createdAt: m.created_at,
    })),
    unread: await unreadCount(principal.id),
  });
}

/** GET /v1/my-messages/unread-count */
async function unread(req, res, principal) {
  return json(res, 200, { unread: await unreadCount(principal.id) });
}

/** POST /v1/my-messages/{messageId}/read */
async function markRead(req, res, principal, messageId) {
  if (!ids.MESSAGE_ID_RE.test(messageId)) {
    return fail(res, 400, 'validation_failed', 'Malformed message id.');
  }
  const { rowCount } = await db.query(
    "UPDATE inbox_receipts r SET state = 'READ', read_at = now(), updated_at = now() " +
      'FROM case_messages m WHERE m.id = r.message_id AND m.public_id = $1 ' +
      "AND r.principal_id = $2 AND r.state IN ('AVAILABLE', 'NOTIFIED')",
    [messageId, principal.id]
  );
  if (!rowCount) {
    // Distinguish already-read (idempotent OK) from not-found.
    const { rows } = await db.query(
      'SELECT r.state FROM inbox_receipts r JOIN case_messages m ON m.id = r.message_id ' +
        'WHERE m.public_id = $1 AND r.principal_id = $2',
      [messageId, principal.id]
    );
    if (!rows[0]) return fail(res, 404, 'not_found', 'No such message.');
    return json(res, 200, { messageId, state: rows[0].state }); // repeat read is a no-op
  }
  return json(res, 200, { messageId, state: 'READ' });
}

/** Replying to a case marks every receipt on it REPLIED (caller's tx). */
async function markCaseReplied(client, caseId) {
  await client.query(
    "UPDATE inbox_receipts r SET state = 'REPLIED', replied_at = now(), updated_at = now() " +
      "FROM case_messages m WHERE m.id = r.message_id AND m.case_id = $1 AND r.state <> 'REPLIED'",
    [caseId]
  );
}

/**
 * Create the receipt for a new staff/system message (caller's tx).
 * `state` defaults to AVAILABLE (unread); a case's own creation receipt is
 * inserted as READ, so the case shows in My Messages without inflating the
 * unread badge with the user's own submission.
 */
async function addReceipt(client, messageUuid, principalId, state) {
  await client.query(
    'INSERT INTO inbox_receipts (message_id, principal_id, state, read_at) ' +
      "VALUES ($1, $2, $3::receipt_state, CASE WHEN $3::text = 'READ' THEN now() END) " +
      'ON CONFLICT (message_id) DO NOTHING',
    [messageUuid, principalId, state || 'AVAILABLE']
  );
}

function closeStream(principalId, handle) {
  const open = streams.get(principalId);
  if (open) {
    const i = open.indexOf(handle);
    if (i !== -1) open.splice(i, 1);
    if (!open.length) streams.delete(principalId);
  }
  clearInterval(handle.heartbeat);
  emitter.removeListener('p:' + principalId, handle.send);
  if (!handle.res.writableEnded) handle.res.end();
}

/** GET /v1/my-messages/events — SSE stream of unread counts. */
async function events(req, res, principal) {
  // Query BEFORE writing headers: a DB failure here must surface as a normal
  // JSON error, never as a throw after the response has started.
  const initial = await unreadCount(principal.id);

  const open = streams.get(principal.id) || [];
  while (open.length >= MAX_STREAMS_PER_PRINCIPAL) closeStream(principal.id, open[0]);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 5000\n\n');
  const send = (n) => {
    if (!res.writableEnded) res.write(`event: unread\ndata: {"unread":${n}}\n\n`);
  };
  send(initial);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  const handle = { res, send, heartbeat };
  heartbeat.unref();
  const list_ = streams.get(principal.id) || [];
  list_.push(handle);
  streams.set(principal.id, list_);
  emitter.on('p:' + principal.id, send);
  req.on('close', () => closeStream(principal.id, handle));
}

module.exports = {
  list, unread, markRead, events, addReceipt, markCaseReplied, notifyPrincipal,
  unreadCount, MAX_STREAMS_PER_PRINCIPAL,
};
