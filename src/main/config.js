/**
 * Public build configuration. No credential belongs in this file or bundle.
 * The canonical relay's deployed public endpoint is deliberately unset until
 * verified. Configuration validity does not establish remote readiness.
 */
'use strict';

const { endpointUrl, supportConfigRevision } = require('./support-client');
let generated = {};
let generatedState = 'absent';
try {
  const resolved = require.resolve('./config.generated.js');
  generatedState = 'invalid';
  const loaded = require(resolved);
  if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
    generated = loaded;
    generatedState = 'loaded';
  }
} catch (error) {
  // Only a genuinely absent generated file permits the development input.
  // A resolved but broken file, or an unknown resolution failure, fails closed.
  if (generatedState === 'absent' && (!error || error.code !== 'MODULE_NOT_FOUND')) generatedState = 'invalid';
}

const bundled = generatedState !== 'absent';
const rawEndpoint = bundled ? generated.FEEDBACK_PROXY_URL : process.env.FEEDBACK_PROXY_URL;
const emptyInput = rawEndpoint === undefined || rawEndpoint === '';
const parsedEndpoint = endpointUrl(rawEndpoint);
const inputValid = emptyInput || Boolean(parsedEndpoint);
const normalizedEndpoint = parsedEndpoint ? parsedEndpoint.href : '';
const computedRevision = supportConfigRevision(normalizedEndpoint);
const recordedRevision = generated.FEEDBACK_CONFIG_REVISION;
const integrity = inputValid && (!bundled || (generatedState === 'loaded' &&
  typeof recordedRevision === 'string' && /^[a-f0-9]{64}$/.test(recordedRevision) &&
  recordedRevision === computedRevision));

module.exports = {
  FEEDBACK_PROXY_URL: integrity ? normalizedEndpoint : '',
  FEEDBACK_CONFIG_REVISION: integrity ? computedRevision : '',
  FEEDBACK_CONFIG_SOURCE: bundled ? 'bundled' : 'development',
  FEEDBACK_CONFIG_INTEGRITY: integrity,

  // Preserve the existing, independent product-directory configuration.
  PRODUCTS_URL: process.env.PRODUCTS_URL || generated.PRODUCTS_URL || 'https://botify-network.com/'
};
