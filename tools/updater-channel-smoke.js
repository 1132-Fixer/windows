// Smoke test for the Windows updater channel.
// package.json.version is the single source of truth. The live
// 1132-Fixer/windows latest.yml must report that same version.
// HTTPS + SHA-512 integrity + isAllowedUpdaterUrl (from #156) are proven
// on the same fetch the portable notice uses. Does not publish a release.
// Does not flip verifyUpdateCodeSignature.
//
// The leftover PrimeUpYourLife/1132-Fixer-Windows-Releases feed is recorded
// as residual v5.5.1 clients. It is not the current channel and must not
// be deleted. Exit 0 PASS / 1 FAIL.

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
const OLD_FEED = `https://github.com/${OLD_OWNER}/${OLD_REPO}/releases/latest/download/latest.yml`;
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
  check(meta.version === pkg.version, `latest.yml version ${meta.version || '(missing)'} matches package.json ${pkg.version}`);
  check(/^[A-Za-z0-9+/]+={0,2}$/.test(meta.sha512) && meta.sha512.length >= 64, 'latest.yml carries installer SHA-512 (integrity)');
  check(meta.path === `1132-Fixer-Setup-${pkg.version}.exe`, `latest.yml path is 1132-Fixer-Setup-${pkg.version}.exe`);
  check(meta.size > 0, `latest.yml size is present (${meta.size || 0})`);

  let currentCounts = { latestYml: null, tag: null };
  try {
    const rel = await githubJson(`https://api.github.com/repos/${CURRENT_OWNER}/${CURRENT_REPO}/releases/latest`);
    currentCounts.tag = rel.tag_name;
    currentCounts.latestYml = assetCount(rel, 'latest.yml');
    check(rel.tag_name === `v${pkg.version}`, `GitHub latest tag ${rel.tag_name} matches package.json v${pkg.version}`);
    console.log(`  note current-channel latest.yml download_count=${currentCounts.latestYml} tag=${currentCounts.tag}`);
  } catch (err) {
    console.log(`  note current-channel GitHub API skipped: ${(err && err.message) || err}`);
  }

  console.log('updater-channel-smoke: residual old channel (do not delete)');
  let oldYml = '';
  try {
    oldYml = await httpsGetTextRaw(OLD_FEED);
  } catch (err) {
    console.log(`  note old-channel latest.yml unreachable: ${(err && err.message) || err}`);
  }
  if (oldYml) {
    const oldMeta = parseLatestYml(oldYml);
    check(oldMeta.version !== pkg.version, `old-channel latest.yml is residual ${oldMeta.version}, not current ${pkg.version}`);
    check(!!oldMeta.sha512, 'old-channel latest.yml still has sha512 (still serving)');
    console.log(`  note old-channel version=${oldMeta.version} path=${oldMeta.path}`);
    try {
      const oldRel = await githubJson(`https://api.github.com/repos/${OLD_OWNER}/${OLD_REPO}/releases/latest`);
      const n = assetCount(oldRel, 'latest.yml');
      console.log(`  note old-channel ${OLD_OWNER}/${OLD_REPO} tag=${oldRel.tag_name} latest.yml download_count=${n}`);
      check(oldRel.tag_name !== `v${pkg.version}`, `old-channel tag ${oldRel.tag_name} is not the current package.json version`);
      if (typeof n === 'number') {
        check(n > 0, `old-channel residual clients recorded (latest.yml downloads=${n})`);
      }
    } catch (err) {
      console.log(`  note old-channel GitHub API skipped: ${(err && err.message) || err}`);
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
