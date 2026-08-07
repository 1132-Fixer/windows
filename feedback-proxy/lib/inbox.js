/**
 * My Messages (final directive): the user-facing read surface for staff and
 * system replies, backed by inbox_receipts with the AVAILABLE -> NOTIFIED ->
 * READ -> REPLIED ladder.
 *
 * internal_notes is a separate table and is never queried here — an internal
 * note cannot appear in My Messages by construction.
 *
 * SSE: GET /v1/my-messages/events streams unread-count events. Single-replica
 * design (in-process emitter); the initial event carries the current count.
 */
'use strict';

const { EventEmitter } = require('events');
const db = require('./db');
const ids = require('./ids');
const { json, fail } = require('./http');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const HEARTBEAT_MS = 25000;

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
  const { rows } = await db.query(
    'SELECT m.public_id, m.author, m.body, m.created_at, r.state AS receipt_state, ' +
      'c.case_ref, c.subject ' +
      'FROM inbox_receipts r ' +
      'JOIN case_messages m ON m.id = r.message_id ' +
      'JOIN support_cases c ON c.id = m.case_id ' +
      'WHERE r.principal_id = $1 ORDER BY m.created_at DESC LIMIT 200',
    [principal.id]
  );
  // Listing the inbox is the NOTIFIED transition.
  await db.query(
    "UPDATE inbox_receipts SET state = 'NOTIFIED', notified_at = now(), updated_at = now() " +
      "WHERE principal_id = $1 AND state = 'AVAILABLE'",
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

/** Create the receipt for a new staff/system message (caller's tx). */
async function addReceipt(client, messageUuid, principalId) {
  await client.query(
    'INSERT INTO inbox_receipts (message_id, principal_id) VALUES ($1, $2)',
    [messageUuid, principalId]
  );
}

/** GET /v1/my-messages/events — SSE stream of unread counts. */
async function events(req, res, principal) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 5000\n\n');
  const send = (n) => res.write(`event: unread\ndata: {"unread":${n}}\n\n`);
  send(await unreadCount(principal.id));

  const channel = 'p:' + principal.id;
  emitter.on(channel, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    emitter.removeListener(channel, send);
  });
}

module.exports = { list, unread, markRead, events, addReceipt, markCaseReplied, notifyPrincipal, unreadCount };
