/**
 * Discord REST helpers (API v10, plain fetch, bot token from env).
 *
 * Messages use Components V2 (IS_COMPONENTS_V2 flag; Container/TextDisplay/
 * Separator + button rows) per the operator's Discord design plan — no
 * legacy content/embeds on those messages. Callers run inside the outbox
 * worker: failures throw, the row stays pending, the worker retries.
 * The bot token is never logged.
 */
'use strict';

const API = 'https://discord.com/api/v10';
const IS_COMPONENTS_V2 = 1 << 15; // 32768

// User text must never ping. The one deliberate role alert builds its own
// explicit allowlist instead.
const NO_MENTIONS = { parse: [] };

// Component type ids (Components V2)
const ACTION_ROW = 1;
const BUTTON = 2;
const TEXT_DISPLAY = 10;
const SEPARATOR = 14;
const CONTAINER = 17;

const BLUE = 0x2563eb;  // main action color (quality review palette)
const AMBER = 0xffb020; // warning accent

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

const KIND_LABEL = {
  bug: '\u{1F41E} Bug report',
  feedback: '\u{1F4AC} Feedback',
  rating_feedback: '⭐ Rating feedback',
};

const text = (content) => ({ type: TEXT_DISPLAY, content });

/** Starter message for a case forum post — six facts, short, phone-friendly. */
function buildCaseMessage(p) {
  const env = p.environment || {};
  const facts = [
    'STATE         \u{1F7E1} New',
    `PRIORITY      ${p.priority || 'normal'}`,
    `SOURCE        ${p.source} · ${p.app_version}`,
    'ASSIGNED      Unassigned',
    `ENVIRONMENT   ${env.os || 'unknown'}`,
    `DIAGNOSTICS   ${env.impact ? 'Impact: ' + env.impact : 'none provided'}`,
  ].join('\n');
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: NO_MENTIONS,
    components: [{
      type: CONTAINER,
      accent_color: p.kind === 'bug' ? AMBER : BLUE,
      components: [
        text(`**${KIND_LABEL[p.kind] || p.kind} · ${p.public_id}**\n**${p.subject}**`),
        text(String(p.summary).slice(0, 1500)),
        { type: SEPARATOR, divider: true, spacing: 1 },
        text('```\n' + facts + '\n```'),
        text(`-# 1132 Fixer • One-click fix for Zoom Error 1132 • ${p.public_id}`),
        {
          type: ACTION_ROW,
          components: [
            { type: BUTTON, style: 1, label: '\u{1F4AC} Reply', custom_id: `reply:${p.public_id}` },
            { type: BUTTON, style: 3, label: 'Resolve', custom_id: `resolve:${p.public_id}` },
          ],
        },
      ],
    }],
  };
}

/** Forum tags for kind/state/platform, from the DISCORD_TAG_* env ids that are set. */
function forumTags(p) {
  const kindTag = {
    bug: process.env.DISCORD_TAG_TYPE_BUG_ID,
    feedback: process.env.DISCORD_TAG_TYPE_FEEDBACK_ID,
    rating_feedback: process.env.DISCORD_TAG_TYPE_RATING_ID,
  }[p.kind];
  const platformTag = {
    windows: process.env.DISCORD_TAG_PLATFORM_WINDOWS_ID,
    chrome: process.env.DISCORD_TAG_PLATFORM_CHROME_ID,
    macos: process.env.DISCORD_TAG_PLATFORM_MACOS_ID,
  }[p.source];
  return [kindTag, process.env.DISCORD_TAG_STATE_NEW_ID, platformTag].filter(Boolean);
}

/** One case = one forum post. Returns { thread_id, message_id }. */
async function createForumPost(p) {
  const forumId = process.env.DISCORD_SUPPORT_FORUM_ID;
  if (!forumId) throw new Error('DISCORD_SUPPORT_FORUM_ID not set');
  const body = {
    name: `${p.public_id} · ${p.subject}`.slice(0, 100),
    message: buildCaseMessage(p),
  };
  const tags = forumTags(p);
  if (tags.length) body.applied_tags = tags.slice(0, 5);
  const thread = await api('POST', `/channels/${forumId}/threads`, body);
  // A forum post's starter message shares the thread's id.
  return { thread_id: thread.id, message_id: thread.id };
}

/**
 * The one deliberate role alert: a separate bot-owned line whose
 * allowed_mentions allowlists exactly the first configured support role.
 */
async function postRoleAlert(threadId) {
  const roleId = (process.env.DISCORD_SUPPORT_ROLE_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (!roleId) return; // no role configured -> no ping, case post still stands
  await api('POST', `/channels/${threadId}/messages`, {
    content: `<@&${roleId}> new case`,
    allowed_mentions: { parse: [], roles: [roleId] },
  });
}

function postThreadMessage(threadId, content) {
  return api('POST', `/channels/${threadId}/messages`, {
    content: String(content).slice(0, 1900),
    allowed_mentions: NO_MENTIONS,
  });
}

// ---- pinned live-rating card ---------------------------------------

function bar(n, max) {
  const width = max > 0 ? Math.round((n / max) * 10) : 0;
  return '█'.repeat(width);
}

function buildRatingCard(s) {
  let lines;
  if (s.state !== 'ready') {
    lines = ['**1132 Fixer — verified rating**', '', 'Collecting verified ratings'];
  } else {
    const d = s.distribution || {};
    const max = Math.max(...[5, 4, 3, 2, 1].map((n) => d[n] || 0));
    lines = [
      '**1132 Fixer — verified rating**',
      '',
      `**${s.score.toFixed(2)} / 5** · ${s.count} verified · last 90 days`,
      '',
      ...[5, 4, 3, 2, 1].map((n) => `${n}★  ${bar(d[n] || 0, max).padEnd(10)} ${d[n] || 0}`),
    ];
  }
  lines.push('', `-# Verified in-app ratings only · updated <t:${Math.floor(Date.now() / 1000)}:R>`);
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: NO_MENTIONS,
    components: [{ type: CONTAINER, accent_color: BLUE, components: [text(lines.join('\n'))] }],
  };
}

// The env var is the durable pointer to the pinned card; this cache only
// bridges the gap between first creation and the operator setting it.
let createdCardMessageId = null;

/** Silent in-place edit of the pinned rating card; creates it once if absent. */
async function upsertRatingCard(snapshot) {
  const channelId = process.env.DISCORD_LIVE_RATING_CHANNEL_ID;
  if (!channelId) throw new Error('DISCORD_LIVE_RATING_CHANNEL_ID not set');
  const card = buildRatingCard(snapshot);
  const messageId = process.env.DISCORD_LIVE_RATING_MESSAGE_ID || createdCardMessageId;
  if (messageId) {
    try {
      await api('PATCH', `/channels/${channelId}/messages/${messageId}`, card);
      return;
    } catch (e) {
      if (e.status !== 404) throw e; // deleted card: fall through and recreate
    }
  }
  const msg = await api('POST', `/channels/${channelId}/messages`, card);
  createdCardMessageId = msg.id;
  console.log(`[discord] created live rating card — set DISCORD_LIVE_RATING_MESSAGE_ID=${msg.id}`);
}

module.exports = { createForumPost, postRoleAlert, postThreadMessage, upsertRatingCard };
