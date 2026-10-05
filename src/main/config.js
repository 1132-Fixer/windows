/** Public build configuration. Every bundled value is publicly readable. */
let generated = {};
try {
  generated = require('./config.generated.js');
} catch (_) {
  // Development may configure the public endpoint through the environment.
}

module.exports = {
  // No default endpoint until the deployed support service is verified.
  // Never place credentials, private destinations or access tokens here.
  FEEDBACK_PROXY_URL: process.env.FEEDBACK_PROXY_URL || generated.FEEDBACK_PROXY_URL || '',

  // Public product directory opened only through the existing URL allowlist.
  PRODUCTS_URL: process.env.PRODUCTS_URL || generated.PRODUCTS_URL || 'https://botify-network.com/',
};
