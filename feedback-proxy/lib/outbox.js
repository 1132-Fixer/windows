/**
 * Transactional outbox: Discord delivery that cannot lose an accepted case.
 *
 * enqueue() runs on the SAME transaction as the ticket/message/rating write,
 * so a crash between commit and delivery leaves a pending row, never a lost
 * event. The worker claims due rows with FOR UPDATE SKIP LOCKED and retries
 * failures with exponential backoff.
 *
 * DISCORD_ENABLED !== 'true' -> rows accumulate pending and nothing is sent.
 * That is the dark-launch flag: schema and API run live while Discord output
 * stays off until the flag flips.
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
function enqueue(client, kind, payload) {
  return client.query(
    'INSERT INTO outbox (kind, payload) VALUES ($1, $2)',
    [kind, JSON.stringify(payload)]
  );
}

async function dispatchTicketCreated(client, payload) {
  const ids = await discord.createForumPost(payload);
  await client.query(
    'UPDATE tickets SET discord_channel_id = $1, discord_thread_id = $2, ' +
      'discord_message_id = $3, updated_at = now() WHERE id = $4',
    [process.env.DISCORD_SUPPORT_FORUM_ID, ids.thread_id, ids.message_id, payload.ticket_id]
  );
  await client.query(
    "INSERT INTO ticket_events (ticket_id, event, detail) VALUES ($1, 'discord.posted', $2)",
    [payload.ticket_id, JSON.stringify({ thread_id: ids.thread_id })]
  );
}

async function dispatchUserMessage(client, payload) {
  const { rows } = await client.query(
    'SELECT discord_thread_id FROM tickets WHERE id = $1', [payload.ticket_id]
  );
  if (!rows[0] || !rows[0].discord_thread_id) {
    // Forum post not delivered yet; retry after backoff keeps ordering sane.
    throw new Error(`no thread yet for ${payload.case_ref}`);
  }
  await discord.postThreadMessage(
    rows[0].discord_thread_id,
    `**User reply on ${payload.case_ref} (#${payload.sequence})**\n${payload.body}`
  );
}

async function dispatchRatingChanged(client) {
  // Lazy require: ratings -> cases -> outbox would otherwise be a load cycle.
  const ratings = require('./ratings');
  await discord.upsertRatingDashboard(client, await ratings.computeSummary(null));
}

/** One worker pass. Exported for tests; scheduled by startWorker(). */
async function tick() {
  if (!db.hasDb() || !discordEnabled()) return;
  await db.tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= now() ' +
        'ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
      [BATCH]
    );
    let dashboardDone = false;
    for (const row of rows) {
      try {
        if (row.kind === 'ticket.created') {
          await dispatchTicketCreated(client, row.payload);
        } else if (row.kind === 'message.user') {
          await dispatchUserMessage(client, row.payload);
        } else if (row.kind === 'rating.changed') {
          // Debounce: one dashboard edit covers every claimed rating.changed row.
          if (!dashboardDone) {
            await dispatchRatingChanged(client);
            dashboardDone = true;
          }
        } else {
          throw new Error(`unknown outbox kind ${row.kind}`);
        }
        await client.query('UPDATE outbox SET delivered_at = now() WHERE id = $1', [row.id]);
      } catch (e) {
        console.error(`[outbox] ${row.kind} #${row.id} attempt ${row.attempts + 1}: ${e.message}`);
        const backoffS = Math.min(3600, 30 * 2 ** row.attempts);
        await client.query(
          "UPDATE outbox SET attempts = attempts + 1, " +
            "next_attempt_at = now() + ($2::int * interval '1 second') WHERE id = $1",
          [row.id, backoffS]
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
