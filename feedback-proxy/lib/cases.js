/**
 * Cases: tickets, messages, state machine (plan §6), audit events.
 *
 * Public identifier is the case_ref ('F-0001'); internal uuids, Discord ids,
 * priority, and assignee never appear in client responses (plan §14).
 */
'use strict';

const db = require('./db');
const outbox = require('./outbox');
const { json, readBody, clean } = require('./http');

const MAX_BODY_BYTES = 16 * 1024;
const SUBJECT_MAX = 200;
const MESSAGE_MAX = 8000;
const IDEM_KEY_MAX = 100;

// ---- helpers -------------------------------------------------------

function toClientTicket(t) {
  return {
    id: t.case_ref,
    type: t.type,
    subject: t.subject,
    status: t.status,
    close_reason: t.close_reason || null,
    app_version: t.app_version || null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function toClientMessage(m) {
  return { sequence: Number(m.sequence), author: m.author, body: m.body, created_at: m.created_at };
}

function idemKeyOf(req) {
  return clean(req.headers['idempotency-key'], IDEM_KEY_MAX);
}

async function readJson(req, res) {
  try {
    return JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'));
  } catch (e) {
    if (e && e.code === 413) json(res, 413, { ok: false, error: 'too_large' });
    else json(res, 400, { ok: false, error: 'bad_json' });
    return null;
  }
}

function addEvent(client, ticketId, event, detail) {
  return client.query(
    'INSERT INTO ticket_events (ticket_id, event, detail) VALUES ($1, $2, $3)',
    [ticketId, event, detail ? JSON.stringify(detail) : null]
  );
}

async function nextCaseRef(client) {
  const { rows } = await client.query("SELECT nextval('ticket_case_seq') AS n");
  return 'F-' + String(rows[0].n).padStart(4, '0');
}

async function nextSequence(client, ticketId) {
  const { rows } = await client.query(
    'SELECT coalesce(max(sequence), 0) + 1 AS n FROM ticket_messages WHERE ticket_id = $1',
    [ticketId]
  );
  return Number(rows[0].n);
}

/** Plan §6: what a user reply does to the case status. */
function userReplyStatus(status) {
  if (status === 'WAITING_FOR_USER') return 'USER_REPLIED';
  if (status === 'RESOLVED') return 'USER_REPLIED'; // reopen
  return status;
}

/**
 * Insert a ticket + optional first user message + audit event + outbox alert,
 * all on the caller's transaction client. Also used by ratings.js for the
 * negative-rating case path.
 */
async function insertTicket(client, installation, fields, idemKey) {
  const caseRef = await nextCaseRef(client);
  const { rows } = await client.query(
    'INSERT INTO tickets (case_ref, installation_id, type, subject, app_version, os_info, idempotency_key) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [caseRef, installation.id, fields.type, fields.subject,
     fields.app_version || null, fields.os_info || null, idemKey || null]
  );
  const t = rows[0];
  if (fields.body) {
    await client.query(
      "INSERT INTO ticket_messages (ticket_id, sequence, author, body) VALUES ($1, 1, 'user', $2)",
      [t.id, fields.body]
    );
  }
  await addEvent(client, t.id, 'created', { type: fields.type, by: 'user' });
  await outbox.enqueue(client, 'ticket.created', {
    ticket_id: t.id,
    case_ref: caseRef,
    type: fields.type,
    subject: fields.subject,
    app_version: fields.app_version || null,
    os_info: fields.os_info || null,
    installation_public_id: installation.public_id,
    body: fields.body || null,
    created_at: t.created_at.toISOString(),
  });
  return t;
}

// ---- client route handlers ----------------------------------------

async function create(req, res, inst) {
  const payload = await readJson(req, res);
  if (!payload) return;
  const idemKey = idemKeyOf(req);
  if (!idemKey) return json(res, 400, { ok: false, error: 'missing_idempotency_key' });

  const type = clean(payload.type, 20);
  // Rating cases are created only by the /v1/ratings routing rule, never directly.
  if (type !== 'bug' && type !== 'message') {
    return json(res, 400, { ok: false, error: 'bad_type' });
  }
  const subject = clean(payload.subject, SUBJECT_MAX);
  if (!subject) return json(res, 400, { ok: false, error: 'empty_subject' });
  const fields = {
    type,
    subject,
    body: clean(payload.body, MESSAGE_MAX) || null,
    app_version: clean(payload.app_version, 40) || null,
    os_info: clean(payload.os_info, 120) || null,
  };

  const findExisting = async () => {
    const { rows } = await db.query(
      'SELECT * FROM tickets WHERE installation_id = $1 AND idempotency_key = $2',
      [inst.id, idemKey]
    );
    return rows[0] || null;
  };

  let ticket = await findExisting(); // retry returns the SAME ticket (plan §14)
  if (!ticket) {
    try {
      ticket = await db.tx((client) => insertTicket(client, inst, fields, idemKey));
    } catch (e) {
      if (e.code === '23505') ticket = await findExisting(); // lost a concurrent race
      if (!ticket) throw e;
    }
  }
  return json(res, 201, { ok: true, ticket: toClientTicket(ticket) });
}

async function list(req, res, inst) {
  const { rows } = await db.query(
    'SELECT * FROM tickets WHERE installation_id = $1 ORDER BY updated_at DESC LIMIT 100',
    [inst.id]
  );
  return json(res, 200, { ok: true, tickets: rows.map(toClientTicket) });
}

async function getTicketRow(inst, caseRef) {
  const { rows } = await db.query(
    'SELECT * FROM tickets WHERE case_ref = $1 AND installation_id = $2',
    [caseRef, inst.id]
  );
  return rows[0] || null;
}

async function get(req, res, inst, caseRef) {
  const t = await getTicketRow(inst, caseRef);
  if (!t) return json(res, 404, { ok: false, error: 'not_found' });
  return json(res, 200, { ok: true, ticket: toClientTicket(t) });
}

async function listMessages(req, res, inst, caseRef, searchParams) {
  const t = await getTicketRow(inst, caseRef);
  if (!t) return json(res, 404, { ok: false, error: 'not_found' });
  const after = Math.max(0, Number(searchParams.get('after')) || 0);
  const { rows } = await db.query(
    'SELECT sequence, author, body, created_at FROM ticket_messages ' +
      'WHERE ticket_id = $1 AND sequence > $2 ORDER BY sequence',
    [t.id, after]
  );
  // The client has now seen these staff replies — that is what "delivered"
  // means (plan §14: stored and available to Windows).
  await db.query(
    "UPDATE ticket_messages SET delivered_to_client = true " +
      "WHERE ticket_id = $1 AND sequence > $2 AND author = 'staff' AND NOT delivered_to_client",
    [t.id, after]
  );
  return json(res, 200, { ok: true, messages: rows.map(toClientMessage) });
}

async function addMessage(req, res, inst, caseRef) {
  const payload = await readJson(req, res);
  if (!payload) return;
  const idemKey = idemKeyOf(req);
  if (!idemKey) return json(res, 400, { ok: false, error: 'missing_idempotency_key' });
  const body = clean(payload.body, MESSAGE_MAX);
  if (!body) return json(res, 400, { ok: false, error: 'empty_body' });

  let out;
  try {
    out = await db.tx(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM tickets WHERE case_ref = $1 AND installation_id = $2 FOR UPDATE',
        [caseRef, inst.id]
      );
      const t = rows[0];
      if (!t) return { error: [404, 'not_found'] };
      if (t.status === 'CLOSED') return { error: [409, 'closed'] }; // staff must reopen

      const dup = await client.query(
        'SELECT sequence, author, body, created_at FROM ticket_messages ' +
          'WHERE ticket_id = $1 AND idempotency_key = $2',
        [t.id, idemKey]
      );
      if (dup.rows[0]) return { message: dup.rows[0], status: t.status };

      const seq = await nextSequence(client, t.id);
      const ins = await client.query(
        "INSERT INTO ticket_messages (ticket_id, sequence, author, body, idempotency_key) " +
          "VALUES ($1, $2, 'user', $3, $4) RETURNING sequence, author, body, created_at",
        [t.id, seq, body, idemKey]
      );
      const newStatus = userReplyStatus(t.status);
      if (newStatus !== t.status) {
        await client.query('UPDATE tickets SET status = $1, updated_at = now() WHERE id = $2',
          [newStatus, t.id]);
        await addEvent(client, t.id, 'status.changed', { from: t.status, to: newStatus, by: 'user' });
      } else {
        await client.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [t.id]);
      }
      await addEvent(client, t.id, 'message.user', { sequence: seq });
      await outbox.enqueue(client, 'message.user', {
        ticket_id: t.id, case_ref: caseRef, sequence: seq, body,
      });
      return { message: ins.rows[0], status: newStatus };
    });
  } catch (e) {
    if (e.code !== '23505') throw e;
    // Concurrent retry with the same key: return the row the winner inserted.
    const t = await getTicketRow(inst, caseRef);
    const dup = t && (await db.query(
      'SELECT sequence, author, body, created_at FROM ticket_messages ' +
        'WHERE ticket_id = $1 AND idempotency_key = $2',
      [t.id, idemKey]
    )).rows[0];
    if (!dup) throw e;
    out = { message: dup, status: t.status };
  }
  if (out.error) return json(res, out.error[0], { ok: false, error: out.error[1] });
  return json(res, 201, { ok: true, message: toClientMessage(out.message), status: out.status });
}

