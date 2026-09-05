#!/usr/bin/env node
// Validates that a tagged release on the release home (this repo's GitHub
// Releases) is fully wired for the electron-updater. Used both as a CI step
// (release.yml) and locally:
//   node scripts/validate-release-assets.mjs v5.3.4
//
// Exits non-zero with a single clear error line per check that fails.
//
// Env:
//   GITHUB_TOKEN or RELEASES_PAT — required to read release metadata
//                                  (public releases work unauthenticated but
//                                  rate limits are tight; CI sets GITHUB_TOKEN)
//   RELEASES_OWNER — defaults to 1132-Fixer
//   RELEASES_REPO  — defaults to windows
//
// The defaults used to name PrimeUpYourLife/1132-Fixer-Windows, which is this
// repository's former name. That resolved only because GitHub 301-redirects a
// renamed repository, so the release gate was validating a redirect rather than
// a named target. A redirect can stop being the right answer the moment
// something else is created at the old name, and the failure would be silent:
// the release would validate against a repository nobody intended.

const OWNER = process.env.RELEASES_OWNER || '1132-Fixer';
const REPO  = process.env.RELEASES_REPO  || 'windows';
const TOKEN = process.env.RELEASES_PAT || process.env.GITHUB_TOKEN || '';

const tag = process.argv[2] || process.env.RELEASE_TAG || '';
if (!tag) {
  console.error('Usage: validate-release-assets.mjs <tag>');
  console.error('       (or set RELEASE_TAG env var)');
  process.exit(2);
}

const errors = [];
const fail = (msg) => { errors.push(msg); console.error(`FAIL: ${msg}`); };
const ok   = (msg) => console.log(`OK:   ${msg}`);

