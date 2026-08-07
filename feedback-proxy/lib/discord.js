/**
 * Discord REST helpers (API v10, plain fetch, bot token from env).
 *
 * Callers run inside the outbox worker: any failure here throws, the outbox
 * row stays pending, and the worker retries with backoff. The bot token is
 * never logged.
 */
'use strict';

const API = 'https://discord.com/api/v10';

// Every message payload sets allowed_mentions: user text must never ping.
const NO_MENTIONS = { parse: [] };

async function api(method, path, body) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN not set');
  const doFetch = () =>
    fetch(API + path, {
      method,
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let r = await doFetch();
  if (r.status === 429) {
    const data = await r.json().catch(() => ({}));
    const waitS = Math.min(30, Number(data.retry_after) || 1);
    await new Promise((resolve) => setTimeout(resolve, waitS * 1000));
    r = await doFetch(); // once; a second 429 falls through to the throw below
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw Object.assign(
      new Error(`discord ${method} ${path} -> ${r.status} ${detail.slice(0, 200)}`),
      { status: r.status }
    );
  }
  return r.status === 204 ? null : r.json();
}

const TYPE_EMOJI = { bug: '\u{1F41E}', rating: '⭐', message: '✉️' };

/** Root embed, plan §4 field list; '—' where the framework has no data yet. */
function buildTicketEmbed(t) {
  const none = '—';
  return {
    title: `${TYPE_EMOJI[t.type] || ''} ${t.type.toUpperCase()} • ${t.case_ref} • ${t.subject}`.slice(0, 256),
    description: t.body ? String(t.body).slice(0, 2000) : undefined,
    fields: [
      { name: 'Status', value: 'NEW', inline: true },
      { name: 'Impact', value: none, inline: true },
      { name: 'Internal priority', value: none, inline: true },
      { name: 'Assigned', value: 'unassigned', inline: true },
      { name: 'App version', value: t.app_version || 'unknown', inline: true },
      { name: 'Windows build', value: t.os_info || 'unknown', inline: true },
      { name: 'Preflight result', value: none, inline: true },
      { name: 'Diagnostics', value: none, inline: true },
      { name: 'Installation', value: `${String(t.installation_public_id).slice(0, 8)}…`, inline: true },
      { name: 'Created', value: t.created_at, inline: true },
      { name: 'Latest user activity', value: t.created_at, inline: true },
      { name: 'Delivery to Windows', value: 'pending', inline: true },
    ],
    footer: { text: `1132 Fixer • Case ${t.case_ref}` },
  };
}

function buildTicketComponents(caseRef) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Reply', custom_id: `reply:${caseRef}` },
      { type: 2, style: 3, label: 'Resolve', custom_id: `resolve:${caseRef}` },
    ],
  }];
}

/** One case = one forum post + thread. Returns { thread_id, message_id }. */
async function createForumPost(ticketPayload) {
  const forumId = process.env.DISCORD_SUPPORT_FORUM_ID;
  if (!forumId) throw new Error('DISCORD_SUPPORT_FORUM_ID not set');
  const thread = await api('POST', `/channels/${forumId}/threads`, {
    name: `${ticketPayload.case_ref} • ${ticketPayload.subject}`.slice(0, 100),
    message: {
      embeds: [buildTicketEmbed(ticketPayload)],
      components: buildTicketComponents(ticketPayload.case_ref),
      allowed_mentions: NO_MENTIONS,
    },
  });
  // A forum post's starter message shares the thread's id.
  return { thread_id: thread.id, message_id: thread.id };
}

function postThreadMessage(threadId, content) {
  return api('POST', `/channels/${threadId}/messages`, {
    content: String(content).slice(0, 1900),
    allowed_mentions: NO_MENTIONS,
  });
}

function editMessage(channelId, messageId, payload) {
  return api('PATCH', `/channels/${channelId}/messages/${messageId}`,
    Object.assign({ allowed_mentions: NO_MENTIONS }, payload));
}

function buildRatingEmbed(s) {
  const stars = [5, 4, 3, 2, 1]
    .map((n) => `${n}★ ${s.distribution[n]}`)
    .join('  ');
  return {
    title: '1132 Fixer — live verified rating',
    fields: [
      {
        name: 'Current (30 days)',
        value: s.enough_data ? `${s.score.toFixed(1)} / 5 · ${s.count} verified` : `not enough data (${s.count})`,
        inline: false,
      },
      { name: 'Distribution', value: stars, inline: false },
    ],
    footer: { text: 'Verified in-app ratings only · 30-day window' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Keep exactly one dashboard embed in DISCORD_RATING_CHANNEL_ID, tracked in
 * dashboard_messages under key 'rating'. `client` is the worker's tx client.
 */
async function upsertRatingDashboard(client, summaryData) {
  const channelId = process.env.DISCORD_RATING_CHANNEL_ID;
  if (!channelId) throw new Error('DISCORD_RATING_CHANNEL_ID not set');
  const embed = buildRatingEmbed(summaryData);
  const { rows } = await client.query(
    "SELECT channel_id, message_id FROM dashboard_messages WHERE key = 'rating'"
  );
  if (rows[0]) {
    try {
      await editMessage(rows[0].channel_id, rows[0].message_id, { embeds: [embed] });
      await client.query("UPDATE dashboard_messages SET updated_at = now() WHERE key = 'rating'");
      return;
    } catch (e) {
      if (e.status !== 404) throw e; // deleted message: fall through and recreate
    }
  }
  const msg = await api('POST', `/channels/${channelId}/messages`, {
    embeds: [embed],
    allowed_mentions: NO_MENTIONS,
  });
  await client.query(
    "INSERT INTO dashboard_messages (key, channel_id, message_id) VALUES ('rating', $1, $2) " +
      'ON CONFLICT (key) DO UPDATE SET channel_id = $1, message_id = $2, updated_at = now()',
    [channelId, msg.id]
  );
}

module.exports = { createForumPost, postThreadMessage, editMessage, upsertRatingDashboard };
