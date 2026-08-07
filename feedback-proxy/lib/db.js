/**
 * Postgres access for the support framework.
 *
 * Everything here is inert unless DATABASE_URL is set — 'pg' is required
 * lazily so the legacy zero-dependency deployment keeps working with no
 * node_modules at all. That is the dark-deploy guarantee's foundation.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pool = null;

function hasDb() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!hasDb()) return null;
  if (!pool) {
    const { Pool } = require('pg');
    // connectionTimeoutMillis: a starved pool must fail the request fast
    // rather than park it forever behind a slow worker.
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (e) => console.error('[db] idle client error: ' + e.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/** Run fn(client) inside BEGIN/COMMIT, rolling back on any throw. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply migrations/*.sql in filename order, once each, tracked in
 * schema_migrations. Runs before the server listens; a failure must abort
 * boot (fail closed) — the caller exits non-zero.
 */
async function migrate() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await getPool().connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
        'name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    await client.query('BEGIN');
    // Serialize concurrent boots so a migration never runs twice.
    await client.query('LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE');
    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
    );
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied += 1;
    }
    await client.query('COMMIT');
    console.log(`[db] migrations: ${applied} applied, ${files.length - applied} already present`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { hasDb, getPool, query, tx, migrate, close };
