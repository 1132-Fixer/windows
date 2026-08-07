/**
 * 1132 Fixer — support service (formerly the single-purpose feedback proxy).
 *
 * Two personalities, chosen by DATABASE_URL:
 *
 *   unset -> LEGACY: exactly the original zero-dependency GitHub-issue proxy
 *            (/health + POST /feedback). No 'pg' require, no /api routes.
 *            This is the dark-deploy guarantee — deploying this code with no
 *            new env vars changes nothing for installed clients.
 *
 *   set   -> SUPPORT: migrations (the operator's 1132-support-schema.sql)
 *            run before listen and a failure exits non-zero (fail closed),
 *            then /api/v1/* and /integrations/discord/interactions mount
 *            alongside the unchanged legacy /feedback adapter. Discord
 *            output additionally requires DISCORD_ENABLED=true (outbox
 *            dark-launch flag).
 */
'use strict';

const http = require('http');
const { json, fail } = require('./lib/http');
const legacy = require('./lib/legacy');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;

async function dbState() {
  if (!db.hasDb()) return 'off';
  try {
    await db.query('SELECT 1');
    return 'ok';
  } catch {
    return 'off';
  }
}

async function health(res) {
  // Legacy shape (ok/service/configured) preserved; db field appended.
  return json(res, 200, {
    ok: true,
    service: '1132-fixer-feedback-proxy',
    configured: legacy.configured(),
    db: await dbState(),
  });
}

async function ready(res) {
  if (!db.hasDb()) return json(res, 200, { ok: true, db: 'off' }); // legacy mode is always ready
  const state = await dbState();
  if (state === 'ok') return json(res, 200, { ok: true, db: 'ok' });
  return json(res, 503, { ok: false, db: 'error' });
}

const CASE_PATH = /^\/api\/v1\/cases\/(FX-[A-Z2-9]{6,12})(\/(messages|read))?$/;

async function routeApi(req, res, pathname) {
  // Lazy requires keep legacy mode free of any 'pg' dependency chain.
  const auth = require('./lib/auth');
  const cases = require('./lib/cases');
  const ratings = require('./lib/ratings');
  const { readBody, clean } = require('./lib/http');

  if (req.method === 'POST' && pathname === '/api/v1/installations') {
    return auth.register(req, res);
  }
  if (req.method === 'GET' && pathname === '/api/v1/ratings/current') {
    return ratings.current(req, res); // public: apps + website read the snapshot
  }

  const inst = await auth.authenticate(req);
  if (!inst) return fail(res, 401, 'unauthorized', 'A valid installation token is required.');

  if (req.method === 'POST' && pathname === '/api/v1/product-events') {
    let raw;
    try {
      raw = await readBody(req, 8 * 1024);
    } catch {
      return fail(res, 400, 'bad_request', 'Could not read the request.');
    }
    const idemKey = clean(req.headers['idempotency-key'], 100);
    if (!idemKey) return fail(res, 400, 'missing_idempotency_key', 'Send an Idempotency-Key header.');
    return auth.recordProductEvent(req, res, inst, raw, idemKey);
  }
  if (req.method === 'POST' && pathname === '/api/v1/cases') return cases.create(req, res, inst);
  if (req.method === 'GET' && pathname === '/api/v1/cases') return cases.list(req, res, inst);
  if (req.method === 'POST' && pathname === '/api/v1/feedback') return cases.feedback(req, res, inst);
  if (req.method === 'PUT' && pathname === '/api/v1/ratings/me') return ratings.put(req, res, inst);
  if (req.method === 'DELETE' && pathname === '/api/v1/ratings/me') return ratings.withdraw(req, res, inst);

  const m = pathname.match(CASE_PATH);
  if (m) {
    const caseId = m[1];
    if (!m[2] && req.method === 'GET') return cases.get(req, res, inst, caseId);
    if (m[3] === 'messages' && req.method === 'POST') return cases.addMessage(req, res, inst, caseId);
    if (m[3] === 'read' && req.method === 'POST') return cases.markRead(req, res, inst, caseId);
  }

  return fail(res, 404, 'not_found', 'No such route.');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return await health(res);
    }
    if (req.method === 'GET' && req.url === '/ready') {
      return await ready(res);
    }
    if (req.method === 'POST' && req.url === '/feedback') {
      return await legacy.handleFeedback(req, res);
    }

    if (db.hasDb()) {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname.startsWith('/api/')) {
        return await routeApi(req, res, u.pathname);
      }
      if (req.method === 'POST' && u.pathname === '/integrations/discord/interactions') {
        return await require('./lib/interactions').handle(req, res);
      }
    }

    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    console.error('[feedback] unhandled: ' + (err && err.message));
    return json(res, 500, { ok: false, error: 'internal' });
  }
});

async function boot() {
  if (db.hasDb()) {
    try {
      await db.migrate();
    } catch (e) {
      // Fail closed: never serve /api against a half-migrated schema.
      console.error('[db] migration failed: ' + e.message);
      process.exit(1);
    }
    require('./lib/outbox').startWorker();
  }
  server.listen(PORT, () => {
    console.log(`[feedback-proxy] listening on :${PORT}`);
    console.log(`[feedback-proxy] repo=${legacy.repo()} token=${legacy.configured() ? 'present' : 'ABSENT (503s until set)'}`);
    console.log(`[support] db=${db.hasDb() ? 'configured' : 'off (legacy mode)'} discord_dispatch=${process.env.DISCORD_ENABLED === 'true' ? 'on' : 'off'} pepper=${process.env.TOKEN_HASH_PEPPER ? 'present' : 'absent'}`);
  });
}

const readyPromise = boot();

module.exports = { server, ready: readyPromise };
