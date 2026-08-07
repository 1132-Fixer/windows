/**
 * 1132 Fixer — support service (formerly the single-purpose feedback proxy).
 *
 * Two personalities, chosen by DATABASE_URL:
 *
 *   unset -> LEGACY: exactly the original zero-dependency GitHub-issue proxy
 *            (/health + POST /feedback). No 'pg' require, no /v1 routes.
 *            This is the dark-deploy guarantee — deploying this code with no
 *            new env vars changes nothing for installed clients.
 *
 *   set   -> SUPPORT: migrations run before listen (fail closed), then the
 *            /v1 case/rating/message API and /discord/interactions mount
 *            alongside the unchanged legacy /feedback adapter. Discord
 *            output additionally requires DISCORD_ENABLED=true (outbox flag).
 */
'use strict';

const http = require('http');
const { json } = require('./lib/http');
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

async function readyz(res) {
  if (!db.hasDb()) return json(res, 200, { ok: true, db: 'off' }); // legacy mode is always ready
  const state = await dbState();
  if (state === 'ok') return json(res, 200, { ok: true, db: 'ok' });
  return json(res, 503, { ok: false, db: 'error' });
}

async function routeV1(req, res, pathname, searchParams) {
  // Lazy requires keep legacy mode free of any 'pg' dependency chain.
  const auth = require('./lib/auth');
  const cases = require('./lib/cases');
  const ratings = require('./lib/ratings');

  if (req.method === 'POST' && pathname === '/v1/installations/register') {
    return auth.register(req, res);
  }
  if (req.method === 'GET' && pathname === '/v1/ratings/badge') {
    return ratings.badge(req, res); // public: the release README badge reads it
  }

  const inst = await auth.authenticate(req);
  if (!inst) return json(res, 401, { ok: false, error: 'unauthorized' });

  if (req.method === 'POST' && pathname === '/v1/tickets') return cases.create(req, res, inst);
  if (req.method === 'GET' && pathname === '/v1/tickets') return cases.list(req, res, inst);
  if (req.method === 'POST' && pathname === '/v1/ratings') return ratings.submit(req, res, inst);
  if (req.method === 'GET' && pathname === '/v1/ratings/summary') {
    return ratings.summary(req, res, searchParams);
  }
  const one = pathname.match(/^\/v1\/tickets\/(F-\d+)$/);
  if (one && req.method === 'GET') return cases.get(req, res, inst, one[1]);
  const msgs = pathname.match(/^\/v1\/tickets\/(F-\d+)\/messages$/);
  if (msgs && req.method === 'GET') return cases.listMessages(req, res, inst, msgs[1], searchParams);
  if (msgs && req.method === 'POST') return cases.addMessage(req, res, inst, msgs[1]);

  return json(res, 404, { ok: false, error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/' || req.url === '/healthz')) {
      return await health(res);
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      return await readyz(res);
    }
    if (req.method === 'POST' && req.url === '/feedback') {
      return await legacy.handleFeedback(req, res);
    }

    if (db.hasDb()) {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname.startsWith('/v1/')) {
        return await routeV1(req, res, u.pathname, u.searchParams);
      }
      if (req.method === 'POST' && u.pathname === '/discord/interactions') {
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
      // Fail closed: never serve /v1 against a half-migrated schema.
      console.error('[db] migration failed: ' + e.message);
      process.exit(1);
    }
    require('./lib/outbox').startWorker();
  }
  server.listen(PORT, () => {
    console.log(`[feedback-proxy] listening on :${PORT}`);
    console.log(`[feedback-proxy] repo=${legacy.repo()} token=${legacy.configured() ? 'present' : 'ABSENT (503s until set)'}`);
    console.log(`[support] db=${db.hasDb() ? 'configured' : 'off (legacy mode)'} discord_dispatch=${process.env.DISCORD_ENABLED === 'true' ? 'on' : 'off'} pepper=${process.env.INSTALL_CREDENTIAL_PEPPER ? 'present' : 'absent'}`);
  });
}

const ready = boot();

module.exports = { server, ready };
