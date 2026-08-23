// Smoke test for the Windows updater channel.
// package.json.version is the single source of truth. The live
// 1132-Fixer/windows latest.yml must report that same version.
// HTTPS + SHA-512 integrity + isAllowedUpdaterUrl (from #156) are proven
// on the same fetch the portable notice uses. Does not publish a release.
// Does not flip verifyUpdateCodeSignature.
//
// Three live channels exist and this test treats each differently:
//
//   1. 1132-Fixer/windows GitHub Releases — what `build.publish` on main
//      targets. Fetched through the allowlist and asserted hard.
//   2. botify-network.com/downloads/1132-fixer/updates — the generic broker
//      baked into the shipped v5.6.0 binaries (`build.publish` at tag v5.6.0
//      is the generic provider, not GitHub), so it is the feed every install
//      in the field actually polls. It is deliberately NOT on
//      isAllowedUpdaterUrl's allowlist and main.js must never bake it in;
//      both of those are asserted below. This test reaches it directly to
//      prove the two live channels do not diverge.
//   3. PrimeUpYourLife/1132-Fixer-Windows-Releases — residual <=5.5.1
//      clients. Not the current channel and must not be deleted.
//
// The old channel is read via the GitHub REST release object ONLY. This test
// used to GET its latest.yml asset on every `npm test`, hence on every CI run,
// which inflated that asset's download_count — the exact number the
// deletion gate for that repository reads. Reading the release object returns
// the same metadata and increments nothing. Never point an asset GET at a feed
// whose download_count is a decision input.
//
// Exit 0 PASS / 1 FAIL.

'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const es = require('../src/main/electron-security');

const ROOT = path.join(__dirname, '..');
const CURRENT_OWNER = '1132-Fixer';
const CURRENT_REPO = 'windows';
const CURRENT_FEED = `https://github.com/${CURRENT_OWNER}/${CURRENT_REPO}/releases/latest/download/latest.yml`;
const OLD_OWNER = 'PrimeUpYourLife';
const OLD_REPO = '1132-Fixer-Windows-Releases';
// The single pinned transition release on the legacy feed. <=5.5.1 clients take
// exactly this one release, then move to the current channel. It must stay
// available and unchanged; future releases are NOT mirrored to the legacy feed.
const TRANSITION_VERSION = '6.0.0';
// Kept as a string for the allowlist-rejection assertions below. It is never
// fetched — see the header note on download_count contamination.
const OLD_FEED = `https://github.com/${OLD_OWNER}/${OLD_REPO}/releases/latest/download/latest.yml`;
const BROKER_FEED = 'https://botify-network.com/downloads/1132-fixer/updates/latest.yml';
const USER_AGENT = '1132Fixer-updater-channel-smoke';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}

