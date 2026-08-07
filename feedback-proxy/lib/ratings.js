/**
 * Verified ratings: one current row per (installation, app_version).
 *
 * Only rows in the ratings table count — legacy GitHub-issue ratings are
 * never included in any score, summary, or badge.
 */
'use strict';

const db = require('./db');
const cases = require('./cases');
const outbox = require('./outbox');
const { json, readBody, clean } = require('./http');

const MAX_BODY_BYTES = 8 * 1024;
const COMMENT_MAX = 2000;
// Operator routing rule (2026-08-07): scores <= 3 open a staff case + forum
// alert; scores >= 4 only update the live score surfaces.
const NEGATIVE_RATING_MAX = 3;
// Below this many 30-day ratings the aggregate is not shown as meaningful.
const MIN_SAMPLE = 3;

async function submit(req, res, inst) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'));
  } catch (e) {
    if (e && e.code === 413) return json(res, 413, { ok: false, error: 'too_large' });
    return json(res, 400, { ok: false, error: 'bad_json' });
  }

  const score = payload.score;
  // STRICT: an integer 1..5, nothing else (no strings, no 3.5).
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    return json(res, 400, { ok: false, error: 'bad_score' });
  }
  const appVersion = clean(payload.app_version, 40);
  if (!appVersion) return json(res, 400, { ok: false, error: 'missing_app_version' });
  const comment = clean(payload.comment, COMMENT_MAX) || null;
  // Required on every create request (plan §8): a negative score opens a case,
  // and a retry must not open two.
  const idemKey = clean(req.headers['idempotency-key'], 100) || null;
  if (!idemKey) return json(res, 400, { ok: false, error: 'missing_idempotency_key' });

  const negative = score <= NEGATIVE_RATING_MAX;
  let caseRef = null;
  await db.tx(async (client) => {
    await client.query(
      'INSERT INTO ratings (installation_id, app_version, score, comment) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (installation_id, app_version) ' +
        'DO UPDATE SET score = $3, comment = $4, updated_at = now()',
      [inst.id, appVersion, score, comment]
    );
    // Live-score surfaces (dashboard embed) update on every rating change.
    await outbox.enqueue(client, 'rating.changed', { installation_public_id: inst.public_id });

    if (negative) {
      // Same-key retry must not open a second case (plan §14).
      if (idemKey) {
        const { rows } = await client.query(
          'SELECT case_ref FROM tickets WHERE installation_id = $1 AND idempotency_key = $2',
          [inst.id, idemKey]
        );
        if (rows[0]) { caseRef = rows[0].case_ref; return; }
      }
      const t = await cases.insertTicket(client, inst, {
        type: 'rating',
        subject: `Rating ${score}/5 — ${appVersion}`,
        body: comment,
        app_version: appVersion,
        os_info: null,
      }, idemKey);
      caseRef = t.case_ref;
    }
  }).catch(async (e) => {
    if (e.code !== '23505' || !idemKey) throw e;
    const { rows } = await db.query(
      'SELECT case_ref FROM tickets WHERE installation_id = $1 AND idempotency_key = $2',
      [inst.id, idemKey]
    );
    if (!rows[0]) throw e;
    caseRef = rows[0].case_ref;
  });

  return json(res, 200, { ok: true, case: caseRef });
}

/** 30-day aggregate; each (installation, app_version) row is already the latest. */
async function computeSummary(version) {
  const overall = (await db.query(
    "SELECT round(avg(score)::numeric, 1)::float AS score, count(*)::int AS count " +
      "FROM ratings WHERE updated_at >= now() - interval '30 days'"
  )).rows[0];
  let vs = { score: null, count: 0 };
  if (version) {
    vs = (await db.query(
      "SELECT round(avg(score)::numeric, 1)::float AS score, count(*)::int AS count " +
        "FROM ratings WHERE updated_at >= now() - interval '30 days' AND app_version = $1",
      [version]
    )).rows[0];
  }
  const dist = (await db.query(
    "SELECT score, count(*)::int AS count FROM ratings " +
      "WHERE updated_at >= now() - interval '30 days' GROUP BY score"
  )).rows;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of dist) distribution[row.score] = row.count;
  return {
    window: '30d',
    score: overall.count ? overall.score : null,
    count: overall.count,
    version: version || null,
    version_score: vs.count ? vs.score : null,
    version_count: vs.count,
    distribution,
    enough_data: overall.count >= MIN_SAMPLE,
  };
}

async function summary(req, res, searchParams) {
  const version = clean(searchParams.get('version'), 40) || null;
  const s = await computeSummary(version);
  return json(res, 200, Object.assign({ ok: true }, s));
}

/** Shields endpoint JSON. Public (release README badge fetches it). */
async function badge(req, res) {
  const s = await computeSummary(null);
  if (!s.enough_data) {
    return json(res, 200, {
      schemaVersion: 1, label: 'Rating',
      message: 'not enough verified ratings', color: 'lightgrey',
    });
  }
  const color = s.score >= 4 ? 'brightgreen' : s.score >= 3 ? 'green' : s.score >= 2 ? 'yellow' : 'red';
  return json(res, 200, {
    schemaVersion: 1, label: 'Rating',
    message: `${s.score.toFixed(1)}/5 (${s.count} verified)`, color,
  });
}

module.exports = { submit, summary, badge, computeSummary, NEGATIVE_RATING_MAX, MIN_SAMPLE };
