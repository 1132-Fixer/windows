/**
 * Transactional outbox. enqueue() runs on the SAME transaction as the
 * case/message/rating write, so a crash between commit and delivery leaves a
 * pending row, never a lost event — and an idempotency replay never enqueues
 * again, so retries never send a second ping.
 *
 * Delivery is deliberately NOT inside one long transaction:
 *   claim (short tx, marks 'running') -> Discord HTTP with no tx open ->
 *   record outcome (own short statement).
 * That keeps a 429 sleep from holding a pooled connection and row locks, and
 * stops one row's DB error from aborting the whole batch. Rows stuck in
 * 'running' (crash mid-dispatch) are reclaimed after LEASE_MS.
 *
 * Discord side effects are made idempotent by state, not by transactions:
 * dispatchCaseCreated consults discord_case_bindings BEFORE posting, so a
 * retry reuses the existing thread instead of creating a duplicate, and the
 * role alert is claimed with a conditional UPDATE so it can fire at most once.
 *
 * DISCORD_ENABLED !== 'true' -> rows accumulate pending, nothing is sent.
 */
'use strict';

const db = require('./db');
const discord = require('./discord');

const INTERVAL_MS = 5000;
const BATCH = 10;
const LEASE_MS = 5 * 60 * 1000; // reclaim rows abandoned by a crashed dispatch

function discordEnabled() {
  return process.env.DISCORD_ENABLED === 'true';
}

/** Must be called with the transaction client of the write it belongs to. */
function enqueue(client, aggregateType, aggregateId, eventType, payload) {
  return client.query(
    'INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) ' +
      'VALUES ($1, $2, $3, $4)',
    [aggregateType, aggregateId, eventType, JSON.stringify(payload)]
  );
}

/** Existing Discord binding for a case, or null. */
async function bindingOf(caseId) {
  const { rows } = await db.query(
    'SELECT forum_thread_id, control_message_id, alerted_at FROM discord_case_bindings WHERE case_id = $1',
    [caseId]
  );
  return rows[0] || null;
}

async function dispatchCaseCreated(payload) {
  const cases = require('./cases');
  let binding = await bindingOf(payload.case_id);

  if (!binding) {
    const card = await db.tx((client) => cases.cardData(client, payload.case_id));
    if (!card) return; // case deleted; nothing to post
    const created = await discord.createForumPost(card);
    // Persist the binding BEFORE anything else can fail, so a retry can never
    // create a second thread.
    await db.query(
      'INSERT INTO discord_case_bindings (case_id, forum_thread_id, control_message_id) ' +
        'VALUES ($1, $2, $3) ON CONFLICT (case_id) DO NOTHING',
      [payload.case_id, created.thread_id, created.message_id]
    );
    binding = await bindingOf(payload.case_id);
  }

  // Claim the alert first: at-most-once is the requirement, so a failed post
  // must not re-ping on retry.
  if (!binding.alerted_at) {
    const claim = await db.query(
      'UPDATE discord_case_bindings SET alerted_at = now(), updated_at = now() ' +
        'WHERE case_id = $1 AND alerted_at IS NULL RETURNING forum_thread_id',
      [payload.case_id]
    );
    if (claim.rows[0]) await discord.postRoleAlert(claim.rows[0].forum_thread_id);
  }

  // Screenshot forward (#141): claim first (pending->approved), but REVERT
  // the claim if the upload fails so the outbox retry delivers the image —
  // the screenshot is the report's evidence, not a cosmetic ping, so silent
  // permanent loss on a transient Discord error is the wrong trade.
  const attachments = require('./attachments');
  const shot = await attachments.claimForDispatch(db, payload.case_id);
  if (shot) {
    try {
      await discord.postScreenshot(binding.forum_thread_id, payload.case_ref, shot);
    } catch (e) {
      await attachments.revertClaim(db, shot.id).catch((err) =>
        console.error('[outbox] screenshot claim revert failed: ' + err.message));
      throw e; // row goes 'failed'; the retry re-claims and re-posts
    }
  }

  await db.query(
    "INSERT INTO case_events (case_id, actor_type, event_type, data) VALUES ($1, 'system', 'discord.posted', $2)",
    [payload.case_id, JSON.stringify({ thread_id: binding.forum_thread_id })]
  );
}

async function dispatchMessage(payload) {
  const binding = await bindingOf(payload.case_id);
  if (!binding) {
    // Forum post not delivered yet; retry after backoff keeps ordering sane.
    throw new Error(`no thread yet for ${payload.case_ref}`);
  }
  const who = payload.author === 'staff' ? 'Staff reply' : 'User reply';
  await discord.postThreadMessage(
    binding.forum_thread_id,
    `**${who} on ${payload.case_ref}**\n${discord.escapeMd(payload.body).slice(0, 1500)}`
  );
}