// ---- staff operations (called from Discord interactions) -----------

function staffError(code) {
  return Object.assign(new Error(code), { staff: true, code });
}

const STAFF_STATUS_WORDS = new Map([
  ['', 'WAITING_FOR_USER'],
  ['waiting', 'WAITING_FOR_USER'],
  ['review', 'IN_PROGRESS'],
  ['resolve', 'RESOLVED'],
]);

async function lockTicketByRef(client, caseRef) {
  const { rows } = await client.query(
    'SELECT * FROM tickets WHERE case_ref = $1 FOR UPDATE', [caseRef]
  );
  if (!rows[0]) throw staffError('case_not_found');
  if (rows[0].status === 'CLOSED') throw staffError('case_closed');
  return rows[0];
}

/** Staff reply from the Discord modal: store message + optional transition. */
async function staffReply(caseRef, body, statusWord) {
  const to = STAFF_STATUS_WORDS.get(statusWord);
  if (!to) throw staffError('bad_status_word');
  return db.tx(async (client) => {
    const t = await lockTicketByRef(client, caseRef);
    const seq = await nextSequence(client, t.id);
    await client.query(
      "INSERT INTO ticket_messages (ticket_id, sequence, author, body) VALUES ($1, $2, 'staff', $3)",
      [t.id, seq, body]
    );
    await addEvent(client, t.id, 'message.staff', { sequence: seq });
    if (to !== t.status) {
      await client.query('UPDATE tickets SET status = $1, updated_at = now() WHERE id = $2', [to, t.id]);
      await addEvent(client, t.id, 'status.changed', { from: t.status, to, by: 'staff' });
    } else {
      await client.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [t.id]);
    }
    return { sequence: seq, status: to };
  });
}

/** Resolve button. */
async function staffResolve(caseRef) {
  return db.tx(async (client) => {
    const t = await lockTicketByRef(client, caseRef);
    if (t.status !== 'RESOLVED') {
      await client.query("UPDATE tickets SET status = 'RESOLVED', updated_at = now() WHERE id = $1", [t.id]);
      await addEvent(client, t.id, 'status.changed', { from: t.status, to: 'RESOLVED', by: 'staff' });
    }
    return { status: 'RESOLVED' };
  });
}

module.exports = {
  create, list, get, listMessages, addMessage,
  insertTicket, staffReply, staffResolve,
  SUBJECT_MAX, MESSAGE_MAX,
};
