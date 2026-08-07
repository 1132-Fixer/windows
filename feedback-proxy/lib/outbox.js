/**
 * Transactional outbox (final directive table: outbox, states + lease
 * columns). enqueue() runs on the SAME transaction as the case/message/
 * rating write, so a crash between commit and delivery leaves a pending
 * row, never a lost event — and an idempotency replay never enqueues
 * again, so retries never send a second ping.
 *
 * DISCORD_ENABLED !== 'true' -> rows accumulate pending, nothing is sent.
 */
'use strict';

const db = require('./db');
const discord = require('./discord');

const INTERVAL_MS = 5000;
const BATCH = 10;

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

async function dispatchCaseCreated(client, payload) {
  const ids = await discord.createForumPost(payload);
  await client.query(
    'INSERT INTO discord_case_bindings (case_id, forum_thread_id, control_message_id) ' +
      'VALUES ($1, $2, $3) ON CONFLICT (case_id) DO NOTHING',
    [payload.case_id, ids.thread_id, ids.message_id]
  );
  // Staff-role mention exactly once per case, on the first qualifying post.
  const { rows } = await client.query(
    'SELECT alerted_at FROM discord_case_bindings WHERE case_id = $1 FOR UPDATE',
    [payload.case_id]
  );
  if (rows[0] && !rows[0].alerted_at) {
    await discord.postRoleAlert(ids.thread_id);
    await client.query(
      'UPDATE discord_case_bindings SET alerted_at = now(), updated_at = now() WHERE case_id = $1',
      [payload.case_id]
    );
  }
  await client.query(
    "INSERT INTO case_events (case_id, actor_type, event_type, data) VALUES ($1, 'system', 'discord.posted', $2)",
    [payload.case_id, JSON.stringify({ thread_id: ids.thread_id })]
  );
}

async function dispatchUserMessage(client, payload) {
  const { rows } = await client.query(
    'SELECT forum_thread_id FROM discord_case_bindings WHERE case_id = $1', [payload.case_id]
  );
  if (!rows[0]) {
    // Forum post not delivered yet; retry after backoff keeps ordering sane.
    throw new Error(`no thread yet for ${payload.case_ref}`);
  }
  await discord.postThreadMessage(
    rows[0].forum_thread_id,
    `**User reply on ${payload.case_ref}**\n${discord.escapeMd(payload.body).slice(0, 1500)}`
  );
}

async function dispatchSnapshotChanged(client) {
  // Lazy require: ratings -> cases -> outbox would otherwise be a load cycle.
  const ratings = require('./ratings');
  await discord.upsertRatingCard(await ratings.latestSnapshotForCard(client));
}

let running = false;

/** One worker pass. Exported for tests; scheduled by startWorker(). */
async function tick() {
  if (!db.hasDb() || !discordEnabled()) return;
  await db.tx(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM outbox WHERE state IN ('pending', 'failed') AND available_at <= now() " +
        'ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED',
      [BATCH]
    );
    let cardDone = false;
    for (const row of rows) {
      await client.query('UPDATE outbox SET locked_at = now() WHERE id = $1', [row.id]);
      try {
        if (row.event_type === 'case.created') {
          await dispatchCaseCreated(client, row.payload);
        } else if (row.event_type === 'message.created') {
          await dispatchUserMessage(client, row.payload);
        } else if (row.event_type === 'rating.snapshot.changed') {
          // Debounce: one silent card edit covers every claimed snapshot row.
          if (!cardDone) {
            await dispatchSnapshotChanged(client);
            cardDone = true;
          }
        } else {
          throw new Error(`unknown outbox event_type ${row.event_type}`);
        }
        await client.query(
          "UPDATE outbox SET state = 'sent', sent_at = now() WHERE id = $1", [row.id]
        );
      } catch (e) {
        console.error(`[outbox] ${row.event_type} #${row.id} attempt ${row.attempts + 1}: ${e.message}`);
        const backoffS = Math.min(3600, 30 * 2 ** row.attempts);
        await client.query(
          "UPDATE outbox SET state = 'failed', attempts = attempts + 1, " +
            "last_error_code = $2, available_at = now() + ($3::int * interval '1 second') WHERE id = $1",
          [row.id, String(e.status || 'error'), backoffS]
        );
      }
    }
  });
}

let timer = null;

function startWorker() {
  if (timer) return;
  running = true;
  timer = setInterval(() => {
    tick().catch((e) => console.error('[outbox] tick failed: ' + e.message));
  }, INTERVAL_MS);
  timer.unref();
  console.log(`[outbox] worker started (discord dispatch ${discordEnabled() ? 'ENABLED' : 'disabled — rows stay pending'})`);
}

/** For /readyz: the worker loop has been started. */
function isRunning() {
  return running;
}

module.exports = { enqueue, tick, startWorker, isRunning };
