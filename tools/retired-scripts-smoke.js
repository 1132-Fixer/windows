'use strict';

/**
 * Tool-script disposition (issue 229, docs/security/tool-scripts-disposition.md).
 *
 * 1. Scripts that changed a computer and recorded no way back are retired:
 *    they must not come back under the same path.
 * 2. A release ships exactly the two reviewed scripts.
 * 3. Neither shipped script writes outside the helper account: no machine
 *    hive write, no service change, no file or registry delete.
 * 4. Every PowerShell script that stays in scripts/ or tools/ and is not
 *    shipped is read-only.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failures = 0;
let checks = 0;
function check(cond, name) {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

const RETIRED = [
  'tools/merge-user1-profiles.ps1',
  'tools/repoint-profilelist.ps1',
  'scripts/Zoom-Toolkit.ps1',
  'scripts/RUN_01_AllCleanup_Only.cmd',
  'scripts/RUN_02_AllCleanup_And_Reinstall.cmd',
  'scripts/RUN_03_DryRun_WhatIf.cmd',
  'scripts/README.txt',
  'scripts/Zoom Persistence Toolkit/Zoom-Hardened-Install.ps1',
  'scripts/Zoom Persistence Toolkit/RUN_04_Hardened_Install.cmd',
  'scripts/Zoom Persistence Toolkit/Install-MonitorTask.ps1',
  'scripts/Zoom Persistence Toolkit/RUN_05_Install_Monitor_Task.cmd'
];
const SHIPPED = ['scripts/zoom-firstrun-setup.ps1', 'scripts/grant-media-consent.ps1'];

console.log('retired-scripts-smoke: retired scripts stay retired');
for (const rel of RETIRED) check(!exists(rel), `${rel} is not in the tree`);

console.log('retired-scripts-smoke: a release ships exactly the two reviewed scripts');
{
  const pkg = JSON.parse(read('package.json'));
  const shipped = (pkg.build.extraResources || []).map((r) => r.from).filter((f) => /\.(ps1|cmd|bat|vbs|js)$/i.test(f)).sort();
  check(JSON.stringify(shipped) === JSON.stringify(SHIPPED.slice().sort()), `extraResources scripts are exactly: ${SHIPPED.join(', ')}`);
  check((pkg.build.files || []).includes('!scripts/**') && (pkg.build.files || []).includes('!tools/**'), 'scripts/ and tools/ are excluded from the app package');
}

// Statements that change a computer. Comments are stripped first.
const stripComments = (src) => src.replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
const MACHINE_WRITE = [
  [/\b(Set|New|Remove|Clear|Rename)-Item(Property)?\b[^\n]*\bHKLM:/i, 'writes to HKLM'],
  [/\b(New|Set|Remove)-Item(Property)?\b[^\n]*Registry::HKEY_LOCAL_MACHINE/i, 'writes to HKEY_LOCAL_MACHINE'],
  [/\breg(\.exe)?\s+(add|delete|import|load|unload|restore)\b/i, 'runs reg.exe to change or load a hive'],
  [/\b(Set|Stop|Start|Restart|New|Remove)-Service\b/i, 'changes a service'],
  [/\bsc(\.exe)?\s+(config|start|stop|delete|create)\b/i, 'runs sc.exe to change a service'],
  [/\bRegister-ScheduledTask\b|\bschtasks(\.exe)?\s+\/create\b/i, 'registers a scheduled task'],
  [/\b(New|Remove|Set|Disable|Enable)-LocalUser\b|\bnet(\.exe)?\s+(user|localgroup)\b[^\n]*\/(add|delete)/i, 'changes a local account'],
  [/\bmsiexec(\.exe)?\b/i, 'runs an installer'],
  [/\bRemove-Item\b/i, 'deletes files or keys'],
  // Command position only: a tool name inside a list of names to look up is
  // not a call.
  [/(?:^|[;|&{(])\s*(?:&\s*)?(icacls|takeown)(\.exe)?\b/im, 'changes ownership or permissions']
];

console.log('retired-scripts-smoke: shipped scripts write only inside the helper account');
for (const rel of SHIPPED) {
  const code = stripComments(read(rel));
  for (const [re, what] of MACHINE_WRITE) check(!re.test(code), `${rel}: never ${what}`);
}
{
  const grant = stripComments(read('scripts/grant-media-consent.ps1'));
  const writes = grant.split('\n').filter((l) => /\b(New-Item|New-ItemProperty|Set-ItemProperty)\b/.test(l));
  check(writes.length > 0 && writes.every((l) => /\$key\b/.test(l)), 'grant-media-consent: every registry write targets $key');
  const keyAssignments = grant.split('\n').filter((l) => /\$key\s*=/.test(l));
  check(keyAssignments.length > 0 && keyAssignments.every((l) => /'Registry::HKEY_USERS\\' \+ \$Sid \+/.test(l)),
    'grant-media-consent: $key is always under HKEY_USERS\\<helper SID>');
  check(/Assert-FixerMediaIdentity/.test(grant), 'grant-media-consent: identity is re-proved before a write');
}

console.log('retired-scripts-smoke: unshipped PowerShell scripts that remain are read-only');
{
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : [rel];
  });
  const remaining = walk('scripts').concat(walk('tools')).filter((f) => /\.ps1$/i.test(f) && !SHIPPED.includes(f));
  check(remaining.length > 0, `${remaining.length} unshipped PowerShell scripts found to check`);
  for (const rel of remaining) {
    const code = stripComments(read(rel));
    const hit = MACHINE_WRITE.find(([re]) => re.test(code));
    check(!hit, `${rel}: read-only${hit ? ` (found: ${hit[1]})` : ''}`);
  }
}

console.log('retired-scripts-smoke: the disposition record exists');
{
  const doc = read('docs/security/tool-scripts-disposition.md');
  for (const rel of RETIRED.filter((f) => /\.ps1$/.test(f))) check(doc.includes(path.posix.basename(rel)), `record names ${path.posix.basename(rel)}`);
  check(/bypass list of both default-branch rulesets stays empty/.test(doc), 'record states the bypass decision');
}

if (failures) { console.error(`\nretired-scripts-smoke: ${failures} of ${checks} FAILED`); process.exit(1); }
console.log(`\nretired-scripts-smoke: ${checks} checks passed`);
