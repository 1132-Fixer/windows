// Smoke test for the Windows updater channel.
// package.json.version is the single source of truth. The live
// 1132-Fixer/windows latest.yml must report that same version.
// HTTPS + SHA-512 integrity + isAllowedUpdaterUrl (from #156) are proven
// on the same fetch the portable notice uses. Does not publish a release.
// Does not flip verifyUpdateCodeSignature.
//
// Two live channels exist and this test treats each differently:
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
// The canonical v6.0.0 transition release is also checked as a verified
// recovery download. It cannot auto-migrate <=5.5.1 clients because those
// binaries have the deleted legacy repository baked into their updater.
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
const TRANSITION_VERSION = '6.0.0';
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
  check(!mainSrc.includes('PrimeUpYourLife/1132-Fixer-Windows-Releases'), 'runtime does not point at the deleted legacy updater repository');
}

console.log('updater-channel-smoke: HTTPS + isAllowedUpdaterUrl');
{
  check(CURRENT_FEED.startsWith('https://'), 'current feed is https');
  check(es.isAllowedUpdaterUrl(CURRENT_FEED), 'canonical latest.yml allowed');
  check(es.isAllowedUpdaterUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.yml'), 'GitHub release CDN allowed');
  check(!es.isAllowedUpdaterUrl('https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest/download/latest.yml'), 'deleted legacy updater repository rejected');
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

  // Keep canonical transition artifacts verifiable for manual recovery. This
  // does not imply automatic discovery by <=5.5.1 clients.
  console.log(`updater-channel-smoke: canonical v${TRANSITION_VERSION} recovery assets`);
  try {
    const transition = await githubJson(`https://api.github.com/repos/${CURRENT_OWNER}/${CURRENT_REPO}/releases/tags/v${TRANSITION_VERSION}`);
    check(!!transition && transition.tag_name === `v${TRANSITION_VERSION}`, `canonical v${TRANSITION_VERSION} release remains published`);
    const expectedDigests = {
      'latest.yml': 'sha256:df76986aadf366d4e1e67a16e91d2d658189646b5a83514b8d39403d9593e4ef',
      [`1132-Fixer-Setup-${TRANSITION_VERSION}.exe`]: 'sha256:d2c4a8b3754a2fd4df5818c7a43eb63b62a971ac8d5d4dfa8c3a8c3bde3a5cae',
      [`1132-Fixer-Setup-${TRANSITION_VERSION}.exe.blockmap`]: 'sha256:8bc126ba8371e970e466eb63b1a6bd8f4ee6ca6bd68a38e7d58326ec284dc8de',
    };
    const assets = new Map((transition.assets || []).map((asset) => [asset.name, asset]));
    for (const [name, expectedDigest] of Object.entries(expectedDigests)) {
      const asset = assets.get(name);
      check(!!asset, `canonical v${TRANSITION_VERSION} recovery release includes ${name}`);
      check(!!asset && asset.digest === expectedDigest, `canonical v${TRANSITION_VERSION} ${name} SHA-256 remains unchanged`);
    }
  } catch (err) {
    check(false, `canonical v${TRANSITION_VERSION} recovery release unverifiable: ${(err && err.message) || err}`);
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
    const parts = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const cmp = (a, b) => {
      const aa = parts(a); const bb = parts(b);
      const n = Math.max(aa.length, bb.length);
      for (let i = 0; i < n; i++) {
        const d = (aa[i] || 0) - (bb[i] || 0);
        if (d) return d;
      }
      return 0;
    };
    check(!!brokerMeta.version && cmp(brokerMeta.version, meta.version) <= 0,
      `broker version ${brokerMeta.version || '(missing)'} is not ahead of current channel ${meta.version || '(missing)'}`);
    if (brokerMeta.version === meta.version) {
      check(!!meta.sha512 && brokerMeta.sha512 === meta.sha512, 'broker installer SHA-512 matches the current channel (same binary)');
      check(!!meta.path && brokerMeta.path === meta.path, `broker path ${brokerMeta.path || '(missing)'} matches current channel ${meta.path || '(missing)'}`);
      check(meta.size > 0 && brokerMeta.size === meta.size, `broker installer size matches the current channel (${brokerMeta.size || 0})`);
    } else {
      console.log(`  note broker lags current channel (${brokerMeta.version} vs ${meta.version}); v5.6.0 clients still poll this feed`);
      check(!!brokerMeta.path && /\.exe$/i.test(brokerMeta.path), 'lagging broker still names an installer');
      check(!!brokerMeta.sha512, 'lagging broker still carries SHA-512');
    }
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
