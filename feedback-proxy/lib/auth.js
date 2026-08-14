/**
 * Support principals (renamed from installations):
 *   POST /v1/principals issues { principalId: 'IN-…', token } — the token
 *   appears in that response ONCE; the database stores only
 *   sha256(token + TOKEN_HASH_PEPPER) as bytea (unique).
 *
 * Auth: `Authorization: Bearer <token>` resolved by hash lookup. The stored
 * value is a preimage-resistant digest, so an exact index match is the
 * correct constant-behavior comparison; no plain secret is ever stored.
 *
 * (The documented route list does not name a registration route; the
 * principal-creation endpoint is required for every bearer route to work
 * and is documented as such in the PR.)
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const ids = require('./ids');
const { json, fail, clientIp, readBody, clean, createRateLimiter } = require('./http');

const PRODUCTS = new Set(['WINDOWS', 'CHROME', 'MACOS']);
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
  const product = clean(payload.product, 20);
  if (!PRODUCTS.has(product)) {
    return fail(res, 400, 'validation_failed', 'product must be WINDOWS, CHROME, or MACOS.');
  }
  const appVersion = clean(payload.appVersion, 40);
  if (!appVersion) return fail(res, 400, 'validation_failed', 'appVersion is required.');
  const releaseChannel = clean(payload.releaseChannel, 20) || 'stable';

  const publicId = ids.newPrincipalId();
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    'INSERT INTO support_principals (public_id, token_hash, product, app_version, release_channel) ' +
      'VALUES ($1, $2, $3, $4, $5)',
    [publicId, hashToken(token), product, appVersion, releaseChannel]
  );
  console.log(`[auth] registered principal ${publicId} (${product})`);
  // The token appears in this response ONCE and nowhere else.
  return json(res, 201, { principalId: publicId, token, product, appVersion });
}

/** Resolve the bearer token to an active principal row, or null. */
async function authenticate(req) {
  if (!pepper()) return null;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const { rows } = await db.query(
    'SELECT id, public_id, product, app_version FROM support_principals ' +
      'WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)]
  );
  if (!rows[0]) return null;
  await db.query('UPDATE support_principals SET last_seen_at = now() WHERE id = $1', [rows[0].id]);
  return rows[0];
}

module.exports = { register, authenticate, PRODUCTS };
