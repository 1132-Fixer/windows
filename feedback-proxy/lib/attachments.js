/**
 * Bug-report screenshot attachments (#141).
 *
 * Images only, 5 MB max, single attachment per case. The claimed MIME type is
 * never trusted: the stored media_type comes from magic-byte sniffing. JPEG
 * and PNG metadata segments (EXIF/XMP/IPTC, textual chunks) are stripped
 * before storage — screenshots can carry location data from the capturing
 * device. GIF and WebP pass through unmodified (neither format carries EXIF
 * in the screenshot tools we accept them from; noted honestly here rather
 * than pretending to strip).
 *
 * Bytes live in attachment_blobs; the attachments row (frozen 001-core
 * schema) points at them via object_key 'db:<uuid>'. redaction_state starts
 * 'pending' and flips 'approved' exactly once, when the outbox worker claims
 * the Discord forward. Raw image bytes are never logged.
 */
'use strict';

const crypto = require('crypto');

const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
// Retention hook the frozen schema demands (expires_at NOT NULL). No numeric
// period exists anywhere in the spec pack; 90 days matches the rating window
// used elsewhere in this service and is recorded in the PR.
const RETENTION_DAYS = 90;

// --- magic-byte sniffing ---------------------------------------------

/** Sniffed image type of buf, or null when it is not an accepted image. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mediaType: 'image/png', ext: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mediaType: 'image/jpeg', ext: 'jpg' };
  }
  const head6 = buf.toString('latin1', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { mediaType: 'image/gif', ext: 'gif' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mediaType: 'image/webp', ext: 'webp' };
  }
  return null;
}

// --- metadata stripping ----------------------------------------------

/**
 * Drop JPEG APP1 (EXIF/XMP) and APP13 (IPTC) segments. Copies everything
 * from SOS onward verbatim. A malformed walk returns the original buffer:
 * the image already passed the magic sniff, and best-effort privacy
 * hardening must not reject a valid-enough screenshot.
 */
function stripJpeg(buf) {
  try {
    const parts = [buf.subarray(0, 2)]; // SOI
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return buf; // lost segment sync
      const marker = buf[i + 1];
      if (marker === 0xda) { // SOS: entropy-coded data + EOI follow
        parts.push(buf.subarray(i));
        return Buffer.concat(parts);
      }
      const segLen = buf.readUInt16BE(i + 2) + 2;
      if (segLen < 4 || i + segLen > buf.length) return buf;
      if (marker !== 0xe1 && marker !== 0xed) parts.push(buf.subarray(i, i + segLen));
      i += segLen;
    }
    return buf;
  } catch {
    return buf;
  }
}

const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/** Drop PNG textual/EXIF/time chunks; malformed input returns the original. */
function stripPng(buf) {
  try {
    const parts = [buf.subarray(0, 8)]; // signature
    let i = 8;
    while (i + 12 <= buf.length) {
      const dataLen = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      const chunkLen = 12 + dataLen;
      if (i + chunkLen > buf.length) return buf;
      if (!PNG_METADATA_CHUNKS.has(type)) parts.push(buf.subarray(i, i + chunkLen));
      i += chunkLen;
      if (type === 'IEND') break;
    }
    return Buffer.concat(parts);
  } catch {
    return buf;
  }
}

function stripMetadata(buf, mediaType) {
  if (mediaType === 'image/jpeg') return stripJpeg(buf);
  if (mediaType === 'image/png') return stripPng(buf);
  return buf; // gif/webp: passed through, see module header
}

// --- validation ------------------------------------------------------

/**
 * Validate a client-supplied base64 screenshot. Returns
 *   { ok:true, bytes, mediaType, ext } (bytes already metadata-stripped) or
 *   { ok:false, message } with client-safe copy.
 */
function validateScreenshot(field) {
  const data = field && typeof field === 'object' ? field.data : field;
  if (typeof data !== 'string' || !data.length) {
    return { ok: false, message: 'screenshot.data must be a base64 string.' };
  }
  // Cheap pre-decode bound: 5 MB encodes to ~6.7 MB of base64.
  if (data.length > Math.ceil((SCREENSHOT_MAX_BYTES * 4) / 3) + 8) {
    return { ok: false, message: 'Screenshot must be 5 MB or smaller.' };
  }
  let bytes;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    return { ok: false, message: 'screenshot.data is not valid base64.' };
  }
  if (!bytes.length) return { ok: false, message: 'screenshot.data is not valid base64.' };
  if (bytes.length > SCREENSHOT_MAX_BYTES) {
    return { ok: false, message: 'Screenshot must be 5 MB or smaller.' };
  }
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    return { ok: false, message: 'Only image files can be attached (PNG, JPEG, WebP, or GIF).' };
  }
  return { ok: true, bytes: stripMetadata(bytes, sniffed.mediaType), ...sniffed };
}

// --- persistence -----------------------------------------------------

/** Insert blob + attachments row on the caller's transaction. */
async function saveScreenshot(client, caseId, messageId, validated) {
  const blob = await client.query(
    'INSERT INTO attachment_blobs (data) VALUES ($1) RETURNING id',
    [validated.bytes]
  );
  await client.query(
    'INSERT INTO attachments ' +
      '(case_id, message_id, object_key, media_type, byte_size, sha256, redaction_state, expires_at) ' +
      "VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + ($7::int * interval '1 day'))",
    [caseId, messageId, 'db:' + blob.rows[0].id, validated.mediaType,
     validated.bytes.length, crypto.createHash('sha256').update(validated.bytes).digest(),
     RETENTION_DAYS]
  );
}

/**
 * Claim the case's un-forwarded screenshot for Discord dispatch (at most
 * once, same conditional-UPDATE pattern as the role alert). Returns
 * { filename, contentType, data } or null when there is nothing to forward.
 */
async function claimForDispatch(db, caseId) {
  const { rows } = await db.query(
    "UPDATE attachments SET redaction_state = 'approved' " +
      "WHERE case_id = $1 AND redaction_state = 'pending' " +
      'RETURNING id, object_key, media_type',
    [caseId]
  );
  const a = rows[0];
  if (!a || !a.object_key.startsWith('db:')) return null;
  const blob = await db.query(
    'SELECT data FROM attachment_blobs WHERE id = $1',
    [a.object_key.slice(3)]
  );
  if (!blob.rows[0]) return null;
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[a.media_type] || 'bin';
  return { filename: 'screenshot.' + ext, contentType: a.media_type, data: blob.rows[0].data };
}

/** Retention: delete expired attachment rows and their blobs. */
async function purgeExpired(db) {
  await db.query(
    'DELETE FROM attachment_blobs WHERE id IN (' +
      "SELECT substring(object_key from 4)::uuid FROM attachments " +
      "WHERE expires_at <= now() AND object_key LIKE 'db:%')"
  );
  await db.query('DELETE FROM attachments WHERE expires_at <= now()');
}

module.exports = {
  SCREENSHOT_MAX_BYTES, RETENTION_DAYS,
  sniffImage, stripMetadata, validateScreenshot,
  saveScreenshot, claimForDispatch, purgeExpired,
};