/** Re-render the control card so its buttons carry the current epoch. */
async function dispatchCardRefresh(payload) {
  const cases = require('./cases');
  const card = await db.tx((client) => cases.cardData(client, payload.case_id));
  if (!card || !card.control_message_id) return; // not posted yet; nothing to refresh
  await discord.editCaseCard(card.forum_thread_id, card.control_message_id, card);
}

async function dispatchSnapshotChanged() {
  // Lazy require: ratings -> cases -> outbox would otherwise be a load cycle.
  const ratings = require('./ratings');
  await discord.upsertRatingCard(await ratings.latestSnapshotForCard(db));
}

const HANDLERS = new Map([
  ['case.created', dispatchCaseCreated],
  ['message.created', dispatchMessage],
  ['case.card.refresh', dispatchCardRefresh],
  ['rating.snapshot.changed', dispatchSnapshotChanged],
]);

/** Claim due rows in a SHORT transaction; Discord work happens after it commits. */
function claimBatch() {
  return db.tx(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM outbox WHERE (state IN ('pending', 'failed') AND available_at <= now()) " +
        "OR (state = 'running' AND locked_at < now() - ($2::int * interval '1 millisecond')) " +
        'ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED',
      [BATCH, LEASE_MS]
    );
    if (rows.length) {
      await client.query(
        "UPDATE outbox SET state = 'running', locked_at = now() WHERE id = ANY($1::bigint[])",
        [rows.map((r) => r.id)]
      );
    }
    return rows;
  });
}

let inFlight = false;
let lastTickAt = 0;
let lastTickOk = false;

/** One worker pass. Exported for tests; scheduled by startWorker(). */
async function tick() {
  if (!db.hasDb()) return;
  if (inFlight) return; // ticks must not stack: a 429 sleep can outlast the interval
  inFlight = true;
  try {
    await require('./idempotency').purgeExpired().catch((e) =>
      console.error('[outbox] idempotency purge failed: ' + e.message));
    await require('./attachments').purgeExpired(db).catch((e) =>
      console.error('[outbox] attachment purge failed: ' + e.message));
    if (!discordEnabled()) return;

    const rows = await claimBatch();
    let cardDone = false;
    for (const row of rows) {
      try {
        if (row.event_type === 'rating.snapshot.changed') {
          // Debounce: one silent card edit covers every claimed snapshot row.
          if (!cardDone) {
            await dispatchSnapshotChanged();
            cardDone = true;
          }
        } else {
          const handler = HANDLERS.get(row.event_type);
          if (!handler) throw new Error(`unknown outbox event_type ${row.event_type}`);
          await handler(row.payload);
        }
        await db.query("UPDATE outbox SET state = 'sent', sent_at = now() WHERE id = $1", [row.id]);
      } catch (e) {
        console.error(`[outbox] ${row.event_type} #${row.id} attempt ${row.attempts + 1}: ${e.message}`);
        const backoffS = Math.min(3600, 30 * 2 ** row.attempts);
        // Own statement, no shared transaction to abort.
        await db.query(
          "UPDATE outbox SET state = 'failed', attempts = attempts + 1, " +
            "last_error_code = $2, available_at = now() + ($3::int * interval '1 second') WHERE id = $1",
          [row.id, String(e.status || 'error'), backoffS]
        ).catch((err) => console.error('[outbox] could not mark failed: ' + err.message));
      }
    }
    lastTickOk = true;
  } catch (e) {
    lastTickOk = false;
    throw e;
  } finally {
    lastTickAt = Date.now();
    inFlight = false;
  }
}

let timer = null;

function startWorker() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => console.error('[outbox] tick failed: ' + e.message));
  }, INTERVAL_MS);
  timer.unref();
  console.log(`[outbox] worker started (discord dispatch ${discordEnabled() ? 'ENABLED' : 'disabled — rows stay pending'})`);
}

/**
 * Worker health for /readyz: started AND a recent tick that did not throw.
 * A worker whose every tick fails must not read as ready.
 */
function workerHealth() {
  if (!timer) return { ok: false, reason: 'not_started' };
  const age = lastTickAt ? Date.now() - lastTickAt : null;
  if (age === null) return { ok: true, state: 'starting' }; // first tick not due yet
  if (age > INTERVAL_MS * 6) return { ok: false, reason: 'stalled', lastTickAgeMs: age };
  if (!lastTickOk) return { ok: false, reason: 'failing', lastTickAgeMs: age };
  return { ok: true, state: 'running', lastTickAgeMs: age };
}

module.exports = { enqueue, tick, startWorker, workerHealth };
