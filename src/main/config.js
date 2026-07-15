/**
 * 1132 Fixer - Build Configuration
 *
 * THERE IS NO SECRET IN THIS FILE, AND THERE MUST NEVER BE ONE AGAIN.
 *
 * History: this file used to hardcode a GitHub PAT so the app could POST
 * feedback issues to the API directly. That does not work safely. Whatever is
 * in this file gets bundled into app.asar inside the shipped installer, and
 * asar stores file contents UNCOMPRESSED — so the token was recoverable from
 * the public download in about a minute:
 *
 *     7za x 1132-Fixer-Portable-5.3.10.exe -oext
 *     grep -a "GH_ISSUES_TOKEN" ext/resources/app.asar
 *
 * Injecting the token at build time instead of committing it did not fix that
 * either — it only kept the secret out of git. It still shipped.
 *
 * The fix is architectural: the token now lives server-side in
 * `feedback-proxy/`, and the app posts plain JSON to a PUBLIC url. A url is
 * not a credential, so it is safe to hardcode and safe to extract. There is
 * nothing in this build worth stealing.
 *
 * FEEDBACK_PROXY_URL may still be overridden at build time (see
 * scripts/inject-config.js) to point at staging, but it is not a secret and
 * requires no protection.
 *
 * If the proxy is unreachable or unset, submit-feedback degrades gracefully —
 * the app keeps working and the form reports that feedback is unavailable.
 */

let generated = {};
try {
  // Written by scripts/inject-config.js at build time; gitignored.
  generated = require('./config.generated.js');
} catch (_) {
  // Absent in a plain `npm start` — fall back to env, then the default below.
}

module.exports = {
  // Public endpoint. NOT a secret.
  FEEDBACK_PROXY_URL:
    process.env.FEEDBACK_PROXY_URL ||
    generated.FEEDBACK_PROXY_URL ||
    '',
};
