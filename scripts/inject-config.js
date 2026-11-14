#!/usr/bin/env node
/**
 * Write only the validated public support endpoint and its deterministic
 * configuration revision. This is not deployment or release acceptance.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { endpointUrl, supportConfigRevision } = require('../src/main/support-client');

const input = process.env.FEEDBACK_PROXY_URL;
const emptyInput = input === undefined || input === '';
const endpoint = endpointUrl(input);
if (!emptyInput && !endpoint) {
  // Rejected input can itself contain a credential. Never print it.
  console.error('[inject-config] Invalid public support endpoint. Use HTTPS without credentials, query parameters or fragments.');
  process.exitCode = 1;
} else {
  const normalizedEndpoint = endpoint ? endpoint.href : '';
  const outDir = path.join(__dirname, '..', 'src', 'main');
  const outFile = path.join(outDir, 'config.generated.js');
  const body = '// AUTO-GENERATED. Public configuration only. DO NOT COMMIT.\n' +
    'module.exports = ' + JSON.stringify({
      FEEDBACK_PROXY_URL: normalizedEndpoint,
      FEEDBACK_CONFIG_REVISION: supportConfigRevision(normalizedEndpoint)
    }, null, 2) + ';\n';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, body);
  console.log('[inject-config] Public configuration written.');
  if (!endpoint) console.warn('[inject-config] Support endpoint is unset; in-app submissions are unavailable.');
}
