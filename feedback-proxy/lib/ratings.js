/**
 * Verified ratings — final build directive.
 *
 * Score model: four required questions (ease, resolved, recommend, overall),
 * each an INTEGER 0-5 inclusive — six choices. 0 is a REAL answer; a missing
 * or null question is unanswered and rejected. -1, 6, fractions, and strings
 * are rejected. The public score is the average of `overall` only.
 *
 * Routing rule:
 *   - every score 4-5 AND no written text  -> save rating only; silent
 *     dashboard edit; no case, no alert (the response is the receipt).
 *   - ANY score 0-3                        -> save rating + case + alert.
 *   - ANY written comment (even all 4-5)   -> save rating + case + alert.
 *
 * Public window: 90 days. Minimum public sample: 10 verified ratings.
 * API contract: average and count are SEPARATE fields; average has one
 * decimal and is null when count = 0 (never invent an average).
 * States: LOADING (client-side) / VERIFIED / NOT_ENOUGH_RATINGS /
 * UNAVAILABLE / STALE.
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
const SCORE_MIN = 0;
const SCORE_MAX = 5;
// A submission is positive only when EVERY score is >= 4.
const POSITIVE_MIN = 4;
const WINDOW_DAYS = 90;      // public window (documented contract)
const MIN_PUBLIC_SAMPLE = 10; // below this: NOT_ENOUGH_RATINGS
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // snapshot older than this reads as STALE

const SCORE_BUCKETS = [0, 1, 2, 3, 4, 5]
  .map((n) => `count(*) FILTER (WHERE overall = ${n})::int AS s${n}`)
  .join(', ');

function distributionOf(agg) {
  return { 0: agg.s0, 1: agg.s1, 2: agg.s2, 3: agg.s3, 4: agg.s4, 5: agg.s5 };
}

async function aggregate(client, product) {
  const where = product ? 'AND product = $1' : '';
  const { rows } = await client.query(
    'SELECT count(*)::int AS count, round(avg(overall)::numeric, 1)::float AS average, ' +
      SCORE_BUCKETS +
      " FROM ratings WHERE state = 'verified' AND updated_at >= now() - interval '" +
      WINDOW_DAYS + " days' " + where,
    product ? [product] : []
  );
  return rows[0];
}

/** Insert one snapshot row (overall when product is null). Caller's tx. */
async function insertSnapshot(client, product) {
  const agg = await aggregate(client, product);
  const state = agg.count >= MIN_PUBLIC_SAMPLE ? 'VERIFIED' : 'NOT_ENOUGH_RATINGS';
  const { rows } = await client.query(
    'INSERT INTO rating_snapshots (product, window_days, average, rating_count, distribution, state) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, generated_at',
    [product, WINDOW_DAYS, agg.count ? agg.average : null, agg.count,
     JSON.stringify(distributionOf(agg)), state]
  );
  return {
    id: rows[0].id, generatedAt: rows[0].generated_at, state,
    average: agg.count ? agg.average : null, count: agg.count,
    distribution: distributionOf(agg),
  };
}

/**
 * The public response contract. Exported for unit tests: average and count
 * stay SEPARATE typed fields — there is no string path that could render
 * '5.43' out of average 5.4 and count 3.
 */
function publicRatingBody(s) {
  const average = s.count > 0 && s.average != null
    ? Math.round(Number(s.average) * 10) / 10 // one decimal, as a number
    : null; // count 0 -> never invent an average
  let state = s.count >= MIN_PUBLIC_SAMPLE ? 'VERIFIED' : 'NOT_ENOUGH_RATINGS';
  if (s.error) state = 'UNAVAILABLE';
  else if (s.generatedAt && Date.now() - new Date(s.generatedAt).getTime() > STALE_AFTER_MS) {
    state = 'STALE';
  }
  return {
    average,
    count: s.count | 0,
    verified: !s.error,
    state,
    updatedAt: s.generatedAt || null,
    window: `${WINDOW_DAYS}d`,
    minimumSample: MIN_PUBLIC_SAMPLE,
  };
}

// ---- POST /v1/ratings ----------------------------------------------

