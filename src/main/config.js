/** Public build configuration. Every bundled value is publicly readable. */
const { endpointUrl, supportConfigRevision } = require('./support-client');

let generated = {};
let generatedPresent = false;
let generatedLoaded = false;
try {
  const generatedPath = require.resolve('./config.generated.js');
  generatedPresent = true;
  const loaded = require(generatedPath);
  if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
    generated = loaded;
    generatedLoaded = true;
  }
} catch (_) {
  // An absent file permits the development input. A present file that cannot
  // load remains a bundled, invalid configuration and fails closed below.
}

// The environment is a build/development input, not a packaged-runtime
// override. Once generated configuration exists, only its integrity-bound
// public endpoint is effective.
const rawFeedbackEndpoint = generatedPresent
  ? generated.FEEDBACK_PROXY_URL
  : process.env.FEEDBACK_PROXY_URL;
const trimmedFeedbackEndpoint = typeof rawFeedbackEndpoint === 'string'
  ? rawFeedbackEndpoint.trim()
  : '';
const parsedFeedbackEndpoint = trimmedFeedbackEndpoint
  ? endpointUrl(trimmedFeedbackEndpoint)
  : null;
const feedbackEndpointInputValid = !trimmedFeedbackEndpoint || !!parsedFeedbackEndpoint;
const normalizedFeedbackEndpoint = parsedFeedbackEndpoint ? parsedFeedbackEndpoint.href : '';
const computedFeedbackRevision = supportConfigRevision(normalizedFeedbackEndpoint);
const generatedFeedbackRevision = typeof generated.FEEDBACK_CONFIG_REVISION === 'string'
  ? generated.FEEDBACK_CONFIG_REVISION.trim().toLowerCase()
  : '';
const feedbackConfigIntegrity = feedbackEndpointInputValid && (!generatedPresent ||
  (generatedLoaded && /^[a-f0-9]{64}$/.test(generatedFeedbackRevision) &&
    generatedFeedbackRevision === computedFeedbackRevision));

module.exports = {
  // No default endpoint until the deployed support service is verified.
  // Never place credentials, private destinations or access tokens here.
  FEEDBACK_PROXY_URL: feedbackConfigIntegrity ? normalizedFeedbackEndpoint : '',
  FEEDBACK_CONFIG_REVISION: feedbackConfigIntegrity ? computedFeedbackRevision : '',
  FEEDBACK_CONFIG_SOURCE: generatedPresent ? 'bundled' : 'development',
  FEEDBACK_CONFIG_INTEGRITY: feedbackConfigIntegrity,

  // Public product directory opened only through the existing URL allowlist.
  PRODUCTS_URL: process.env.PRODUCTS_URL || generated.PRODUCTS_URL || 'https://botify-network.com/',
};
