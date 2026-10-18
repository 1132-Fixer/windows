#!/usr/bin/env node
/** Only the validated public support endpoint may enter the client bundle. */
'use strict';

const fs = require('fs');
const path = require('path');
const { endpointUrl, supportConfigRevision } = require('../src/main/support-client');

const input = (process.env.FEEDBACK_PROXY_URL || '').trim();
const endpoint = input ? endpointUrl(input) : null;
if (input && !endpoint) {
  // Never print rejected input: it may itself contain a credential.
  console.error('[inject-config] Invalid public support endpoint. Use HTTPS without credentials, query parameters or fragments.');
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'src', 'main');
const outFile = path.join(outDir, 'config.generated.js');
const normalizedEndpoint = endpoint ? endpoint.href : '';
const body = '// AUTO-GENERATED. Public configuration only. DO NOT COMMIT.\n' +
  'module.exports = ' + JSON.stringify({
    FEEDBACK_PROXY_URL: normalizedEndpoint,
    FEEDBACK_CONFIG_REVISION: supportConfigRevision(normalizedEndpoint)
  }, null, 2) + ';\n';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, body);
console.log('[inject-config] Public configuration written.');
if (!endpoint) console.warn('[inject-config] Support endpoint is unset; in-app submissions are unavailable.');
