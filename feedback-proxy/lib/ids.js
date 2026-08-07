/**
 * Random public identifiers (operator schema check constraints):
 *   installations  IN-[A-Z2-9]{10,20}
 *   support cases  FX-[A-Z2-9]{6,12}
 *
 * Random on purpose — a counting number like F-0248 is guessable. These are
 * opaque references, not secrets (the bearer token is the secret), so the
 * tiny modulo bias of byte % 34 is irrelevant.
 */
'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789'; // A-Z plus 2-9, per schema

function randomPublicId(prefix, length) {
  let s = '';
  for (const b of crypto.randomBytes(length)) s += ALPHABET[b % ALPHABET.length];
  return prefix + s;
}

const newPrincipalId = () => randomPublicId('IN-', 12);
const newCaseRef = () => randomPublicId('FX-', 8);
const newMessageId = () => randomPublicId('MS-', 10);
const CASE_REF_RE = /^FX-[A-Z2-9]{6,12}$/;
const MESSAGE_ID_RE = /^MS-[A-Z2-9]{8,16}$/;

module.exports = { newPrincipalId, newCaseRef, newMessageId, CASE_REF_RE, MESSAGE_ID_RE };
