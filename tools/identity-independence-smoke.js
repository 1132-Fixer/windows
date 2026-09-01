'use strict';

/**
 * Product identity, framework, and independence-disclosure guards.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const messages = require('../messages.js');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'compact-shell.js'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

const SHORT = 'Independent project. Not affiliated with Zoom.';
const LEGAL = 'Independent project. Not affiliated with, sponsored by, or endorsed by Zoom Communications, Inc.';

console.log('identity-independence-smoke: product and framework');
check(pkg.name === '1132-fixer', 'npm package name remains 1132-fixer');
check(pkg.build && pkg.build.productName === '1132 Fixer', 'productName remains 1132 Fixer');
check(pkg.build && pkg.build.appId === 'com.hightexas.1132fixer', 'appId unchanged');
check(pkg.build && pkg.build.productName === '1132 Fixer', 'build productName remains 1132 Fixer');
check(!!pkg.devDependencies && !!pkg.devDependencies.electron, 'Electron remains the application framework');
check(main.includes('require(\'electron\')'), 'main process is Electron');
check(fs.existsSync(path.join(ROOT, 'preload.js')), 'Electron preload layer remains');
check(!fs.existsSync(path.join(ROOT, 'SignPath.json')), 'no SignPath project file');
check(!/signpath/i.test(JSON.stringify(pkg)), 'package.json does not configure SignPath');

console.log('identity-independence-smoke: independence copy');
check(messages.DISCLOSURE.INDEPENDENCE === SHORT, 'main-UI independence statement is exact');
check(messages.DISCLOSURE.LEGAL === LEGAL, 'About/legal independence statement is exact');
check(html.includes('id="projectDisclosure"'), 'footer disclosure node exists');
check(renderer.includes('renderDisclosure(document.getElementById(\'projectDisclosure\'))'),
  'renderer fills the footer disclosure');
check(shell.includes("aboutBtn.textContent = 'About'") && renderer.includes('DISCLOSURE.LEGAL'),
  'independence disclosure remains available from About');
check(readme.includes(LEGAL), 'README contains the complete independence statement');
check(fs.existsSync(path.join(ROOT, 'docs', 'README.md')), 'docs index exists');
check(fs.existsSync(path.join(ROOT, 'docs', 'security', 'threat-model.md')), 'threat model exists');
check(fs.existsSync(path.join(ROOT, 'docs', 'security', 'helper-account.md')), 'helper-account note exists');
check(fs.existsSync(path.join(ROOT, 'docs', 'history', 'release-migration-2026-08.md')),
  'release-migration history doc remains');
check(fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8').includes(LEGAL),
  'docs index carries the complete independence statement');
check(html.includes('id="aboutOverlay"') && renderer.includes('DISCLOSURE.LEGAL'),
  'About dialog carries the complete legal statement');

console.log('identity-independence-smoke: prohibited claims');
const publicText = [
  messages.DISCLOSURE.INDEPENDENCE,
  messages.DISCLOSURE.LEGAL,
  messages.DISCLOSURE.DESCRIPTION,
  messages.WIZARD.READY_TITLE,
  messages.WIZARD.READY_SUB,
  readme,
  changelog
].join('\n');
for (const banned of [
  'Official Zoom', 'Zoom-approved', 'Zoom partner', 'Certified for Zoom',
  'Verified by Zoom', 'endorsed by Zoom', 'hacking tool', 'ban-evasion',
  'authentication bypass', 'device-identity changer'
]) {
      const haystack = banned === 'endorsed by Zoom'
      ? publicText.split(LEGAL).join('')
      : publicText;
    check(!haystack.toLowerCase().includes(banned.toLowerCase()), `public copy never says "${banned}"`);
}
check(!/Everything looks good/.test(messages.WIZARD.READY_TITLE), 'ready title is not a false health claim');
check(!readme.toLowerCase().includes('no longer blocks you'), 'README does not describe ban evasion');

console.log('identity-independence-smoke: Zoom is not bundled');
check(!pkg.build.files.some(f => /zoom\.exe|zoominstaller/i.test(f)), 'package files glob does not ship Zoom');
check(messages.DISCLOSURE.ZOOM_OBTAIN.includes('does not download, bundle, modify, or redistribute Zoom Workplace'),
  'obtain-separately wording is present');

if (failures) {
  console.error(`identity-independence-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('identity-independence-smoke: all checks passed');
