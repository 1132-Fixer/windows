/**
 * 1132 Fixer - Build Configuration
 * Tokens and settings bundled into the app at build time.
 *
 * GH_ISSUES_TOKEN: Fine-grained PAT with Issues:write on the repo.
 *   Create at: https://github.com/settings/personal-access-tokens/new
 *   Scope: PrimeUpYourLife/1132-Fixer-Windows
 *   Permission: Issues → Read and write
 */

module.exports = {
  GH_ISSUES_TOKEN: process.env.GH_ISSUES_TOKEN || ''
};
