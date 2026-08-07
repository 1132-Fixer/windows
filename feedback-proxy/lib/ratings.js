/**
 * Verified ratings (operator spec): four required 1-5 integer scores
 * (ease, resolved, recommend, overall) + optional comment, one active
 * rating per (installation, source), verified only when the installation
 * has a recent eligible product event. The public number is avg(overall)
 * over 90 days, published only at >= 10 verified ratings. Legacy
 * GitHub-issue ratings are never read and never counted.
 */
'use strict';

const db = require('./db');
const cases = require('./cases');
const outbox = require('./outbox');
const { withIdempotency } = require('./idempotency');
const { json, fail, readBody, clean } = require('./http');

const MAX_BODY_BYTES = 16 * 1024;
const COMMENT_MAX = 4000;
const SCORE_FIELDS = ['ease', 'resolved', 'recommend', 'overall'];
// Operator routing rule (2026-08-07): overall <= 3 opens a rating_feedback
// case + staff forum alert; overall >= 4 only refreshes the live score
// surfaces — unless the user explicitly requested follow-up.
const NEGATIVE_RATING_MAX = 3;
// Below this many verified 90-day ratings the public state is 'collecting'.
const MIN_PUBLIC_SAMPLE = 10;
const WINDOW_DAYS = 90;
// "Recent" eligible product event, per the verified-rating rules.
const ELIGIBLE_WINDOW_DAYS = 90;

async function latestEligibleEvent(client, installationId) {
  const { rows } = await client.query(
    "SELECT id FROM product_events WHERE installation_id = $1 " +
      "AND kind IN ('fix_completed', 'fix_failed') " +
      `AND occurred_at >= now() - interval '${ELIGIBLE_WINDOW_DAYS} days' ` +
      'ORDER BY occurred_at DESC LIMIT 1',
    [installationId]
  );
  return rows[0] ? rows[0].id : null;
}

async function aggregate(client) {
  const { rows } = await client.query(
    'SELECT count(*)::int AS count, round(avg(overall)::numeric, 2)::float AS score, ' +
      SCORE_BUCKETS +
      " FROM ratings WHERE state = 'verified' AND updated_at >= now() - interval '" +
      WINDOW_DAYS + " days'"
  );
  return rows[0];
}

const SCORE_BUCKETS = [1, 2, 3, 4, 5]
  .map((n) => `count(*) FILTER (WHERE overall = ${n})::int AS s${n}`)
  .join(', ');

function distributionOf(agg) {
  return { 1: agg.s1, 2: agg.s2, 3: agg.s3, 4: agg.s4, 5: agg.s5 };
}

/** Rebuild the public snapshot inside the caller's transaction. */
async function rebuildSnapshot(client) {
  const agg = await aggregate(client);
  const state = agg.count >= MIN_PUBLIC_SAMPLE ? 'ready' : 'collecting';
  const { rows } = await client.query(
    'INSERT INTO rating_snapshots (source, window_days, score, rating_count, distribution, state) ' +
      'VALUES (NULL, $1, $2, $3, $4, $5) RETURNING id, generated_at',
    [WINDOW_DAYS, agg.count ? agg.score : null, agg.count,
     JSON.stringify(distributionOf(agg)), state]
  );
  return { id: rows[0].id, generatedAt: rows[0].generated_at, state, score: agg.score, count: agg.count, distribution: distributionOf(agg) };
}

function snapshotBody(s) {
  if (s.state !== 'ready') {
    return { state: 'collecting', count: s.count, verified: true, window: `${WINDOW_DAYS}d` };
  }
  return {
    state: 'ready',
    score: typeof s.score === 'string' ? parseFloat(s.score) : s.score,
    count: s.count,
    verified: true,
    window: `${WINDOW_DAYS}d`,
    distribution: s.distribution,
    updatedAt: s.generatedAt,
  };
}

// ---- PUT /api/v1/ratings/me ----------------------------------------

