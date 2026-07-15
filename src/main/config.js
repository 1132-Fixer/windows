/**
 * 1132 Fixer - Build Configuration (secret-free)
 *
 * The GitHub feedback token is NEVER hardcoded in this file.
 *
 * This repo is private, so a token committed here is not exposed via git —
 * but that is NOT why it's unsafe. This file is bundled into the packaged app
 * (it is not excluded by the "files" globs in package.json), and the app ships
 * as a PUBLIC installer. Anything hardcoded here lands in app.asar inside that
 * installer, where asar stores file contents uncompressed. Extracting it takes
 * about a minute:
 *
 *     7za x 1132-Fixer-Portable-X.Y.Z.exe -oext
 *     grep -a "GH_ISSUES_TOKEN" ext/resources/app.asar
 *
 * That is exactly how the previously hardcoded token leaked out of v5.3.10.
 *
 * NOTE: build-time injection keeps the secret out of source control, but it
 * does NOT make it secret — the token is still inside the shipped .exe and
 * extractable by the command above. It is only tolerable because the token is
 * scoped to Issues:write on one repo (worst case: issue spam). If it ever needs
 * to be genuinely secret, route feedback through a server-side proxy instead.
 *
 * The token is supplied at build/run time from one of, in priority order:
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
