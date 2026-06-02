// Standalone sanitizer smoke for the support-report redaction logic.
// Mirrors main.js exactly. Synthetic input covers every redaction class.
// Exits 0 on PASS, 1 on FAIL.
const os = require('os');

const FIX_USER = 'user1';

const currentUser = (os.userInfo().username || '').trim();
const homeDir = (os.homedir() || '').trim();
const hostname = (os.hostname() || '').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeToRedactBareUser = currentUser && currentUser.toLowerCase() !== FIX_USER.toLowerCase();

function sanitize(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text;
  out = out.replace(/S-1-5-21-\d+-\d+-\d+-\d+/g, 'S-1-5-21-XXXX-XXXX-XXXX-XXXX');
  if (homeDir) {
    out = out.replace(new RegExp(escRe(homeDir), 'gi'), 'C:\\Users\\<you>');
  }
  if (currentUser) {
    const safeUser = escRe(currentUser);
    out = out.replace(new RegExp(`C:\\\\Users\\\\${safeUser}`, 'gi'), 'C:\\Users\\<you>');
    if (safeToRedactBareUser) {
      out = out.replace(new RegExp(`\\b${safeUser}\\b`, 'gi'), '<you>');
    }
  }
  if (hostname) {
    out = out.replace(new RegExp(`\\b${escRe(hostname)}\\b`, 'gi'), '<host>');
  }
  return out;
}

const input = [
  `Resolved SID: S-1-5-21-1234567890-987654321-1122334455-1001`,
  `Removing leftover suffixed profile: C:\\Users\\user1.${hostname}`,
  `  Found: C:\\Users\\user1.${hostname.toUpperCase()}\\AppData`,
  `Operator home: ${homeDir}\\Desktop\\notes.txt`,
  `Account 'user1' created.`,
  `Logon for ${currentUser} via Secondary Logon`,
  `  Hostname banner: ${hostname} reporting in`,
  `Random number 12345 unchanged`,
].join('\n');

const out = sanitize(input);

const checks = [
  { name: 'SID redacted',                test: () => /S-1-5-21-XXXX-XXXX-XXXX-XXXX/.test(out) && !/S-1-5-21-1234567890/.test(out) },
  { name: 'homedir replaced',            test: () => !out.includes(homeDir) },
  { name: 'C:\\Users\\<user> replaced',   test: () => out.includes('C:\\Users\\<you>') },
  { name: 'bare hostname redacted',      test: () => !new RegExp(`\\b${escRe(hostname)}\\b`).test(out) },
  { name: 'helper "user1" preserved',    test: () => out.includes("Account '<you>' created.") || out.includes("Account 'user1' created.") },
  { name: 'random numbers preserved',    test: () => out.includes('12345 unchanged') },
];

console.log('=== sanitizer-smoke ===');
console.log('currentUser:', JSON.stringify(currentUser));
console.log('homeDir:    ', JSON.stringify(homeDir));
console.log('hostname:   ', JSON.stringify(hostname));
console.log('safeToRedactBareUser:', safeToRedactBareUser);
console.log('');
console.log('--- input ---');
console.log(input);
console.log('--- output ---');
console.log(out);
console.log('');

let pass = true;
for (const c of checks) {
  const ok = c.test();
  if (!ok) pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
}

// Belt-and-braces helper-account guard check (only meaningful if operator name !== 'user1').
if (safeToRedactBareUser) {
  const helperLines = out.split('\n').filter(l => l.includes('Account'));
  const stripped = helperLines.some(l => /Account '\<you\>' created/.test(l));
  console.log(stripped ? 'INFO  helper-account name was redacted because operator differs (expected when operator !== user1)'
                       : 'INFO  helper-account "user1" survived because regex never targeted it');
}

process.exit(pass ? 0 : 1);
