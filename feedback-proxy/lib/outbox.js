/**
 * Transactional outbox (operator schema: outbox_events with states + lease
 * columns). enqueue() runs on the SAME transaction as the case/message/
 * rating write, so a crash between commit and delivery leaves a pending
 * row, never a lost event. The in-process worker claims due rows with
 * FOR UPDATE SKIP LOCKED; the state/locked_at columns are lease-ready for
 * the future separate support-worker service.
 *
 * DISCORD_ENABLED !== 'true' -> rows accumulate pending, nothing is sent.
 * That is the dark-launch flag: schema and API run live while Discord
 * output stays off until the flag flips.
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
    'INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) ' +
      'VALUES ($1, $2, $3, $4)',
    [aggregateType, aggregateId, eventType, JSON.stringify(payload)]
  );
}

async function dispatchCaseCreated(client, payload) {
  const ids = await discord.createForumPost(payload);
  await discord.postRoleAlert(ids.thread_id);
  await client.query(
    'UPDATE support_cases SET discord_forum_thread_id = $1, discord_starter_message_id = $2, ' +
      'updated_at = now() WHERE id = $3',
    [ids.thread_id, ids.message_id, payload.case_id]
  );
  await client.query(
    "INSERT INTO case_events (case_id, actor_type, event_type, data) VALUES ($1, 'system', 'discord.posted', $2)",
    [payload.case_id, JSON.stringify({ thread_id: ids.thread_id })]
  );
}

async function dispatchUserMessage(client, payload) {
  const { rows } = await client.query(
    'SELECT discord_forum_thread_id FROM support_cases WHERE id = $1', [payload.case_id]
  );
  if (!rows[0] || !rows[0].discord_forum_thread_id) {
    // Forum post not delivered yet; retry after backoff keeps ordering sane.
    throw new Error(`no thread yet for ${payload.public_id}`);
  }
  await discord.postThreadMessage(
    rows[0].discord_forum_thread_id,
    `**User reply on ${payload.public_id}**\n${payload.body}`
  );
}

async function dispatchSnapshotChanged(client) {
  // Lazy require: ratings -> cases -> outbox would otherwise be a load cycle.
  const ratings = require('./ratings');
  await discord.upsertRatingCard(await ratings.latestSnapshotForCard(client));
}

/** One worker pass. Exported for tests; scheduled by startWorker(). */
async function tick() {
  if (!db.hasDb() || !discordEnabled()) return;
  await db.tx(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM outbox_events WHERE state IN ('pending', 'failed') AND available_at <= now() " +
        'ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED',
      [BATCH]
    );
    let cardDone = false;
    for (const row of rows) {
      await client.query('UPDATE outbox_events SET locked_at = now() WHERE id = $1', [row.id]);
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
          "UPDATE outbox_events SET state = 'sent', sent_at = now() WHERE id = $1", [row.id]
        );
      } catch (e) {
        console.error(`[outbox] ${row.event_type} #${row.id} attempt ${row.attempts + 1}: ${e.message}`);
        const backoffS = Math.min(3600, 30 * 2 ** row.attempts);
        await client.query(
          "UPDATE outbox_events SET state = 'failed', attempts = attempts + 1, " +
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
  timer = setInterval(() => {
    tick().catch((e) => console.error('[outbox] tick failed: ' + e.message));
  }, INTERVAL_MS);
  timer.unref();
  console.log(`[outbox] worker started (discord dispatch ${discordEnabled() ? 'ENABLED' : 'disabled — rows stay pending'})`);
}

module.exports = { enqueue, tick, startWorker };
