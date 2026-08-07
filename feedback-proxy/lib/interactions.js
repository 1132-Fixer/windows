/**
 * Discord HTTP interactions endpoint (POST /v1/discord/interactions).
 *
 * Order of operations is the security contract:
 *   1. Verify Ed25519 signature over the RAW body. Invalid -> 401, before
 *      any JSON parsing.
 *   2. PING -> PONG (Discord's endpoint verification; carries no guild).
 *   3. EVERY other interaction re-verifies guild + staff roles. A custom_id
 *      is routing data, never authorization — and carries only the public
 *      caseRef, never secrets or raw database ids.
 *   4. Each interaction id is recorded once (discord_interactions PK), so a
 *      Discord retry cannot apply the same action twice.
 *   5. The reply modal carries the case control_epoch captured at open
 *      time; a mismatch at submit is rejected (stale controls cannot
 *      change a newer case).
 *
 * Buttons: Reply and Resolve are live; Assign to me / Request diagnostics /
 * More actions… exist on the card and answer acknowledged-not-implemented.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db');
const cases = require('./cases');
const ids = require('./ids');
const { json, readBody } = require('./http');

const MAX_BODY_BYTES = 64 * 1024;

// Ed25519 SPKI DER prefix: crypto.createPublicKey cannot import a raw 32-byte
// key, so wrap it in the standard header (RFC 8410).
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifySignature(rawBody, signatureHex, timestamp) {
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY || '';
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
      key,
      Buffer.from(signatureHex, 'hex')
    );
  } catch {
    return false;
  }
}

function staffRoleIds() {
  return (process.env.DISCORD_SUPPORT_ROLE_IDS || '')
    .split(',')
    .concat((process.env.DISCORD_LEAD_ROLE_IDS || '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function isStaff(interaction) {
  if (interaction.guild_id !== (process.env.DISCORD_GUILD_ID || '__unset__')) return false;
  const allowed = staffRoleIds();
  if (!allowed.length) return false; // fail closed when roles unconfigured
  const memberRoles = (interaction.member && interaction.member.roles) || [];
  return memberRoles.some((r) => allowed.includes(r));
}

function ephemeral(res, content) {
  return json(res, 200, {
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
}

function replyModal(res, caseRef, epoch) {
  return json(res, 200, {
    type: 9,
    data: {
      custom_id: `reply_modal:${caseRef}:${epoch}`,
      title: `Reply to ${caseRef}`,
      components: [
        {
          type: 1,
          components: [{
            type: 4, custom_id: 'message', style: 2, required: true,
            label: 'Message to the user', max_length: 2000,
          }],
        },
        {
          type: 1,
          components: [{
            type: 4, custom_id: 'status', style: 1, required: false,
            label: 'After sending: waiting / review / resolve',
            placeholder: 'waiting', max_length: 10,
          }],
        },
      ],
    },
  });
}

function modalValues(interaction) {
  const values = {};
  for (const row of interaction.data.components || []) {
    for (const c of row.components || []) values[c.custom_id] = c.value || '';
  }
  return values;
}

const STAFF_ERROR_TEXT = {
  case_not_found: 'Case not found.',
  case_locked: 'Case is marked spam — restore it before acting on it.',
  bad_status_word: 'Unknown status — use waiting, review, or resolve.',
  stale_epoch: 'This case changed since the control was issued. Re-open it and try again.',
};

const STUB_ACTIONS = new Map([
  ['assign', 'Assign to me is acknowledged but not implemented yet.'],
  ['diag', 'Request diagnostics is acknowledged but not implemented yet.'],
  ['more', 'More actions… is acknowledged but not implemented yet.'],
]);

/**
 * Record the interaction exactly once. Returns false when this interaction
 * id was already processed (Discord retry / double delivery).
 */
async function recordInteraction(interaction, caseUuid, action) {
  const { rowCount } = await db.query(
    'INSERT INTO discord_interactions (interaction_id, case_id, discord_user_id, action, response_state) ' +
      "VALUES ($1, $2, $3, $4, 'received') ON CONFLICT (interaction_id) DO NOTHING",
    [interaction.id, caseUuid, (interaction.member && interaction.member.user && interaction.member.user.id) || 'unknown', action]
  );
  return rowCount === 1;
}

function finishInteraction(interactionId, state) {
  return db.query(
    'UPDATE discord_interactions SET response_state = $2, completed_at = now() WHERE interaction_id = $1',
    [interactionId, state]
  );
}

async function caseUuidOf(caseRef) {
  const { rows } = await db.query('SELECT id FROM support_cases WHERE case_ref = $1', [caseRef]);
  return rows[0] ? rows[0].id : null;
}

async function handle(req, res) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch {
    return json(res, 400, { ok: false, error: 'bad_request' });
  }

  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  if (!verifySignature(raw, sig, ts)) {
    return json(res, 401, { ok: false, error: 'invalid_signature' });
  }

  let interaction;
  try {
    interaction = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(res, 400, { ok: false, error: 'bad_json' });
  }

  if (interaction.type === 1) return json(res, 200, { type: 1 }); // PING -> PONG

  if (!isStaff(interaction)) return ephemeral(res, 'Not authorized.');

  const customId = (interaction.data && interaction.data.custom_id) || '';
  const [action, caseRef, epochStr] = customId.split(':');
  if (!ids.CASE_REF_RE.test(caseRef || '')) return ephemeral(res, 'Malformed control.');
  const staffUserId = (interaction.member && interaction.member.user && interaction.member.user.id) || 'unknown';

  const caseUuid = await caseUuidOf(caseRef);
  if (!caseUuid) return ephemeral(res, STAFF_ERROR_TEXT.case_not_found);
  const fresh = await recordInteraction(interaction, caseUuid, action);
  if (!fresh) return ephemeral(res, 'Already handled.');

  try {
    if (interaction.type === 3 && STUB_ACTIONS.has(action)) {
      await finishInteraction(interaction.id, 'applied');
      return ephemeral(res, STUB_ACTIONS.get(action));
    }
    if (interaction.type === 3 && action === 'reply') {
      // Capture the CURRENT epoch for the modal so a stale submit is caught.
      const epoch = await cases.currentEpoch(caseRef);
      await finishInteraction(interaction.id, 'applied');
      return replyModal(res, caseRef, epoch);
    }
    if (interaction.type === 3 && action === 'resolve') {
      await cases.staffResolve(caseRef, staffUserId);
      await finishInteraction(interaction.id, 'applied');
      return ephemeral(res, `${caseRef} resolved.`);
    }
    if (interaction.type === 5 && action === 'reply_modal') {
      const values = modalValues(interaction);
      const body = (values.message || '').trim();
      if (!body) {
        await finishInteraction(interaction.id, 'rejected');
        return ephemeral(res, 'Reply text is required.');
      }
      const out = await cases.staffReply(caseRef, {
        body,
        statusWord: (values.status || '').trim().toLowerCase(),
        staffUserId,
        interactionId: interaction.id,
        expectedEpoch: Number(epochStr),
      });
      await finishInteraction(interaction.id, 'applied');
      return ephemeral(res, `Reply queued for ${caseRef} (state: ${out.state}).`);
    }
  } catch (e) {
    if (e.staff) {
      await finishInteraction(interaction.id, 'rejected').catch(() => {});
      return ephemeral(res, STAFF_ERROR_TEXT[e.code] || 'Action failed.');
    }
    await finishInteraction(interaction.id, 'failed').catch(() => {});
    throw e;
  }
  await finishInteraction(interaction.id, 'rejected');
  return ephemeral(res, 'Unsupported interaction.');
}

module.exports = { handle };