async function submit(req, res, principal) {
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
    // 0 is a real answer; null/undefined is unanswered. All four required.
    // STRICT integers 0..5 — reject -1, 6, fractions, strings.
    if (typeof v !== 'number' || !Number.isInteger(v) || v < SCORE_MIN || v > SCORE_MAX) {
      return fail(res, 400, 'validation_failed',
        `${f} must be answered with a whole number from 0 to 5.`);
    }
    scores[f] = v;
  }
  const comment = clean(payload.comment, COMMENT_MAX) || null;
  const appVersion = clean(payload.appVersion, 40) || principal.app_version;

  const allPositive = SCORE_FIELDS.every((f) => scores[f] >= POSITIVE_MIN);
  const needsCase = !allPositive || Boolean(comment); // any 0-3, or any written text

  return withIdempotency(res, principal, idemKey, raw, async (client) => {
    const existing = (await client.query(
      'SELECT * FROM ratings WHERE principal_id = $1 AND product = $2 FOR UPDATE',
      [principal.id, principal.product]
    )).rows[0];

    let ratingId;
    let reason;
    if (!existing) {
      reason = 'created';
      ratingId = (await client.query(
        "INSERT INTO ratings (principal_id, product, app_version, ease, resolved, recommend, overall, comment, state, verified_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'verified', now()) RETURNING id",
        [principal.id, principal.product, appVersion,
         scores.ease, scores.resolved, scores.recommend, scores.overall, comment]
      )).rows[0].id;
    } else {
      // Replace, never add: the count cannot grow from a re-rate.
      reason = existing.state === 'withdrawn' ? 'restored' : 'user_updated';
      ratingId = existing.id;
      await client.query(
        "UPDATE ratings SET app_version = $2, ease = $3, resolved = $4, recommend = $5, " +
          "overall = $6, comment = $7, state = 'verified', verified_at = now(), " +
          'withdrawn_at = NULL, updated_at = now() WHERE id = $1',
        [ratingId, appVersion, scores.ease, scores.resolved, scores.recommend, scores.overall, comment]
      );
    }
    await client.query(
      'INSERT INTO rating_revisions (rating_id, revision, "values", reason) VALUES ' +
        '($1, (SELECT coalesce(max(revision), 0) + 1 FROM rating_revisions WHERE rating_id = $1), $2, $3)',
      [ratingId, JSON.stringify(Object.assign({ comment }, scores)), reason]
    );

    // Public snapshots (overall + this product) rebuild in the same request;
    // the pinned Discord card follows through the outbox (silent edit).
    const snapshot = await insertSnapshot(client, null);
    await insertSnapshot(client, principal.product);
    await outbox.enqueue(client, 'rating_snapshot', snapshot.id, 'rating.snapshot.changed', {});

    let caseRef = null;
    if (needsCase) {
      // Exactly one open rating case per principal+product; never stacked.
      const open = (await client.query(
        "SELECT case_ref FROM support_cases WHERE principal_id = $1 AND kind = 'rating_feedback' " +
          "AND state NOT IN ('resolved', 'spam') ORDER BY created_at DESC LIMIT 1",
        [principal.id]
      )).rows[0];
      if (open) {
        caseRef = open.case_ref;
      } else {
        const c = await cases.insertCase(client, principal, {
          kind: 'rating_feedback',
          subject: `Rating ${scores.overall}/5 — ${principal.product}`,
          summary: comment ||
            `Overall ${scores.overall}/5 (ease ${scores.ease}, resolved ${scores.resolved}, recommend ${scores.recommend}). No comment provided.`,
          environment: {},
          appVersion,
        }, idemKey);
        caseRef = c.case_ref;
      }
    }

    // Pure positive gets a receipt, not a fake case.
    return {
      status: 200,
      body: { ratingSaved: true, caseRef, snapshot: publicRatingBody(snapshot) },
    };
  });
}

// ---- GET /v1/ratings/current?product=WINDOWS (public) ---------------

async function current(req, res, searchParams) {
  try {
    const productParam = clean(searchParams.get('product'), 20) || null;
    if (productParam && !require('./auth').PRODUCTS.has(productParam)) {
      return fail(res, 400, 'validation_failed', 'product must be WINDOWS, CHROME, or MACOS.');
    }
    const { rows } = await db.query(
      'SELECT average, rating_count, distribution, generated_at FROM rating_snapshots ' +
        'WHERE product IS NOT DISTINCT FROM $1 AND window_days = $2 ' +
        'ORDER BY generated_at DESC LIMIT 1',
      [productParam, WINDOW_DAYS]
    );
    if (rows[0]) {
      const s = rows[0];
      return json(res, 200, publicRatingBody({
        average: s.average, count: s.rating_count, generatedAt: s.generated_at,
      }));
    }
    // Cold start: no snapshot yet — compute live, store nothing on a GET.
    const agg = await aggregate(db, productParam);
    return json(res, 200, publicRatingBody({
      average: agg.count ? agg.average : null, count: agg.count,
      generatedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.error('[ratings] current failed: ' + e.message);
    return json(res, 200, publicRatingBody({ average: null, count: 0, error: true }));
  }
}

/** Latest overall snapshot data for the Discord card (worker). */
async function latestSnapshotForCard(client) {
  const { rows } = await client.query(
    'SELECT average, rating_count, distribution, state, generated_at FROM rating_snapshots ' +
      'WHERE product IS NULL AND window_days = $1 ORDER BY generated_at DESC LIMIT 1',
    [WINDOW_DAYS]
  );
  if (!rows[0]) {
    return { state: 'NOT_ENOUGH_RATINGS', count: 0, average: null, distribution: {}, generatedAt: null };
  }
  const s = rows[0];
  return {
    state: s.state,
    average: s.average == null ? null : parseFloat(s.average),
    count: s.rating_count, distribution: s.distribution, generatedAt: s.generated_at,
  };
}

module.exports = {
  submit, current, latestSnapshotForCard, publicRatingBody,
  WINDOW_DAYS, MIN_PUBLIC_SAMPLE, POSITIVE_MIN,
};