function authHeaders(accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': '1132-fixer-release-validator' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: authHeaders('application/octet-stream') });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// Minimal YAML extractor for the fields electron-updater writes into latest*.yml.
// Pulls every top-level `path:` and every nested `url:` value. Quoted or bare.
function extractReferencedFiles(yamlText) {
  const out = new Set();
  const re = /^\s*(?:- )?(?:path|url):\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(yamlText)) !== null) {
    let v = m[1].trim();
    v = v.replace(/^['"]/, '').replace(/['"]$/, '');
    if (v) out.add(v);
  }
  return [...out];
}

// The published latest.yml is what every installed client trusts. Check it
// the way the client does (src/main/updater.js): version equals the tag,
// the installer path follows the artifact name, the recorded size equals
// the attached asset's size, the recorded SHA-512 equals the hash of the
// bytes GitHub serves, and the isAdminRightsRequired flag is absent (the
// package ships no elevate.exe; with the flag, 6.3.1–6.3.3 clients fail to
// install — scripts/finalize-update-metadata.mjs strips it before upload).
async function validateUpdaterMetadata(yaml, assetByName) {
  const version = (/^version:\s*['"]?([^'"\s]+)/m.exec(yaml) || [])[1] || '';
  const filePath = (/^path:\s*['"]?([^'"\s]+)/m.exec(yaml) || [])[1] || '';
  const sha512 = (/^sha512:\s*(\S+)/m.exec(yaml) || [])[1] || '';
  const size = Number((/^\s+size:\s*(\d+)/m.exec(yaml) || [])[1] || 0);
  const expected = tag.replace(/^v/, '');
  if (version === expected) ok(`latest.yml version ${version} matches tag ${tag}`);
  else fail(`latest.yml version "${version}" does not match tag ${tag}`);
  if (filePath === `1132-Fixer-Setup-${version}.exe`) ok(`latest.yml path is ${filePath}`);
  else fail(`latest.yml path "${filePath}" is not 1132-Fixer-Setup-${version}.exe`);
  if (/^\s*isAdminRightsRequired:\s*true/m.test(yaml)) fail('latest.yml still carries isAdminRightsRequired: true (finalize-update-metadata.mjs did not run)');
  else ok('latest.yml has no isAdminRightsRequired flag');
  const asset = assetByName.get(filePath);
  if (!asset) return; // already reported above
  if (asset.size === size) ok(`latest.yml size ${size} matches the uploaded installer`);
  else fail(`latest.yml size ${size} != uploaded asset size ${asset.size}`);
  try {
    const res = await fetch(asset.url, { headers: authHeaders('application/octet-stream') });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const { createHash } = await import('node:crypto');
    const h = createHash('sha512');
    let bytes = 0;
    for await (const chunk of res.body) { h.update(chunk); bytes += chunk.length; }
    const digest = h.digest('base64');
    if (digest === sha512 && bytes === size) ok(`uploaded ${filePath} hashes to the SHA-512 in latest.yml (${bytes} bytes)`);
    else fail(`uploaded ${filePath} does not match latest.yml (sha512 ${digest === sha512 ? 'ok' : 'differs'}, ${bytes} bytes vs ${size})`);
  } catch (e) {
    fail(`Could not download ${filePath} to verify its SHA-512: ${e.message}`);
  }
}

(async () => {
  console.log(`Validating ${OWNER}/${REPO} @ ${tag}`);

  let release;
  try {
    release = await fetchJson(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`
    );
  } catch (e) {
    fail(`Release lookup failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (release.draft) fail(`Release ${tag} is still a draft`);
  else ok(`Release ${tag} is published (not a draft)`);

  const assetByName = new Map(release.assets.map(a => [a.name, a]));
  const assetNames  = [...assetByName.keys()];

  // Required asset set: at least one Setup .exe, one Portable .exe, and latest.yml.
  // latest-mac.yml only required if the release shipped any mac artifact.
  const hasSetup    = assetNames.some(n => /setup/i.test(n) && n.endsWith('.exe'));
  const hasPortable = assetNames.some(n => /portable/i.test(n) && n.endsWith('.exe'));
  const hasLatest   = assetByName.has('latest.yml');
  const shippedMac  = assetNames.some(n => /\.dmg$|mac|darwin/i.test(n));
  const hasLatestMac = assetByName.has('latest-mac.yml');

  hasSetup    ? ok('Installer .exe present')    : fail('Missing installer (*Setup*.exe)');
  hasPortable ? ok('Portable .exe present')     : fail('Missing portable (*Portable*.exe)');
  hasLatest   ? ok('latest.yml present')        : fail('Missing latest.yml');
  if (shippedMac) {
    hasLatestMac ? ok('latest-mac.yml present (mac assets shipped)')
                 : fail('mac artifact present but latest-mac.yml missing');
  } else {
    ok('No mac assets — latest-mac.yml not required');
  }

  // Pull every YAML referenced filename and confirm a matching asset exists.
  for (const ymlName of ['latest.yml', 'latest-mac.yml']) {
    const a = assetByName.get(ymlName);
    if (!a) continue;
    let yaml;
    try {
      yaml = await fetchText(a.url);
    } catch (e) {
      fail(`Could not download ${ymlName}: ${e.message}`);
      continue;
    }
    const referenced = extractReferencedFiles(yaml);
    for (const ref of referenced) {
      if (assetByName.has(ref)) ok(`${ymlName} -> ${ref} resolves to a release asset`);
      else fail(`${ymlName} references "${ref}" but no such asset is attached to ${tag}`);
    }
    if (ymlName === 'latest.yml') await validateUpdaterMetadata(yaml, assetByName);
  }

  // checksums-sha256.txt must be usable as published: coreutils format
  // ("<64 hex>  <name>", LF line endings, no BOM) and one line per shipped
  // .exe, each naming an attached asset. A CRLF file (6.3.3 and earlier)
  // fails `sha256sum -c` on every line because the filename carries a \r.
  {
    const a = assetByName.get('checksums-sha256.txt');
    if (!a) {
      fail('Missing checksums-sha256.txt');
    } else {
      let text = '';
      try { text = await fetchText(a.url); } catch (e) { fail(`Could not download checksums-sha256.txt: ${e.message}`); }
      if (text) {
        if (text.charCodeAt(0) === 0xFEFF) fail('checksums-sha256.txt starts with a UTF-8 BOM');
        else ok('checksums-sha256.txt has no BOM');
        if (text.includes('\r')) fail('checksums-sha256.txt uses CRLF line endings (sha256sum -c cannot read it)');
        else ok('checksums-sha256.txt uses LF line endings');
        if (!text.endsWith('\n')) fail('checksums-sha256.txt does not end with a newline');
        const lines = text.split('\n').filter(Boolean);
        const named = new Set();
        for (const line of lines) {
          const m = /^([0-9a-f]{64})  (\S.*)$/.exec(line);
          if (!m) { fail(`checksums-sha256.txt line is not "<sha256>  <name>": ${JSON.stringify(line)}`); continue; }
          named.add(m[2]);
          if (assetByName.has(m[2])) ok(`checksums-sha256.txt -> ${m[2]} resolves to a release asset`);
          else fail(`checksums-sha256.txt names "${m[2]}" but no such asset is attached to ${tag}`);
        }
        for (const name of assetByName.keys()) {
          if (name.endsWith('.exe') && !named.has(name)) fail(`checksums-sha256.txt has no line for ${name}`);
        }
      }
    }
  }

  if (errors.length) {
    console.error(`\n${errors.length} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll release/updater checks passed.');
})().catch(e => {
  console.error(`Unhandled: ${e.stack || e.message}`);
  process.exitCode = 1;
});
