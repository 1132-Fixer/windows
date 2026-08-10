/**
 * 1132 Fixer — support service (formerly the single-purpose feedback proxy).
 *
 * Gate (final directive): SUPPORT_V2_ENABLED joins DATABASE_URL.
 *
 *   SUPPORT_V2_ENABLED unset/false -> LEGACY, byte-identical: exactly the
 *     original zero-dependency GitHub-issue proxy (/health + POST /feedback,
 *     everything else 404). No 'pg' require, no new routes, no extra fields.
 *
 *   SUPPORT_V2_ENABLED=true -> /healthz (process alive) and /readyz (DB +
 *     migrations + config + worker; 503 without Postgres) appear, /health
 *     gains db:'ok'|'off'. The /v1 API and /v1/discord/interactions mount
 *     only when DATABASE_URL is also set; migrations run before listen and
 *     a failure exits non-zero (fail closed). Discord dispatch additionally
 *     requires DISCORD_ENABLED=true (outbox dark-launch flag).
 */
'use strict';

const http = require('http');
const { json, fail } = require('./lib/http');
const legacy = require('./lib/legacy');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;

const v2Enabled = () => process.env.SUPPORT_V2_ENABLED === 'true';
const v1Mounted = () => v2Enabled() && db.hasDb();

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
  // Legacy shape preserved; db + capabilities fields appended ONLY when v2 is
  // enabled so the dark deployment stays byte-identical.
  const body = {
    ok: true,
    service: '1132-fixer-feedback-proxy',
    configured: legacy.configured(),
  };
  if (v2Enabled()) {
    body.db = await dbState();
    // Clients gate their attach-screenshot UI on this (#141): true only when
    // the whole chain can actually deliver — API mounted, DB up, registration
    // possible, and Discord dispatch on with its config present. Anything
    // less would be a dead control in the app.
    body.capabilities = {
      screenshots: body.db === 'ok' &&
        Boolean(process.env.TOKEN_HASH_PEPPER) &&
        process.env.DISCORD_ENABLED === 'true' &&
        Boolean(process.env.DISCORD_BOT_TOKEN) &&
        Boolean(process.env.DISCORD_SUPPORT_FORUM_ID),
    };
    // The Chrome extension probes this capability cross-origin (#16). Scoped
    // to v2 so the dark legacy response stays byte- and header-identical; a
    // CORS-blocked probe correctly reads as "no capability".
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  return json(res, 200, body);
}

/** /readyz: DB reachable + migrations recorded + config + worker started. */
async function readyz(res) {
  if (!db.hasDb()) return json(res, 503, { ok: false, reason: 'no_database' });
  try {
    const migrated = (await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n > 0;
    const configOk = Boolean(process.env.TOKEN_HASH_PEPPER);
    const worker = require('./lib/outbox').workerHealth();
    if (migrated && configOk && worker.ok) {
      return json(res, 200, {
        ok: true, db: 'ok', migrations: 'applied',
        worker: worker.state || 'running', lastTickAgeMs: worker.lastTickAgeMs,
      });
    }
    return json(res, 503, {
      ok: false,
      reason: !migrated ? 'migrations_missing' : !configOk ? 'config_missing' : ('worker_' + worker.reason),
    });
  } catch {
    return json(res, 503, { ok: false, reason: 'database_unreachable' });
  }
}

const CASE_PATH = /^\/v1\/cases\/(FX-[A-Z2-9]{6,12})(\/messages)?$/;
const INBOX_READ_PATH = /^\/v1\/my-messages\/(MS-[A-Z2-9]{8,16})\/read$/;

// The public rating endpoint is read by the website and the apps from other
// origins; the two client-registration/bug-report routes are additionally
// cross-origin WRITABLE for the Chrome extension (#16), which submits from a
// chrome-extension:// origin. CORS is a browser gate, not an auth layer —
// both routes keep their own auth/rate limits; '*' with an explicit
// Authorization header is safe because credentials mode is never 'include'.
const PUBLIC_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const CLIENT_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
  'Access-Control-Max-Age': '86400',
};
const CLIENT_CORS_PATHS = new Set(['/v1/principals', '/v1/cases']);

