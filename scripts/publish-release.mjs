#!/usr/bin/env node
/** Draft-first, readback-before-publication GitHub Release transaction. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHubRestClient } from './github-rest.mjs';
import { validateReleaseEvidence } from './release-evidence.mjs';
import { verifyCandidateManifest } from './release-candidate.mjs';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function hashFile(file) {
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function exactAssets(dist, candidate) {
  const names = [
    ...candidate.assets.map(asset => asset.name),
    'release-candidate.json',
    'native-acceptance.json',
    'support-clearance.json'
  ].sort();
  const actual = fs.readdirSync(dist, { withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names)) fail('publication-local-asset-set');
  return names.map(name => ({ name, file: path.join(dist, name), ...hashFile(path.join(dist, name)) }));
}

export async function publishRelease({ api, repository, tag, head, version, assets }) {
  if (!api || typeof api.getReleaseByTag !== 'function' ||
      typeof api.resolveTag !== 'function' ||
      typeof api.getImmutableReleaseState !== 'function' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') ||
      tag !== `v${version}` || !/^[a-f0-9]{40}$/.test(head || '') ||
      !Array.isArray(assets) || !assets.length) fail('publication-input');
  const initialTag = await api.resolveTag(tag);
  if (!initialTag || initialTag.tag !== tag || initialTag.targetSha !== head) fail('publication-tag-identity');
  const immutableReleases = await api.getImmutableReleaseState();
  if (!immutableReleases || immutableReleases.enabled !== true) fail('publication-immutable-releases-required');
  if (await api.getReleaseByTag(tag)) fail('publication-release-exists');
  const prerelease = version.includes('-');
  const draft = await api.createDraft({
    tag, head, version, prerelease,
    name: `1132 Fixer ${tag}`,
    body: [
      '## Download', '',
      '| File | Use this one if |', '|---|---|',
      `| **1132-Fixer-Setup-${version}.exe** | **Most people.** Standard installer — adds Start Menu / desktop shortcuts and enables auto-update. |`,
      `| **1132-Fixer-Portable-${version}.exe** | You want no install — just run it. |`, '',
      'Right-click → **Run as administrator**. Requires Windows 10/11 with Zoom Workplace installed machine-wide.'
    ].join('\n')
  });
  if (!draft || !Number.isSafeInteger(draft.id) || draft.id < 1 || draft.draft !== true ||
      draft.tag_name !== tag || draft.prerelease !== prerelease) {
    fail('publication-draft-create');
  }
  const draftTag = await api.resolveTag(tag);
  if (!draftTag || draftTag.tag !== tag || draftTag.targetSha !== head) fail('publication-tag-identity');
  const uploaded = [];
  for (const asset of assets) {
    const created = await api.uploadAsset(draft.id, asset);
    if (!created || !Number.isSafeInteger(created.id) || created.name !== asset.name ||
        created.size !== asset.size || created.state !== 'uploaded') fail('publication-asset-upload');
    const metadata = await api.getAsset(created.id);
    if (!metadata || metadata.id !== created.id || metadata.name !== asset.name ||
        metadata.size !== asset.size || metadata.state !== 'uploaded') fail('publication-asset-metadata');
    const readback = await api.readAsset(created.id);
    if (!readback || readback.size !== asset.size || readback.sha256 !== asset.sha256) {
      fail('publication-asset-readback');
    }
    uploaded.push(created.id);
  }
  const remoteAssets = await api.listAssets(draft.id);
  const remoteNames = (Array.isArray(remoteAssets) ? remoteAssets : []).map(asset => asset.name).sort();
  const expectedNames = assets.map(asset => asset.name).sort();
  if (uploaded.length !== assets.length || JSON.stringify(remoteNames) !== JSON.stringify(expectedNames)) {
    fail('publication-asset-set');
  }
  const published = await api.publishDraft(draft.id, { makeLatest: !prerelease });
  if (!published || published.id !== draft.id || published.draft !== false ||
      published.tag_name !== tag || published.prerelease !== prerelease) {
    fail('publication-final-state');
  }
  const publishedTag = await api.resolveTag(tag);
  if (!publishedTag || publishedTag.tag !== tag || publishedTag.targetSha !== head) fail('publication-tag-identity');
  if (!prerelease) {
    const latest = await api.getLatestRelease();
    if (!latest || latest.id !== draft.id || latest.tag_name !== tag || latest.draft !== false) fail('publication-latest-state');
  }
  return published;
}

export function githubReleaseApi({ repository, token }) {
  const apiBase = `/repos/${repository}`;
  const client = createGitHubRestClient({ token, userAgent: '1132-fixer-release-publisher' });
  async function json(method, url, body, allow404 = false) {
    return client.json(method, url, body, { allow404, errorCode: 'publication-api-failed' });
  }
  return {
    getImmutableReleaseState: () => json('GET', `${apiBase}/immutable-releases`, null, true),
    getReleaseByTag: tag => json('GET', `${apiBase}/releases/tags/${encodeURIComponent(tag)}`, null, true),
    createDraft: input => json('POST', `${apiBase}/releases`, {
      tag_name: input.tag,
      target_commitish: input.head,
      name: input.name,
      body: input.body,
      draft: true,
      prerelease: input.prerelease,
      make_latest: 'false',
      generate_release_notes: true
    }),
    async uploadAsset(releaseId, asset) {
      const blob = await fs.openAsBlob(asset.file, { type: 'application/octet-stream' });
      const response = await client.request('POST',
        `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
        { body: blob, accept: 'application/vnd.github+json', errorCode: 'publication-asset-upload' }
      );
      return response.json();
    },
    getAsset: assetId => json('GET', `${apiBase}/releases/assets/${assetId}`),
    async readAsset(assetId) {
      const response = await client.request('GET', `${apiBase}/releases/assets/${assetId}`, {
        accept: 'application/octet-stream', errorCode: 'publication-asset-readback', followRedirects: true
      });
      if (!response.body) fail('publication-asset-readback');
      const hash = crypto.createHash('sha256');
      let size = 0;
      for await (const chunk of response.body) {
        hash.update(chunk);
        size += chunk.length;
      }
      return { size, sha256: hash.digest('hex') };
    },
    listAssets: async releaseId => {
      const page = await client.paginate(`${apiBase}/releases/${releaseId}/assets?per_page=100`);
      if (!page.complete) fail('publication-asset-pagination');
      return page.items;
    },
    publishDraft: (releaseId, { makeLatest }) => json('PATCH', `${apiBase}/releases/${releaseId}`, {
      draft: false,
      make_latest: makeLatest ? 'true' : 'false'
    }),
    getLatestRelease: () => json('GET', `${apiBase}/releases/latest`),
    async resolveTag(tag) {
      const ref = await json('GET', `${apiBase}/git/ref/tags/${encodeURIComponent(tag)}`);
      if (!ref || !ref.object || ref.object.type !== 'tag' || !/^[a-f0-9]{40}$/.test(ref.object.sha || '')) {
        fail('publication-tag-identity');
      }
      const object = await json('GET', `${apiBase}/git/tags/${ref.object.sha}`);
      if (!object || object.tag !== tag || !object.object || object.object.type !== 'commit' ||
          !/^[a-f0-9]{40}$/.test(object.object.sha || '')) fail('publication-tag-identity');
      return { tag, tagObjectSha: ref.object.sha, targetSha: object.object.sha };
    }
  };
}

function argOf(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const tag = argOf('--tag', process.env.GITHUB_REF_NAME || '');
  const head = argOf('--head', process.env.GITHUB_SHA || '');
  const version = argOf('--version');
  const dist = path.resolve(argOf('--dist', 'dist'));
  if (!token) fail('publication-token-missing');
  const nativeBytes = fs.readFileSync(path.join(dist, 'native-acceptance.json'));
  const supportBytes = fs.readFileSync(path.join(dist, 'support-clearance.json'));
  const evidence = validateReleaseEvidence(nativeBytes, supportBytes, { expectedHead: head, expectedVersion: version });
  if (evidence.nativeSha256 !== argOf('--native-evidence-sha256') ||
      evidence.supportSha256 !== argOf('--support-clearance-sha256')) fail('publication-evidence-digest');
  const candidate = JSON.parse(fs.readFileSync(path.join(dist, 'release-candidate.json'), 'utf8'));
  verifyCandidateManifest({
    dist, manifest: candidate, head, version,
    setupSha256: evidence.native.packages.setup.packageSha256,
    portableSha256: evidence.native.packages.portable.packageSha256
  });
  const assets = exactAssets(dist, candidate);
  const published = await publishRelease({
    api: githubReleaseApi({ repository, token }), repository, tag, head, version, assets
  });
  console.log(`[release-publish] PASS release=${published.id} assets=${assets.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[release-publish] ${error && error.code || 'publication-failed'}`);
    process.exitCode = 1;
  });
}
