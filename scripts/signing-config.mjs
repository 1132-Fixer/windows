#!/usr/bin/env node
/**
 * Resolves the code-signing configuration for a build.
 *
 * Signing uses Microsoft Artifact Signing (formerly Trusted Signing) through
 * electron-builder's `win.azureSignOptions`. It is off unless EVERY value
 * below is present. With none present the build is unsigned, exactly as
 * before. With only some present the build fails: a half-configured signing
 * setup must never produce an unsigned build that looks intentional.
 *
 * Secrets (never printed, never written to an output):
 *   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 * Repository variables (not secret):
 *   ARTIFACT_SIGNING_ENDPOINT   https://<region>.codesigning.azure.net
 *   ARTIFACT_SIGNING_ACCOUNT    Artifact Signing account name
 *   ARTIFACT_SIGNING_PROFILE    certificate profile name (Public Trust)
 *   ARTIFACT_SIGNING_PUBLISHER  exact subject CN of the issued certificate
 *
 * Output (GITHUB_OUTPUT): configured=true|false, args=<electron-builder CLI
 * overrides>, publisher=<CN>. The overrides carry names only.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SECRET_NAMES = Object.freeze(['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']);
export const VARIABLE_NAMES = Object.freeze([
  'ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE', 'ARTIFACT_SIGNING_PUBLISHER'
]);

const ENDPOINT_RE = /^https:\/\/[a-z0-9]{2,12}\.codesigning\.azure\.net\/?$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,62}[A-Za-z0-9]$/;
// A certificate subject CN: printable, no quotes, no shell or YAML control.
const PUBLISHER_RE = /^[A-Za-z0-9][A-Za-z0-9 .,&()'’\-]{1,126}[A-Za-z0-9.)]$/;

function fail(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

export function resolveSigning(env = process.env) {
  const value = (name) => (typeof env[name] === 'string' ? env[name].trim() : '');
  const all = [...SECRET_NAMES, ...VARIABLE_NAMES];
  const present = all.filter((name) => value(name));
  if (present.length === 0) {
    return { configured: false, args: [], publisher: null, missing: [] };
  }
  const missing = all.filter((name) => !value(name));
  if (missing.length) fail('signing-partially-configured', `missing: ${missing.join(', ')}`);

  const endpoint = value('ARTIFACT_SIGNING_ENDPOINT').replace(/\/$/, '');
  const account = value('ARTIFACT_SIGNING_ACCOUNT');
  const profile = value('ARTIFACT_SIGNING_PROFILE');
  const publisher = value('ARTIFACT_SIGNING_PUBLISHER');
  if (!ENDPOINT_RE.test(`${endpoint}/`) && !ENDPOINT_RE.test(endpoint)) fail('signing-endpoint-invalid');
  if (!NAME_RE.test(account)) fail('signing-account-invalid');
  if (!NAME_RE.test(profile)) fail('signing-profile-invalid');
  if (!PUBLISHER_RE.test(publisher)) fail('signing-publisher-invalid');

  // electron-updater compares the signer CN with publisherName, so the same
  // value goes to both places. signtoolOptions.publisherName is what
  // app-update.yml carries.
  const args = [
    `-c.win.azureSignOptions.endpoint=${endpoint}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${account}`,
    `-c.win.azureSignOptions.certificateProfileName=${profile}`,
    `-c.win.azureSignOptions.publisherName=${publisher}`,
    `-c.win.signtoolOptions.publisherName=${publisher}`
  ];
  return { configured: true, args, publisher, missing: [] };
}

// One argument per line; the workflow passes them to electron-builder as an
// array, so a publisher name with spaces stays one argument.
export function toOutput(result) {
  return [
    `configured=${result.configured ? 'true' : 'false'}`,
    `publisher=${result.publisher || ''}`,
    'args<<SIGNING_ARGS_EOF',
    ...result.args,
    'SIGNING_ARGS_EOF'
  ].join('\n') + '\n';
}

function main() {
  let result;
  try {
    result = resolveSigning(process.env);
  } catch (error) {
    console.error(`[signing-config] FAIL ${error.code || 'error'}${error.message && error.message !== error.code ? ` (${error.message})` : ''}`);
    process.exit(1);
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, toOutput(result));
  console.log(result.configured
    ? `[signing-config] signing configured: account, profile and endpoint present; publisher "${result.publisher}"`
    : '[signing-config] signing not configured: this build is UNSIGNED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
