#!/usr/bin/env node
/** Validate one operator-issued receipt before immutable artifact upload. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseEvidenceBytes,
  receiptSha256,
  validateNativeAcceptanceManifest,
  validateSupportClearance
} from './release-evidence.mjs';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const kind = process.env.RELEASE_RECEIPT_KIND || '';
  const encoded = process.env.RELEASE_RECEIPT_BASE64 || '';
  const head = process.env.GITHUB_SHA || '';
  const ref = process.env.GITHUB_REF || '';
  if (!['native', 'support'].includes(kind) || ref !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(head) || !encoded || encoded.length > 100000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    fail('receipt-issue-input');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) fail('receipt-issue-input');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const value = parseEvidenceBytes(bytes, 'receipt-issue-json');
  const fileName = kind === 'native' ? 'native-acceptance.json' : 'support-clearance.json';
  if (kind === 'native') validateNativeAcceptanceManifest(value, { expectedHead: head, expectedVersion: version });
  else validateSupportClearance(value, { expectedHead: head });
  const out = path.resolve(argOf('--out', 'receipt-out'));
  fs.mkdirSync(out, { recursive: false });
  fs.writeFileSync(path.join(out, fileName), bytes, { flag: 'wx' });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) fail('receipt-issue-output');
  const artifactName = kind === 'native'
    ? `native-acceptance-receipt-${head}`
    : `support-clearance-receipt-${head}`;
  fs.appendFileSync(output, `artifact_name=${artifactName}\nfile_name=${fileName}\n`);
  console.log(`[release-evidence-issuer] validated ${kind} receipt sha256=${receiptSha256(bytes)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[release-evidence-issuer] ${error && error.code || 'receipt-issue-failed'}`);
    process.exitCode = 1;
  });
}
