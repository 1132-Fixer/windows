/**
 * Idempotency-Key handling via idempotency_requests.
 *
 * First request stores its response; a retry with the same key AND the same
 * body replays it; the same key with a DIFFERENT body is a 409. The record
 * insert shares the handler's transaction, so a retry never observes the
 * side effects without the record — and a replay never re-enqueues outbox
 * work, so retries never send a second ping.
 *
 * Expiry is a reclaim, not a tombstone: an expired row is overwritten by the
 * next use of that key (ON CONFLICT ... DO UPDATE guarded on expires_at), so
 * a client that reuses a key after the retention window still completes.
 * purgeExpired() keeps the table bounded.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const { json, fail } = require('./http');

const RETENTION_HOURS = 24;

/**
 * fn(client) performs the write and returns { status, body }.
 * rawBody is the raw request Buffer (digested to detect key reuse).
 */
async function withIdempotency(res, principal, key, rawBody, fn) {
  const digest = crypto.createHash('sha256').update(rawBody).digest();
  const find = async () => (await db.query(
    'SELECT request_digest, response_status, response_body FROM idempotency_requests ' +
      'WHERE principal_id = $1 AND key = $2 AND expires_at > now()',
    [principal.id, key]
  )).rows[0];

  let rec = await find();
  if (!rec) {
    try {
      rec = await db.tx(async (client) => {
        const out = await fn(client);
        const ins = await client.query(
          'INSERT INTO idempotency_requests ' +
            '(principal_id, key, request_digest, response_status, response_body, expires_at) ' +
            `VALUES ($1, $2, $3, $4, $5, now() + interval '${RETENTION_HOURS} hours') ` +
            'ON CONFLICT (principal_id, key) DO UPDATE SET ' +
            'request_digest = EXCLUDED.request_digest, response_status = EXCLUDED.response_status, ' +
            'response_body = EXCLUDED.response_body, expires_at = EXCLUDED.expires_at, ' +
            'created_at = now() ' +
            // Only an EXPIRED row may be reclaimed; a live one must not be
            // overwritten, so the conflict yields no row and we re-read it.
            'WHERE idempotency_requests.expires_at <= now() ' +
            'RETURNING request_digest, response_status, response_body',
          [principal.id, key, digest, out.status, JSON.stringify(out.body)]
        );
        if (!ins.rows[0]) {
          // A live row won the race: discard this attempt's side effects and
          // replay the stored response instead.
          const e = new Error('idempotency_live_row');
          e.replay = true;
          throw e;
        }
        return ins.rows[0];
      });
    } catch (e) {
      if (!e.replay && e.code !== '23505') throw e;
      rec = await find();
      if (!rec) throw e;
    }
  }
  if (!Buffer.from(rec.request_digest).equals(digest)) {
    return fail(res, 409, 'idempotency_conflict',
      'This Idempotency-Key was already used with a different request.');
  }
  return json(res, rec.response_status, rec.response_body);
}

/** Bound the table; called from the worker tick. */
async function purgeExpired() {
  const { rowCount } = await db.query(
    "DELETE FROM idempotency_requests WHERE expires_at <= now() - interval '1 hour'"
  );
  return rowCount;
}

module.exports = { withIdempotency, purgeExpired };
