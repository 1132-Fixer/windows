/**
 * Discord HTTP interactions endpoint (plan §4, §8).
 *
 * Order of operations is the security contract:
 *   1. Verify Ed25519 signature over the RAW body. Invalid -> 401, before
 *      any JSON parsing.
 *   2. PING -> PONG (Discord's endpoint verification; carries no guild).
 *   3. EVERY other interaction re-verifies guild + staff roles. A custom_id
 *      is routing data, never authorization.
 */
'use strict';

const crypto = require('crypto');
const cases = require('./cases');
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

function isStaff(interaction) {
  if (interaction.guild_id !== (process.env.DISCORD_GUILD_ID || '__unset__')) return false;
  const staffIds = (process.env.DISCORD_STAFF_ROLE_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!staffIds.length) return false; // fail closed when roles unconfigured
  const memberRoles = (interaction.member && interaction.member.roles) || [];
  return memberRoles.some((r) => staffIds.includes(r));
}

function ephemeral(res, content) {
  return json(res, 200, {
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
}

const CASE_REF = /^F-\d+$/;

function replyModal(res, caseRef) {
  return json(res, 200, {
    type: 9,
    data: {
      custom_id: `reply_modal:${caseRef}`,
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
            label: 'Next status: waiting / review / resolve',
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
  case_closed: 'Case is closed — reopen it before acting on it.',
  bad_status_word: 'Unknown status — use waiting, review, or resolve.',
};

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
  const [action, caseRef] = customId.split(':');
  if (!CASE_REF.test(caseRef || '')) return ephemeral(res, 'Malformed control.');

  try {
    if (interaction.type === 3 && action === 'reply') {
      return replyModal(res, caseRef);
    }
    if (interaction.type === 3 && action === 'resolve') {
      await cases.staffResolve(caseRef);
      return ephemeral(res, `${caseRef} marked RESOLVED.`);
    }
    if (interaction.type === 5 && action === 'reply_modal') {
      const values = modalValues(interaction);
      const body = (values.message || '').trim();
      if (!body) return ephemeral(res, 'Reply text is required.');
      const out = await cases.staffReply(caseRef, body, (values.status || '').trim().toLowerCase());
      return ephemeral(res, `Reply saved to ${caseRef} (status: ${out.status}).`);
    }
  } catch (e) {
    if (e.staff) return ephemeral(res, STAFF_ERROR_TEXT[e.code] || 'Action failed.');
    throw e;
  }
  return ephemeral(res, 'Unsupported interaction.');
}

module.exports = { handle };