function parseLatestYml(text) {
  const version = /^version:\s*(\S+)/m.exec(text);
  const sha512 = /^sha512:\s*(\S+)/m.exec(text);
  const filePath = /^path:\s*(\S+)/m.exec(text);
  const size = /^\s+size:\s*(\d+)/m.exec(text);
  return {
    version: version ? version[1].replace(/^['"]|['"]$/g, '') : '',
    sha512: sha512 ? sha512[1] : '',
    path: filePath ? filePath[1].replace(/^['"]|['"]$/g, '') : '',
    size: size ? Number(size[1]) : 0,
  };
}

function httpsGetTextAllowed(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!es.isAllowedUpdaterUrl(url)) {
      return reject(new Error(`updater URL not allowed: ${url}`));
    }
    if (!String(url).startsWith('https://')) {
      return reject(new Error(`not https: ${url}`));
    }
    const req = https.get(url, {
      headers: { 'User-Agent': `${USER_AGENT}/${pkg.version}` },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        if (!es.isAllowedUpdaterUrl(next)) {
          return reject(new Error(`updater redirect not allowed: ${next}`));
        }
        return resolve(httpsGetTextAllowed(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// No allowlist. Used only for the broker, which is intentionally off the app's
// updater allowlist (the app must never poll it) but is still the feed the
// shipped binaries use, so this test has to be able to read it.
function httpsGetTextRaw(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!String(url).startsWith('https://')) {
      return reject(new Error(`not https: ${url}`));
    }
    const req = https.get(url, {
      headers: { 'User-Agent': `${USER_AGENT}/${pkg.version}` },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpsGetTextRaw(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function githubJson(url) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function assetCount(release, name) {
  const a = (release.assets || []).find((x) => x.name === name);
  return a ? a.download_count : null;
}

console.log('updater-channel-smoke: source of truth');
{
  check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version is semver (${pkg.version})`);
  check(lock.version === pkg.version, `package-lock.json version matches package.json (${lock.version})`);
  check(lock.packages && lock.packages[''] && lock.packages[''].version === pkg.version, 'package-lock packages[""].version matches package.json');
  check(pkg.build && pkg.build.publish && pkg.build.publish.provider === 'github', 'build.publish provider is github');
  check(pkg.build.publish.owner === CURRENT_OWNER, `build.publish owner is ${CURRENT_OWNER}`);
  check(pkg.build.publish.repo === CURRENT_REPO, `build.publish repo is ${CURRENT_REPO}`);
  check(pkg.build.win && pkg.build.win.verifyUpdateCodeSignature === false, 'verifyUpdateCodeSignature stays false (unsigned)');
  check(mainSrc.includes(`const LATEST_YML_URL = '${CURRENT_FEED}'`), 'portable LATEST_YML_URL is 1132-Fixer/windows latest.yml');
  check(mainSrc.includes(`const RELEASES_LATEST_URL = 'https://github.com/${CURRENT_OWNER}/${CURRENT_REPO}/releases/latest'`), 'releases page is 1132-Fixer/windows');
  check(!/autoUpdater\.setFeedURL/.test(mainSrc), 'autoUpdater.setFeedURL is never called');
  check(!mainSrc.includes('botify-network.com/downloads/1132-fixer'), 'source does not bake the generic broker URL');
  check(!mainSrc.includes(`const LATEST_YML_URL = '${OLD_FEED}'`), 'LATEST_YML_URL is not the old-channel feed');
}

console.log('updater-channel-smoke: HTTPS + isAllowedUpdaterUrl');
{
  check(CURRENT_FEED.startsWith('https://'), 'current feed is https');
  check(es.isAllowedUpdaterUrl(CURRENT_FEED), 'canonical latest.yml allowed');
  check(es.isAllowedUpdaterUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.yml'), 'GitHub release CDN allowed');
  check(!es.isAllowedUpdaterUrl(OLD_FEED), 'old-channel GitHub path rejected');
  check(!es.isAllowedUpdaterUrl(`https://github.com/${OLD_OWNER}/${OLD_REPO}/releases/latest/download/latest.yml`), 'PrimeUpYourLife Windows-Releases rejected');
  check(!es.isAllowedUpdaterUrl('https://botify-network.com/downloads/1132-fixer/updates'), 'generic broker host rejected');
  check(!es.isAllowedUpdaterUrl('http://github.com/1132-Fixer/windows/releases/latest/download/latest.yml'), 'http updater URL rejected');
  check(!es.isAllowedUpdaterUrl('https://evil.example/latest.yml'), 'arbitrary https host rejected');
  check(!es.isAllowedUpdaterUrl('https://github.com/evil/repo/releases/latest/download/latest.yml'), 'other GitHub repo rejected');
  check(mainSrc.includes('isAllowedUpdaterUrl'), 'httpsGetText consults isAllowedUpdaterUrl');
}

// Semver compare: -1 if a<b, 0 if equal, 1 if a>b. Numeric core only
// (x.y.z); a pre-release suffix sorts below its release. Enough for the
// release-ordering tolerance below.
function semverCmp(a, b) {
  const core = (v) => String(v || '0.0.0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [a0, a1, a2] = core(a);
  const [b0, b1, b2] = core(b);
  if (a0 !== b0) return a0 < b0 ? -1 : 1;
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  const aPre = String(a).includes('-'); const bPre = String(b).includes('-');
  if (aPre !== bPre) return aPre ? -1 : 1;
  return 0;
}

function assetPresent(release, name) {
  return !!(release.assets || []).find((x) => x.name === name);
}

(async () => {
  console.log('updater-channel-smoke: live current channel latest.yml');
  let yml;
  try {
    yml = await httpsGetTextAllowed(CURRENT_FEED);
  } catch (err) {
    check(false, `current-channel fetch: ${(err && err.message) || err}`);
    yml = '';
  }
  const meta = parseLatestYml(yml);
  check(!!yml && yml.includes('version:'), 'current latest.yml downloaded over https via allowlist');

  // Release-ordering tolerance. package.json is bumped before the tag is
  // pushed, so between the bump landing on main and release.yml publishing the
  // GitHub Release there is a window where the live latest.yml is one release
  // BEHIND package.json. That window is expected, not drift. Treat it as:
  //   feed == source  -> published; assert the version/path invariants strictly
  //   feed <  source   -> release pending; PASS, but assert the feed is still
  //                       internally consistent (path matches its OWN version)
  //   feed >  source   -> feed ahead of source; hard failure (real drift)
  // This is what keeps `main` green during a bump instead of red until publish.
  const cmp = semverCmp(meta.version, pkg.version);
  if (cmp === 0) {
    check(true, `latest.yml version ${meta.version} matches package.json ${pkg.version} (published)`);
    check(meta.path === `1132-Fixer-Setup-${pkg.version}.exe`, `latest.yml path is 1132-Fixer-Setup-${pkg.version}.exe`);
  } else if (cmp < 0) {
    console.log(`  note release pending: live latest.yml is ${meta.version}, package.json is ${pkg.version} — v${pkg.version} not published yet (tolerated)`);
    check(true, `release pending: feed ${meta.version} is behind source ${pkg.version} (expected during a version bump)`);
    check(meta.path === `1132-Fixer-Setup-${meta.version}.exe`, `pending: latest.yml path matches its own version (1132-Fixer-Setup-${meta.version}.exe)`);
  } else {
    check(false, `latest.yml version ${meta.version} is AHEAD of package.json ${pkg.version} — feed/source drift`);
  }
  check(/^[A-Za-z0-9+/]+={0,2}$/.test(meta.sha512) && meta.sha512.length >= 64, 'latest.yml carries installer SHA-512 (integrity)');
  check(meta.size > 0, `latest.yml size is present (${meta.size || 0})`);

  let currentCounts = { latestYml: null, tag: null };
  try {
    const rel = await githubJson(`https://api.github.com/repos/${CURRENT_OWNER}/${CURRENT_REPO}/releases/latest`);
    currentCounts.tag = rel.tag_name;
    currentCounts.latestYml = assetCount(rel, 'latest.yml');
    // Same release-ordering tolerance as latest.yml: the tag may lag the bump
    // until release.yml runs. Never-ahead is the invariant; equal is published.
    check(semverCmp((rel.tag_name || '').replace(/^v/, ''), pkg.version) <= 0, `GitHub latest tag ${rel.tag_name} is not ahead of package.json v${pkg.version}`);
    console.log(`  note current-channel latest.yml download_count=${currentCounts.latestYml} tag=${currentCounts.tag}`);
  } catch (err) {
    console.log(`  note current-channel GitHub API skipped: ${(err && err.message) || err}`);
  }

  // Legacy compatibility bridge (channel 3). v5.5.1-and-earlier clients have
  // PrimeUpYourLife/1132-Fixer-Windows-Releases baked in and can reach nothing
  // else. The bridge policy (docs/RELEASE-MIGRATION-2026-08.md) requires that
  // feed keep SERVING so those clients auto-migrate — it must not be deleted,
  // emptied, or archived into unusability while a supported client still polls
  // it. This asserts the feed still answers with a release that carries the
  // metadata + installer an old electron-updater needs to discover an update.
  // Read via the REST release object ONLY (never GET the latest.yml asset) so
  // this test does not inflate the download_count that gates retirement.
  console.log('updater-channel-smoke: legacy compatibility bridge (<=5.5.1 clients poll this)');
  try {
    const oldRel = await githubJson(`https://api.github.com/repos/${OLD_OWNER}/${OLD_REPO}/releases/latest`);
    const oldVer = (oldRel.tag_name || '').replace(/^v/, '');
    console.log(`  note legacy bridge latest tag=${oldRel.tag_name}`);
    check(!!oldRel.tag_name, `legacy bridge still serving a release (${oldRel.tag_name || 'none'})`);
    check(assetPresent(oldRel, 'latest.yml'), 'legacy bridge latest release still carries latest.yml (old clients can discover an update)');
    check(assetPresent(oldRel, `1132-Fixer-Setup-${oldVer}.exe`), `legacy bridge latest release carries its Setup installer (1132-Fixer-Setup-${oldVer}.exe)`);
    // The pinned one-time transition release MUST remain available and unchanged
    // on the legacy feed — that single release is the whole bridge for <=5.5.1
    // clients (docs/RELEASE-MIGRATION-2026-08.md). Guard it by tag specifically,
    // independent of which release is "latest", so a future release elsewhere
    // can never make this pass while the transition has been removed.
    const trans = await githubJson(`https://api.github.com/repos/${OLD_OWNER}/${OLD_REPO}/releases/tags/v${TRANSITION_VERSION}`);
    check(!!trans && trans.tag_name === `v${TRANSITION_VERSION}`, `pinned transition release v${TRANSITION_VERSION} still present on the legacy feed`);
    check(assetPresent(trans, 'latest.yml') && assetPresent(trans, `1132-Fixer-Setup-${TRANSITION_VERSION}.exe`), `pinned transition v${TRANSITION_VERSION} still carries latest.yml + Setup (bridge intact)`);
  } catch (err) {
    check(false, `legacy compatibility bridge / pinned transition unreachable — <=5.5.1 clients would be stranded: ${(err && err.message) || err}`);
  }

  // The broker is what the shipped field polls (header note 2). If it stops
  // serving, or serves something other than what this repository published,
  // every install in the field is affected and nothing else in CI would see
  // it. Both conditions are hard failures, reported as separate checks so the
  // log distinguishes "broker down" from "broker drifted".
  console.log('updater-channel-smoke: live broker channel (shipped v5.6.0 clients poll this)');
  let brokerYml = '';
  let brokerErr = null;
  for (let attempt = 1; attempt <= 2 && !brokerYml; attempt++) {
    try {
      brokerYml = await httpsGetTextRaw(BROKER_FEED);
    } catch (err) {
      brokerErr = err;
      if (attempt < 2) await new Promise((r) => { setTimeout(r, 2000); });
    }
  }
  check(!!brokerYml, `broker latest.yml reachable over https${brokerYml ? '' : `: ${(brokerErr && brokerErr.message) || brokerErr}`}`);
  if (brokerYml) {
    const brokerMeta = parseLatestYml(brokerYml);
    console.log(`  note broker version=${brokerMeta.version} path=${brokerMeta.path}`);
    check(!!meta.version && brokerMeta.version === meta.version, `broker version ${brokerMeta.version || '(missing)'} matches current channel ${meta.version || '(missing)'}`);
    check(!!meta.sha512 && brokerMeta.sha512 === meta.sha512, 'broker installer SHA-512 matches the current channel (same binary)');
    check(!!meta.path && brokerMeta.path === meta.path, `broker path ${brokerMeta.path || '(missing)'} matches current channel ${meta.path || '(missing)'}`);
    check(meta.size > 0 && brokerMeta.size === meta.size, `broker installer size matches the current channel (${brokerMeta.size || 0})`);
  }

  // REST release object only — never an asset GET. See the header note: an
  // asset GET here increments the download_count that the deletion gate for
  // this repository reads, and CI ran this on every commit.
  // Old-channel telemetry (REST metadata only). Under the compatibility-bridge
  // policy the legacy feed is EXPECTED to carry the current release (that is the
  // bridge <=5.5.1 clients take), so the tag is asserted "not ahead of source"
  // rather than "not equal to current". download_count is logged as telemetry
  // only — it is NOT a retirement gate (see the objective condition in
  // docs/RELEASE-MIGRATION-2026-08.md). Never GET the latest.yml asset here: an
  // asset GET inflates that counter and CI runs this on every commit.
  console.log('updater-channel-smoke: legacy old channel telemetry (REST only, do not delete)');
  try {
    const oldRel = await githubJson(`https://api.github.com/repos/${OLD_OWNER}/${OLD_REPO}/releases/latest`);
    const names = (oldRel.assets || []).map((a) => a.name);
    const n = assetCount(oldRel, 'latest.yml');
    const oldVer = (oldRel.tag_name || '').replace(/^v/, '');
    const caughtUp = semverCmp(oldVer, pkg.version) === 0;
    console.log(`  note old-channel ${OLD_OWNER}/${OLD_REPO} tag=${oldRel.tag_name} latest.yml download_count=${n} bridged=${caughtUp} (REST read, does not increment)`);
    check(semverCmp(oldVer, pkg.version) <= 0, `old-channel tag ${oldRel.tag_name} is not ahead of source v${pkg.version} (bridge carries current or lags, never leads)`);
    check(names.includes('latest.yml'), 'old-channel still publishes latest.yml (bridge intact, not deleted)');
    check(names.some((x) => x.endsWith('.exe')), 'old-channel still serves an installer (<=5.5.1 clients can still update)');
  } catch (err) {
    console.log(`  note old-channel REST metadata SKIPPED, its assertions did not run: ${(err && err.message) || err}`);
  }

  if (failures) {
    console.error(`\nupdater-channel-smoke: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('\nupdater-channel-smoke: PASS');
})().catch((err) => {
  console.error('updater-channel-smoke: threw', err);
  process.exit(1);
});