async function routeV1(req, res, pathname, searchParams) {
  // Lazy requires keep legacy mode free of any 'pg' dependency chain.
  const auth = require('./lib/auth');
  const cases = require('./lib/cases');
  const ratings = require('./lib/ratings');
  const inbox = require('./lib/inbox');

  if (CLIENT_CORS_PATHS.has(pathname)) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CLIENT_CORS);
      return res.end();
    }
    for (const [k, v] of Object.entries(CLIENT_CORS)) res.setHeader(k, v);
  }

  if (req.method === 'POST' && pathname === '/v1/principals') {
    return auth.register(req, res);
  }
  if (pathname === '/v1/ratings/current' && (req.method === 'GET' || req.method === 'OPTIONS')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, PUBLIC_CORS);
      return res.end();
    }
    for (const [k, v] of Object.entries(PUBLIC_CORS)) res.setHeader(k, v);
    return ratings.current(req, res, searchParams); // public: apps + website read it
  }
  if (req.method === 'POST' && pathname === '/v1/discord/interactions') {
    return require('./lib/interactions').handle(req, res); // own signature auth
  }

  const principal = await auth.authenticate(req);
  if (!principal) return fail(res, 401, 'unauthorized', 'A valid installation token is required.');

  if (req.method === 'POST' && pathname === '/v1/ratings') return ratings.submit(req, res, principal);
  if (req.method === 'POST' && pathname === '/v1/cases') return cases.create(req, res, principal);
  if (req.method === 'GET' && pathname === '/v1/cases') return cases.list(req, res, principal);
  if (req.method === 'GET' && pathname === '/v1/my-messages') return inbox.list(req, res, principal);
  if (req.method === 'GET' && pathname === '/v1/my-messages/unread-count') {
    return inbox.unread(req, res, principal);
  }
  if (req.method === 'GET' && pathname === '/v1/my-messages/events') {
    return inbox.events(req, res, principal);
  }
  const read = pathname.match(INBOX_READ_PATH);
  if (read && req.method === 'POST') return inbox.markRead(req, res, principal, read[1]);
  const one = pathname.match(CASE_PATH);
  if (one) {
    if (one[2] && req.method === 'POST') return cases.addMessage(req, res, principal, one[1]);
    if (!one[2] && req.method === 'GET') return cases.get(req, res, principal, one[1]);
  }

  return fail(res, 404, 'not_found', 'No such route.');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return await health(res);
    }
    if (req.method === 'POST' && req.url === '/feedback') {
      return await legacy.handleFeedback(req, res);
    }

    if (v2Enabled()) {
      if (req.method === 'GET' && req.url === '/healthz') {
        return json(res, 200, { ok: true }); // process alive, nothing else
      }
      if (req.method === 'GET' && req.url === '/readyz') {
        return await readyz(res);
      }
      if (db.hasDb()) {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname.startsWith('/v1/')) {
          return await routeV1(req, res, u.pathname, u.searchParams);
        }
      }
    }

    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    console.error('[feedback] unhandled: ' + (err && err.message));
    // A streaming response (SSE) has already written its head: writing a JSON
    // error here would throw ERR_HTTP_HEADERS_SENT inside this catch and take
    // the whole process down with an unhandled rejection.
    if (res.headersSent) return res.destroy();
    return json(res, 500, { ok: false, error: 'internal' });
  }
});

async function boot() {
  if (v1Mounted()) {
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
    if (v2Enabled()) {
      console.log(`[support] v2=on db=${db.hasDb() ? 'configured' : 'MISSING'} discord_dispatch=${process.env.DISCORD_ENABLED === 'true' ? 'on' : 'off'} pepper=${process.env.TOKEN_HASH_PEPPER ? 'present' : 'absent'}`);
    }
  });
}

const readyPromise = boot();

module.exports = { server, ready: readyPromise };
