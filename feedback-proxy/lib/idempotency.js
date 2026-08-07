/**
 * Idempotency-Key handling via idempotency_records (operator schema):
 * the first request stores its response; a retry with the same key replays
 * that stored response byte-for-byte; the same key with a DIFFERENT request
 * body is a 409. The record insert shares the handler's transaction, so a
 * retry can never observe the side effects without the record.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const { json, fail } = require('./http');

const RETENTION = "now() + interval '24 hours'";

/**
 * fn(client) performs the write and returns { status, body }.
 * rawBody is the raw request Buffer (hashed to detect key reuse).
 */
async function withIdempotency(res, inst, key, rawBody, fn) {
  const reqHash = crypto.createHash('sha256').update(rawBody).digest();
  const find = async () => (await db.query(
    'SELECT request_hash, response_status, response_body FROM idempotency_records ' +
      'WHERE installation_id = $1 AND key = $2 AND expires_at > now()',
    [inst.id, key]
  )).rows[0];

  let rec = await find();
  if (!rec) {
    try {
      rec = await db.tx(async (client) => {
        const out = await fn(client);
        await client.query(
          'INSERT INTO idempotency_records ' +
            '(installation_id, key, request_hash, response_status, response_body, expires_at) ' +
            `VALUES ($1, $2, $3, $4, $5, ${RETENTION})`,
          [inst.id, key, reqHash, out.status, JSON.stringify(out.body)]
        );
        return { request_hash: reqHash, response_status: out.status, response_body: out.body };
      });
    } catch (e) {
      if (e.code !== '23505') throw e;
      rec = await find(); // lost a concurrent race with the same key
      if (!rec) throw e;
    }
  }
  if (!Buffer.from(rec.request_hash).equals(reqHash)) {
    return fail(res, 409, 'idempotency_conflict',
      'This Idempotency-Key was already used with a different request.');
  }
  return json(res, rec.response_status, rec.response_body);
}

module.exports = { withIdempotency };
