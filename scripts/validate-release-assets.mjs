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
