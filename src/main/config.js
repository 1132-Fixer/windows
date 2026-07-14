/**
 * 1132 Fixer - Build Configuration (secret-free)
 *
 * The GitHub feedback token is NEVER hardcoded in this file. Committing a
 * token to a public repo leaks it permanently (it stays in git history even
 * after deletion) and lets anyone spam the issue tracker with it. Instead the
 * token is supplied at build/run time from one of, in priority order:
 *
 *   1. process.env.GH_ISSUES_TOKEN          (dev: `set GH_ISSUES_TOKEN=... && npm start`)
 *   2. src/main/config.generated.js         (build: written by scripts/inject-config.js,
 *                                            gitignored, baked into the packaged app)
 *
 * To produce a build with working in-app feedback:
 *   set GH_ISSUES_TOKEN=github_pat_...      (Windows cmd)
 *   $env:GH_ISSUES_TOKEN='github_pat_...'   (PowerShell)
 *   npm run build                           (prebuild injects it automatically)
 *
 * In CI, define GH_ISSUES_TOKEN as a repository/action secret.
 *
 * If no token is present the app still runs — submit-feedback simply returns
 * "Feedback service not configured" and the feedback form degrades gracefully.
 */

let generated = {};
try {
  // Written by scripts/inject-config.js during `prebuild`. Gitignored, so it
  // never enters source control, but IS bundled into the packaged app.
  generated = require('./config.generated.js');
} catch (_) {
  // Not present (e.g. plain `npm start` without a prior build) — fall back to
  // the environment or an empty token. Never fatal.
}

module.exports = {
  GH_ISSUES_TOKEN: process.env.GH_ISSUES_TOKEN || generated.GH_ISSUES_TOKEN || '',
  GH_ISSUES_REPO: process.env.GH_ISSUES_REPO || generated.GH_ISSUES_REPO || 'PrimeUpYourLife/1132-Fixer-Windows'
};
