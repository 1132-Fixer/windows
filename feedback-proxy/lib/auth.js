/**
 * Installation identity: registration + bearer auth for /v1 client routes.
 *
 * The client holds `installation_id.credential`; the database holds only
 * sha256(credential + INSTALL_CREDENTIAL_PEPPER). The credential is returned
 * exactly once at registration and is never logged or re-derivable.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const { json, clientIp, readBody, createRateLimiter } = require('./http');

// Same limiter pattern and budget as the legacy /feedback endpoint.
const registerLimiter = createRateLimiter(5, 60 * 60 * 1000);

const pepper = () => process.env.INSTALL_CREDENTIAL_PEPPER || '';

function hashCredential(credential) {
  return crypto.createHash('sha256').update(credential + pepper()).digest('hex');
}

async function register(req, res) {
  if (!pepper()) {
    // Without the pepper we would mint hashes that a later, correctly
    // configured deployment cannot verify. Refuse instead.
    console.error('[auth] INSTALL_CREDENTIAL_PEPPER not set — refusing registration');
    return json(res, 503, { ok: false, error: 'not_configured' });
  }
  if (registerLimiter.limited(clientIp(req), Date.now())) {
    return json(res, 429, { ok: false, error: 'rate_limited' });
  }
  // Body is unused today; drain it so keep-alive sockets stay clean.
  await readBody(req, 1024).catch(() => null);

  const publicId = crypto.randomBytes(16).toString('hex');
  const credential = crypto.randomBytes(32).toString('hex');
  await db.query(
    'INSERT INTO installations (public_id, credential_hash) VALUES ($1, $2)',
    [publicId, hashCredential(credential)]
  );
  console.log(`[auth] registered installation ${publicId.slice(0, 8)}…`);
  // The credential appears in this response ONCE and nowhere else.
  return json(res, 201, { ok: true, installation_id: publicId, credential });
}

// Constant 32-byte operand so unknown installation ids take the same
// comparison time as known ones.
const DUMMY_HASH = crypto.createHash('sha256').update('dummy').digest();

/**
 * Resolve `Authorization: Bearer <installation_id>.<credential>` to an
 * installations row, or null. Constant-time hash comparison.
 */
async function authenticate(req) {
  if (!pepper()) return null;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const [publicId, credential] = header.slice(7).trim().split('.');
  if (!publicId || !credential) return null;

  const { rows } = await db.query(
    'SELECT id, public_id, credential_hash FROM installations WHERE public_id = $1',
    [publicId]
  );
  const presented = Buffer.from(hashCredential(credential), 'hex');
  const stored = rows[0] ? Buffer.from(rows[0].credential_hash, 'hex') : DUMMY_HASH;
  const match = stored.length === presented.length && crypto.timingSafeEqual(stored, presented);
  if (!rows[0] || !match) return null;

  await db.query('UPDATE installations SET last_seen_at = now() WHERE id = $1', [rows[0].id]);
  return { id: rows[0].id, public_id: rows[0].public_id };
}

module.exports = { register, authenticate };
