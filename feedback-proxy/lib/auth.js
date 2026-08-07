/**
 * Installation identity (operator spec):
 *   POST /api/v1/installations issues { installationId: 'IN-…', token } —
 *   the token appears in that response ONCE; the database stores only
 *   sha256(token + TOKEN_HASH_PEPPER) as bytea (unique).
 *
 * Auth: `Authorization: Bearer <token>` resolved by hash lookup. The stored
 * value is a preimage-resistant digest, so an exact index match is the
 * correct constant-behavior comparison; no plain secret is ever stored.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const ids = require('./ids');
const { json, fail, clientIp, readBody, clean, createRateLimiter } = require('./http');

const SOURCES = new Set(['windows', 'chrome', 'macos', 'website']);
const MAX_BODY_BYTES = 4 * 1024;

// Same limiter pattern and budget as the legacy /feedback endpoint.
const registerLimiter = createRateLimiter(5, 60 * 60 * 1000);

const pepper = () => process.env.TOKEN_HASH_PEPPER || '';

function hashToken(token) {
  return crypto.createHash('sha256').update(token + pepper()).digest();
}

async function register(req, res) {
  if (!pepper()) {
    // Without the pepper we would mint hashes a correctly configured
    // deployment could never verify. Refuse instead.
    console.error('[auth] TOKEN_HASH_PEPPER not set — refusing registration');
    return fail(res, 503, 'not_configured', 'Registration is not available right now.');
  }
  if (registerLimiter.limited(clientIp(req), Date.now())) {
    return fail(res, 429, 'rate_limited', 'Too many registrations from this address.');
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'));
  } catch {
    return fail(res, 400, 'bad_json', 'Send a JSON body.');
  }
  const source = clean(payload.source, 20);
  if (!SOURCES.has(source)) {
    return fail(res, 400, 'validation_failed', 'source must be windows, chrome, macos, or website.');
  }
  const appVersion = clean(payload.appVersion, 40);
  if (!appVersion) return fail(res, 400, 'validation_failed', 'appVersion is required.');
  const releaseChannel = clean(payload.releaseChannel, 20) || 'stable';

  const publicId = ids.newInstallationId();
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    'INSERT INTO installations (public_id, token_hash, source, app_version, release_channel) ' +
      'VALUES ($1, $2, $3, $4, $5)',
    [publicId, hashToken(token), source, appVersion, releaseChannel]
  );
  console.log(`[auth] registered installation ${publicId} (${source})`);
  // The token appears in this response ONCE and nowhere else.
  return json(res, 201, { installationId: publicId, token, source, appVersion });
}

/** Resolve the bearer token to an active installation row, or null. */
async function authenticate(req) {
  if (!pepper()) return null;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const { rows } = await db.query(
    'SELECT id, public_id, source, app_version FROM installations ' +
      'WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)]
  );
  if (!rows[0]) return null;
  await db.query('UPDATE installations SET last_seen_at = now() WHERE id = $1', [rows[0].id]);
  return rows[0];
}

// --- POST /api/v1/product-events (rating eligibility trail) ----------

const EVENT_KINDS = new Set(['fix_attempted', 'fix_completed', 'fix_failed']);

async function recordProductEvent(req, res, inst, rawBody, idemKey) {
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return fail(res, 400, 'bad_json', 'Send a JSON body.');
  }
  const kind = clean(payload.kind, 20);
  if (!EVENT_KINDS.has(kind)) {
    return fail(res, 400, 'validation_failed', 'kind must be fix_attempted, fix_completed, or fix_failed.');
  }
  const appVersion = clean(payload.appVersion, 40) || inst.app_version;
  const occurredAt = new Date(payload.occurredAt || Date.now());
  if (Number.isNaN(occurredAt.getTime())) {
    return fail(res, 400, 'validation_failed', 'occurredAt must be a valid timestamp.');
  }

  const { withIdempotency } = require('./idempotency');
  return withIdempotency(res, inst, idemKey, rawBody, async (client) => {
    // No id in the response: database ids never leave the service.
    await client.query(
      'INSERT INTO product_events (installation_id, kind, app_version, idempotency_key, occurred_at) ' +
        'VALUES ($1, $2, $3, $4, $5)',
      [inst.id, kind, appVersion, idemKey, occurredAt.toISOString()]
    );
    return { status: 201, body: { recorded: true, kind } };
  });
}

module.exports = { register, authenticate, recordProductEvent };