async function put(req, res, inst) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e && e.code === 413) return fail(res, 413, 'too_large', 'Request body is too large.');
    return fail(res, 400, 'bad_request', 'Could not read the request.');
  }
  const idemKey = clean(req.headers['idempotency-key'], 100);
  if (!idemKey) return fail(res, 400, 'missing_idempotency_key', 'Send an Idempotency-Key header.');
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail(res, 400, 'bad_json', 'Send a JSON body.');
  }

  const scores = {};
  for (const f of SCORE_FIELDS) {
    const v = payload[f];
    // STRICT: whole numbers 1..5 only — no strings, no 3.5.
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) {
      return fail(res, 400, 'validation_failed', `${f} must be a whole number from 1 to 5.`);
    }
    scores[f] = v;
  }
  const comment = clean(payload.comment, COMMENT_MAX) || null;
  const followUp = payload.followUpRequested === true;
  const appVersion = clean(payload.appVersion, 40) || inst.app_version;

  return withIdempotency(res, inst, idemKey, raw, async (client) => {
    const eligibleEventId = await latestEligibleEvent(client, inst.id);
    if (!eligibleEventId) {
      return {
        status: 422,
        body: { error: { code: 'not_eligible', message: 'Run a fix first — ratings need a recent fix result from this installation.', requestId: 'req_' + idemKey.slice(0, 8) } },
      };
    }

    const existing = (await client.query(
      'SELECT * FROM ratings WHERE installation_id = $1 AND source = $2 FOR UPDATE',
      [inst.id, inst.source]
    )).rows[0];

    let ratingId;
    let reason;
    if (!existing) {
      reason = 'created';
      ratingId = (await client.query(
        "INSERT INTO ratings (installation_id, eligible_event_id, source, app_version, " +
          "ease, resolved, recommend, overall, comment, state, verified_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'verified', now()) RETURNING id",
        [inst.id, eligibleEventId, inst.source, appVersion,
         scores.ease, scores.resolved, scores.recommend, scores.overall, comment]
      )).rows[0].id;
    } else {
      reason = existing.state === 'withdrawn' ? 'restored' : 'user_updated';
      ratingId = existing.id;
      await client.query(
        "UPDATE ratings SET eligible_event_id = $2, app_version = $3, ease = $4, resolved = $5, " +
          "recommend = $6, overall = $7, comment = $8, state = 'verified', verified_at = now(), " +
          'withdrawn_at = NULL, updated_at = now() WHERE id = $1',
        [ratingId, eligibleEventId, appVersion,
         scores.ease, scores.resolved, scores.recommend, scores.overall, comment]
      );
    }
    await client.query(
      'INSERT INTO rating_revisions (rating_id, revision, "values", reason) VALUES ' +
        '($1, (SELECT coalesce(max(revision), 0) + 1 FROM rating_revisions WHERE rating_id = $1), $2, $3)',
      [ratingId, JSON.stringify(Object.assign({ comment }, scores)), reason]
    );

    // Public snapshot rebuilds in the same request; the pinned Discord card
    // follows through the outbox (silent edit, never a new post).
    const snapshot = await rebuildSnapshot(client);
    await outbox.enqueue(client, 'rating_snapshot', snapshot.id, 'rating.snapshot.changed', {});

    // Operator routing rule: negative score, or explicit follow-up request,
    // opens exactly one active rating_feedback case + staff alert.
    let caseId = null;
    if (scores.overall <= NEGATIVE_RATING_MAX || followUp) {
      const open = (await client.query(
        "SELECT public_id FROM support_cases WHERE installation_id = $1 AND kind = 'rating_feedback' " +
          "AND state NOT IN ('resolved', 'spam') ORDER BY created_at DESC LIMIT 1",
        [inst.id]
      )).rows[0];
      if (open) {
        caseId = open.public_id; // never stack a second open rating case
      } else {
        const c = await cases.insertCase(client, inst, {
          kind: 'rating_feedback',
          subject: `Rating ${scores.overall}/5 — ${inst.source}`,
          summary: comment || `Overall ${scores.overall}/5 (ease ${scores.ease}, resolved ${scores.resolved}, recommend ${scores.recommend}). No comment provided.`,
          environment: {},
          appVersion,
        }, idemKey);
        caseId = c.public_id;
      }
    }

    return { status: 200, body: { state: 'verified', caseId, snapshot: snapshotBody(snapshot) } };
  });
}

// ---- DELETE /api/v1/ratings/me (withdraw) ---------------------------

async function withdraw(req, res, inst) {
  await readBody(req, 1024).catch(() => null); // drain
  let out = null;
  await db.tx(async (client) => {
    const existing = (await client.query(
      'SELECT * FROM ratings WHERE installation_id = $1 AND source = $2 FOR UPDATE',
      [inst.id, inst.source]
    )).rows[0];
    if (!existing) { out = { missing: true }; return; }
    if (existing.state !== 'withdrawn') {
      await client.query(
        "UPDATE ratings SET state = 'withdrawn', withdrawn_at = now(), updated_at = now() WHERE id = $1",
        [existing.id]
      );
      await client.query(
        'INSERT INTO rating_revisions (rating_id, revision, "values", reason) VALUES ' +
          "($1, (SELECT coalesce(max(revision), 0) + 1 FROM rating_revisions WHERE rating_id = $1), '{}', 'withdrawn')",
        [existing.id]
      );
      const snapshot = await rebuildSnapshot(client);
      await outbox.enqueue(client, 'rating_snapshot', snapshot.id, 'rating.snapshot.changed', {});
    }
    out = { missing: false };
  });
  if (out.missing) return fail(res, 404, 'not_found', 'No rating to withdraw.');
  return json(res, 200, { state: 'withdrawn' }); // repeat DELETE is a no-op
}

// ---- GET /api/v1/ratings/current (public) ---------------------------

async function current(req, res) {
  const { rows } = await db.query(
    'SELECT id, score, rating_count, distribution, state, generated_at FROM rating_snapshots ' +
      'WHERE source IS NULL AND window_days = $1 ORDER BY generated_at DESC LIMIT 1',
    [WINDOW_DAYS]
  );
  if (rows[0]) {
    const s = rows[0];
    return json(res, 200, snapshotBody({
      state: s.state, score: s.score, count: s.rating_count,
      distribution: s.distribution, generatedAt: s.generated_at,
    }));
  }
  // Cold start: no snapshot yet — compute live, store nothing on a GET.
  const agg = await aggregate(db);
  return json(res, 200, snapshotBody({
    state: agg.count >= MIN_PUBLIC_SAMPLE ? 'ready' : 'collecting',
    score: agg.score, count: agg.count,
    distribution: distributionOf(agg), generatedAt: new Date().toISOString(),
  }));
}

/** Latest snapshot data for the Discord card (worker). */
async function latestSnapshotForCard(client) {
  const { rows } = await client.query(
    'SELECT score, rating_count, distribution, state, generated_at FROM rating_snapshots ' +
      'WHERE source IS NULL AND window_days = $1 ORDER BY generated_at DESC LIMIT 1',
    [WINDOW_DAYS]
  );
  if (!rows[0]) return { state: 'collecting', count: 0, score: null, distribution: {}, generatedAt: null };
  const s = rows[0];
  return {
    state: s.state,
    score: s.score == null ? null : parseFloat(s.score),
    count: s.rating_count, distribution: s.distribution, generatedAt: s.generated_at,
  };
}

module.exports = {
  put, withdraw, current, latestSnapshotForCard,
  NEGATIVE_RATING_MAX, MIN_PUBLIC_SAMPLE, WINDOW_DAYS,
};
