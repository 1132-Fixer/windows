'use strict';

/**
 * Code-signing configuration (scripts/signing-config.mjs) and its wiring.
 *
 * The rule under test: signing is all-or-nothing. No values = an unsigned
 * build, as before. All values = signing arguments. Some values = the build
 * fails. No secret value ever appears in an output.
 */

const fs = require('fs');
const path = require('path');

let failures = 0;
let checks = 0;
function check(cond, name) {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

const FULL = {
  AZURE_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  AZURE_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  AZURE_CLIENT_SECRET: 'fixture-only-not-a-credential',
  ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
  ARTIFACT_SIGNING_ACCOUNT: 'fixer-signing',
  ARTIFACT_SIGNING_PROFILE: 'fixer-public-trust',
  ARTIFACT_SIGNING_PUBLISHER: 'Example Publisher LLC'
};

(async () => {
  const { resolveSigning, toOutput, SECRET_NAMES, VARIABLE_NAMES } = await import('../scripts/signing-config.mjs');

  console.log('signing-config-smoke: not configured');
  {
    const r = resolveSigning({});
    check(r.configured === false && r.args.length === 0 && r.publisher === null, 'no values: unsigned build, no arguments');
    check(resolveSigning({ AZURE_TENANT_ID: '  ', ARTIFACT_SIGNING_ACCOUNT: '' }).configured === false, 'blank values count as absent');
    check(/^configured=false\n/.test(toOutput(r)), 'output says configured=false');
  }

  console.log('signing-config-smoke: fully configured');
  {
    const r = resolveSigning(FULL);
    check(r.configured === true && r.publisher === 'Example Publisher LLC', 'all values: configured, publisher carried');
    check(r.args.includes('-c.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net'), 'endpoint argument, trailing slash removed');
    check(r.args.includes('-c.win.azureSignOptions.codeSigningAccountName=fixer-signing'), 'account argument');
    check(r.args.includes('-c.win.azureSignOptions.certificateProfileName=fixer-public-trust'), 'profile argument');
    check(r.args.includes('-c.win.azureSignOptions.publisherName=Example Publisher LLC') &&
      r.args.includes('-c.win.signtoolOptions.publisherName=Example Publisher LLC'), 'the same publisher goes to the signer check and to the updater metadata');
    const out = toOutput(r) + JSON.stringify(r);
    for (const name of SECRET_NAMES) check(!out.includes(FULL[name]), `${name} value never appears in the output`);
    check(!r.args.some((a) => /verifyUpdateCodeSignature/.test(a)), 'signing does not turn on update signature verification');
  }

  console.log('signing-config-smoke: partly configured fails');
  for (const name of [...SECRET_NAMES, ...VARIABLE_NAMES]) {
    const env = Object.assign({}, FULL); delete env[name];
    let code = null; let message = '';
    try { resolveSigning(env); } catch (e) { code = e.code; message = e.message; }
    check(code === 'signing-partially-configured' && message.includes(name), `missing ${name}: build fails and names it`);
    check(!SECRET_NAMES.some((s) => env[s] && message.includes(env[s])), `missing ${name}: the error carries no secret value`);
  }

  console.log('signing-config-smoke: invalid values fail');
  const invalid = [
    ['ARTIFACT_SIGNING_ENDPOINT', 'http://eus.codesigning.azure.net', 'signing-endpoint-invalid', 'plain http endpoint'],
    ['ARTIFACT_SIGNING_ENDPOINT', 'https://eus.codesigning.azure.net.example.org', 'signing-endpoint-invalid', 'endpoint on another host'],
    ['ARTIFACT_SIGNING_ENDPOINT', 'https://eus.codesigning.azure.net/x -c.win.verifyUpdateCodeSignature=true', 'signing-endpoint-invalid', 'endpoint with an injected argument'],
    ['ARTIFACT_SIGNING_ACCOUNT', 'bad name', 'signing-account-invalid', 'account with a space'],
    ['ARTIFACT_SIGNING_PROFILE', 'p;rm', 'signing-profile-invalid', 'profile with a shell character'],
    ['ARTIFACT_SIGNING_PUBLISHER', 'Name"\n-c.x=y', 'signing-publisher-invalid', 'publisher with a quote and a line break'],
    ['ARTIFACT_SIGNING_PUBLISHER', 'A', 'signing-publisher-invalid', 'publisher too short']
  ];
  for (const [name, value, expected, label] of invalid) {
    let code = null;
    try { resolveSigning(Object.assign({}, FULL, { [name]: value })); } catch (e) { code = e.code; }
    check(code === expected, `${label}: ${expected}`);
  }

  console.log('signing-config-smoke: workflow and checks are wired');
  {
    const root = path.join(__dirname, '..');
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const state = fs.readFileSync(path.join(root, 'scripts/check-signature-state.mjs'), 'utf8');
    check(/id: signing\b/.test(ci) && /node scripts\/signing-config\.mjs/.test(ci), 'ci.yml resolves the signing configuration in a step with id "signing"');
    check(/github\.event_name != 'pull_request'/.test(ci.slice(ci.indexOf('id: signing') - 400, ci.indexOf('id: signing') + 1200)), 'pull request builds never receive signing secrets');
    for (const name of SECRET_NAMES) check(new RegExp(`${name}: \\$\\{\\{ .*secrets\\.${name}`).test(ci), `ci.yml reads ${name} from secrets`);
    for (const name of VARIABLE_NAMES) check(new RegExp(`${name}: \\$\\{\\{ .*vars\\.${name}`).test(ci), `ci.yml reads ${name} from variables`);
    check((ci.match(/SIGNING_ARGS/g) || []).length >= 4, 'both package builds receive the signing arguments');
    check(/ARTIFACT_SIGNING_CONFIGURED/.test(ci) && /ARTIFACT_SIGNING_CONFIGURED/.test(state), 'the signature check knows when signing was configured');
    check(/ARTIFACT_SIGNING_PUBLISHER/.test(state), 'the signature check compares the signer with the configured publisher');
    check(pkg.build.win.verifyUpdateCodeSignature === false, 'update signature verification stays off until one signed update is proven');
    check(pkg.build.win.azureSignOptions === undefined, 'package.json carries no signing account: a build without secrets stays unsigned');
    check(pkg.scripts['test:core'].includes('node tools/signing-config-smoke.js'), 'this test is part of npm run test:core');
  }

  if (failures) { console.error(`\nsigning-config-smoke: ${failures} of ${checks} FAILED`); process.exit(1); }
  console.log(`\nsigning-config-smoke: ${checks} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
