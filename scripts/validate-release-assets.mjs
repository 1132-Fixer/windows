#!/usr/bin/env node
// Read-only byte verification, separate from release admission/publication.
// Validate an identified draft BEFORE publishing; validate published downloads
// independently afterward. A manifest never proves review/native acceptance.
//
// node scripts/validate-release-assets.mjs vX.Y.Z --mode draft \
//   --release-id <id> --manifest <immutable-local-manifest.json>
// node scripts/validate-release-assets.mjs vX.Y.Z --mode published \
//   --release-id <same-id> --manifest <same-manifest.json>
//
// Manifest: {schemaVersion:1,repository:'1132-Fixer/windows',tag,sourceSha,
//   assets:[{name,size,sha256}]}. Capture the EXACT local upload set BEFORE
// upload; never derive it from remote checksums. GITHUB_TOKEN (or the existing
// RELEASES_PAT path) is required for authenticated API asset-ID reads.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const RELEASE_REPOSITORY = '1132-Fixer/windows';
const API_ROOT = 'https://api.github.com/repos/' + RELEASE_REPOSITORY;
const HASH256 = /^[0-9a-f]{64}$/;
const HASH512 = /^[A-Za-z0-9+/]{86}==$/;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const MAX_ASSETS = 128;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const CDN_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export class ReleaseAssetValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseAssetValidationError';
    this.code = code;
  }
}
function requireProof(condition, code, message) {
  if (!condition) throw new ReleaseAssetValidationError(code, message);
}
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function dataRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(item => Object.hasOwn(item, 'value'));
}
function exactKeys(value, keys) {
  return dataRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validName(value) {
  return typeof value === 'string' && value.length <= 200 && value.length > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !/[. ]$/.test(value) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
}
function versionFor(tag) {
  const match = typeof tag === 'string' && tag.length <= 48 && STABLE_TAG.exec(tag);
  requireProof(match && match.slice(1).every(part => Number.isSafeInteger(Number(part))),
    'stable_tag_required', 'Only a canonical stable vX.Y.Z tag is supported; prerelease channels are not admitted.');
  return tag.slice(1);
}
function requiredNames(version) {
  const setup = `1132-Fixer-Setup-${version}.exe`;
  return [setup, `1132-Fixer-Portable-${version}.exe`, `${setup}.blockmap`,
    'latest.yml', 'checksums-sha256.txt', 'signature-state.json',
    'package-inventory.json', 'sbom.spdx.json', 'provenance.json'];
}
export function normalizeReleaseAssetManifest(input, tag) {
  const version = versionFor(tag);
  requireProof(exactKeys(input, ['schemaVersion', 'repository', 'tag', 'sourceSha', 'assets']) &&
    input.schemaVersion === 1 && input.repository === RELEASE_REPOSITORY && input.tag === tag &&
    typeof input.sourceSha === 'string' && SOURCE_SHA.test(input.sourceSha) &&
    Array.isArray(input.assets) && input.assets.length >= 9 && input.assets.length <= MAX_ASSETS,
  'manifest_invalid', 'An exact local manifest for the canonical repository, stable tag and full source SHA is required.');
  const names = new Set();
  const assets = input.assets.map(entry => {
    requireProof(exactKeys(entry, ['name', 'size', 'sha256']) && validName(entry.name) &&
      positiveInteger(entry.size) && entry.size <= MAX_ASSET_BYTES &&
      typeof entry.sha256 === 'string' && HASH256.test(entry.sha256) &&
      !names.has(entry.name.toLowerCase()), 'manifest_asset_invalid',
    'Manifest entries must have unique safe names, bounded sizes and SHA-256 digests.');
    names.add(entry.name.toLowerCase());
    return Object.freeze({ name: entry.name, size: entry.size, sha256: entry.sha256 });
  });
  for (const name of requiredNames(version)) requireProof(assets.some(item => item.name === name),
    'required_asset_missing', `The local manifest is missing ${name}.`);
  const expectedExes = new Set(requiredNames(version).slice(0, 2));
  requireProof(assets.filter(item => /\.exe$/i.test(item.name)).every(item => expectedExes.has(item.name)) &&
    !assets.some(item => /latest-mac|\.dmg$|\.pkg$|darwin|^beta\.yml$|^alpha\.yml$/i.test(item.name)),
  'unsupported_release_asset', 'This stable Windows release cannot contain other executables or alternate-platform/channel metadata.');
  return Object.freeze({ schemaVersion: 1, repository: RELEASE_REPOSITORY, tag,
    sourceSha: input.sourceSha, assets: Object.freeze(assets.sort((a, b) => a.name.localeCompare(b.name, 'en'))) });
}
// Pure build/upload adapter helper. No filesystem, network or acceptance claim.
export function createReleaseAssetManifest({ tag, sourceSha, assets } = {}) {
  requireProof(Array.isArray(assets), 'manifest_invalid', 'Explicit local asset bytes are required.');
  const entries = assets.map(entry => {
    requireProof(dataRecord(entry) && validName(entry.name) && entry.bytes instanceof Uint8Array,
      'manifest_asset_invalid', 'Each local asset requires a safe name and explicit byte array.');
    return { name: entry.name, size: entry.bytes.byteLength, sha256: sha256(entry.bytes) };
  });
  return normalizeReleaseAssetManifest({ schemaVersion: 1, repository: RELEASE_REPOSITORY, tag, sourceSha, assets: entries }, tag);
}
function decodeUtf8(bytes, name) {
  requireProof(!(bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
    'text_bom', `${name} starts with a UTF-8 BOM.`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ReleaseAssetValidationError('text_encoding', `${name} is not valid UTF-8.`); }
}
export function parseReleaseChecksums(bytes, executableNames) {
  const text = decodeUtf8(bytes, 'checksums-sha256.txt');
  // Keep published coreutils format: text.includes('\r') fails, no BOM, exact
  // names, no empty lines and one final LF.
  requireProof(!text.includes('\r'), 'checksums_format',
    'checksums-sha256.txt uses CRLF line endings (sha256sum -c cannot read it).');
  requireProof(text.endsWith('\n') && !text.endsWith('\n\n'),
    'checksums_format', 'checksums-sha256.txt must use LF with one final newline and no blank lines.');
  const expected = new Set(executableNames);
  const checksums = new Map();
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    requireProof(match && expected.has(match[2]) && !checksums.has(match[2]),
      'checksums_entry_invalid', 'checksums-sha256.txt contains a malformed, duplicate or unexpected filename.');
    checksums.set(match[2], match[1]);
  }
  requireProof(checksums.size === expected.size, 'checksums_missing_executable',
    'checksums-sha256.txt must contain exactly one entry for each shipped executable.');
  return checksums;
}
function scalar(value) {
  const trimmed = value.trim();
  if (/^'[^'\r\n]*'$/.test(trimmed) || /^"[^"\\\r\n]*"$/.test(trimmed)) return trimmed.slice(1, -1);
  requireProof(/^[A-Za-z0-9+/.=:_-]+$/.test(trimmed), 'metadata_scalar_invalid',
    'latest.yml contains an unsupported or ambiguous scalar.');
  return trimmed;
}
export function parseWindowsLatest(bytes, tag) {
  const text = decodeUtf8(bytes, 'latest.yml');
  const version = versionFor(tag);
  const top = new Map(), files = [];
  let current = null, inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let match;
    if ((match = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(raw))) {
      const [, key, value] = match;
      requireProof(!top.has(key) && ['version', 'files', 'path', 'sha512', 'releaseDate', 'isAdminRightsRequired'].includes(key),
        'metadata_key_invalid', 'latest.yml contains an unknown or duplicate top-level key.');
      inFiles = key === 'files'; current = null;
      if (inFiles) requireProof(value === undefined || value === '', 'metadata_files_invalid', 'latest.yml files must be a block sequence.');
      else requireProof(value !== undefined, 'metadata_value_missing', 'latest.yml has a missing scalar value.');
      top.set(key, inFiles ? true : scalar(value));
    } else if ((match = /^  - url: (.+)$/.exec(raw))) {
      requireProof(inFiles, 'metadata_files_invalid', 'latest.yml file appears outside the files block.');
      current = new Map([['url', scalar(match[1])]]); files.push(current);
    } else if ((match = /^    ([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(raw))) {
      const [, key, value] = match;
      requireProof(inFiles && current && ['sha512', 'size', 'blockMapSize', 'isAdminRightsRequired'].includes(key) && !current.has(key),
        'metadata_file_key_invalid', 'latest.yml has an unknown, misplaced or duplicate file key.');
      current.set(key, scalar(value));
    } else throw new ReleaseAssetValidationError('metadata_yaml_invalid', 'latest.yml is not the supported unambiguous electron-builder metadata format.');
  }
  const setupName = `1132-Fixer-Setup-${version}.exe`;
  // Successful validation means version matches tag, both sha512 values agree,
  // and size/hash are subsequently compared to actual uploaded Setup bytes.
  requireProof(top.get('version') === version && top.get('path') === setupName && top.get('files') === true,
    'metadata_identity_mismatch', 'latest.yml version/path does not match the stable tag and exact Setup filename.');
  requireProof(files.length === 1 && files[0].get('url') === setupName &&
    typeof top.get('sha512') === 'string' && HASH512.test(top.get('sha512')) &&
    files[0].get('sha512') === top.get('sha512') && /^[1-9][0-9]*$/.test(files[0].get('size') || '') &&
    positiveInteger(Number(files[0].get('size'))), 'metadata_files_invalid',
  'latest.yml must bind one Setup entry to identical top-level/file SHA-512 and a valid size.');
  requireProof(![top, ...files].some(record => record.has('isAdminRightsRequired') && record.get('isAdminRightsRequired') !== 'false'),
    'metadata_admin_flag', 'latest.yml still carries isAdminRightsRequired: true or an ambiguous value; elevate.exe is not shipped.');
  requireProof(typeof top.get('releaseDate') === 'string' && Number.isFinite(Date.parse(top.get('releaseDate'))),
    'metadata_date_invalid', 'latest.yml requires a valid releaseDate.');
  if (files[0].has('blockMapSize')) requireProof(/^[1-9][0-9]*$/.test(files[0].get('blockMapSize')) &&
    positiveInteger(Number(files[0].get('blockMapSize'))), 'metadata_blockmap_invalid', 'latest.yml blockMapSize is invalid.');
  return Object.freeze({ version, setupName, size: Number(files[0].get('size')), sha512: top.get('sha512') });
}
function releaseIdentity(release, { tag, mode, releaseId }) {
  requireProof(dataRecord(release) && positiveInteger(release.id) && release.tag_name === tag &&
    typeof release.draft === 'boolean' && typeof release.prerelease === 'boolean' && !release.prerelease &&
    typeof release.target_commitish === 'string' && release.target_commitish.length > 0 &&
    typeof release.updated_at === 'string' && Number.isFinite(Date.parse(release.updated_at)),
  'release_identity_invalid', 'Release identity, stable channel or metadata is incomplete.');
  requireProof(releaseId === undefined || release.id === releaseId, 'release_id_mismatch', 'The release ID does not match the intended release.');
  requireProof(mode === 'draft' ? release.draft && release.published_at === null :
    !release.draft && typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)),
  'release_state_mismatch', mode === 'draft' ? 'The intended release must still be an unpublished draft.' : 'The intended release must be published (not a draft).');
  return JSON.stringify([release.id, release.tag_name, release.draft, release.prerelease,
    release.target_commitish, release.published_at, release.updated_at, release.immutable ?? null]);
}
function assetIdentity(asset) {
  requireProof(dataRecord(asset) && positiveInteger(asset.id) && validName(asset.name) && positiveInteger(asset.size) &&
    asset.size <= MAX_ASSET_BYTES && asset.state === 'uploaded' &&
    typeof asset.created_at === 'string' && Number.isFinite(Date.parse(asset.created_at)) &&
    typeof asset.updated_at === 'string' && Number.isFinite(Date.parse(asset.updated_at)) &&
    (asset.digest === null || asset.digest === undefined || /^sha256:[0-9a-f]{64}$/.test(asset.digest)),
  'remote_asset_invalid', 'Release assets require complete uploaded IDs, names, sizes and identity timestamps.');
  return JSON.stringify([asset.id, asset.name, asset.size, asset.state, asset.created_at, asset.updated_at, asset.digest ?? null]);
}
function verifyProvenance(bytes, manifest) {
  let provenance;
  try { provenance = JSON.parse(decodeUtf8(bytes, 'provenance.json')); }
  catch (error) {
    if (error instanceof ReleaseAssetValidationError) throw error;
    throw new ReleaseAssetValidationError('provenance_invalid', 'provenance.json is not valid JSON.');
  }
  requireProof(dataRecord(provenance) && provenance.schema === '1132-fixer/provenance/v1' &&
    dataRecord(provenance.source) && provenance.source.repository === RELEASE_REPOSITORY &&
    provenance.source.commit === manifest.sourceSha && dataRecord(provenance.product) &&
    provenance.product.name === '1132-fixer' && provenance.product.version === manifest.tag.slice(1) &&
    Array.isArray(provenance.artifacts), 'provenance_identity_mismatch',
  'Unsigned provenance must name the same canonical source commit, product and version as the local manifest.');
  const entries = new Map();
  for (const item of provenance.artifacts) {
    requireProof(dataRecord(item) && validName(item.name) && positiveInteger(item.size) &&
      typeof item.sha256 === 'string' && HASH256.test(item.sha256) && !entries.has(item.name.toLowerCase()),
    'provenance_artifact_invalid', 'Unsigned provenance contains incomplete or ambiguous artifact identities.');
    entries.set(item.name.toLowerCase(), item);
  }
  for (const item of manifest.assets) {
    if (item.name === 'provenance.json') continue;
    const recorded = entries.get(item.name.toLowerCase());
    requireProof(recorded && recorded.name === item.name && recorded.size === item.size && recorded.sha256 === item.sha256,
      'provenance_artifact_mismatch', 'Unsigned provenance does not match an uploaded local artifact.');
  }
  // Consistency of unsigned metadata is not authenticated build-origin proof.
}
export async function validateReleaseAssets({ tag, mode = 'published', releaseId, expectedManifest,
  token, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  versionFor(tag);
  requireProof(['draft', 'published'].includes(mode) && (releaseId === undefined || positiveInteger(releaseId)) &&
    (mode !== 'draft' || positiveInteger(releaseId)), 'validation_mode_invalid',
  'Use draft with its explicit release ID, or published with an optional explicit ID.');
  const manifest = normalizeReleaseAssetManifest(expectedManifest, tag);
  requireProof(typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\r\n]/.test(token),
    'authentication_required', 'An authorized GitHub token is required for API asset-ID reads.');
  requireProof(typeof fetchImpl === 'function' && positiveInteger(timeoutMs) && timeoutMs <= 600000,
    'transport_invalid', 'A bounded fetch transport is required.');
  async function request(apiPath, accept, consume) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReleaseAssetValidationError('asset_read_timeout', 'An authenticated GitHub read exceeded its time bound.'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
      let url = API_ROOT + apiPath;
      let headers = { Accept: accept, Authorization: `Bearer ${token}`, 'User-Agent': '1132-fixer-release-validator', 'X-GitHub-Api-Version': '2022-11-28' };
      for (let redirects = 0; redirects < 3; redirects++) {
        controller.signal.throwIfAborted();
        const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
        controller.signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          requireProof(accept === 'application/octet-stream' && redirects < 2,
            'unexpected_redirect', 'Release metadata or an overlong asset redirect was refused.');
          let destination;
          try { destination = new URL(response.headers.get('location')); } catch { /* invalid below */ }
          requireProof(destination && destination.protocol === 'https:' && CDN_HOSTS.has(destination.hostname) &&
            !destination.username && !destination.password && !destination.port && !destination.hash,
          'untrusted_asset_redirect', 'An asset redirected outside the allowed GitHub asset hosts.');
          url = destination.href;
          // Never forward GitHub API credentials to signed object storage.
          headers = { Accept: 'application/octet-stream', 'User-Agent': '1132-fixer-release-validator' };
          continue;
        }
        requireProof(response.status === 200 && response.body && typeof response.body[Symbol.asyncIterator] === 'function',
          'asset_http_failure', 'A required GitHub read did not return a complete HTTP200 body.');
        return await consume(response.body, controller.signal);
      }
      throw new ReleaseAssetValidationError('unexpected_redirect', 'Asset redirect limit exceeded.');
      })()]);
    } catch (error) {
      if (error instanceof ReleaseAssetValidationError) throw error;
      throw new ReleaseAssetValidationError('asset_read_failed', 'A required authenticated GitHub read failed or exceeded its bound.');
    } finally { clearTimeout(timer); }
  }
  async function bytesFromBody(body, limit, signal) {
    const chunks = []; let count = 0;
    for await (const chunk of body) {
      signal.throwIfAborted();
      requireProof(chunk instanceof Uint8Array, 'asset_body_invalid', 'A response contained a non-byte chunk.');
      count += chunk.byteLength;
      requireProof(count <= limit, 'response_too_large', 'A GitHub response exceeded its declared byte bound.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, count);
  }
  async function json(apiPath) {
    const bytes = await request(apiPath, 'application/vnd.github+json', (body, signal) => bytesFromBody(body, MAX_MANIFEST_BYTES, signal));
    try { return JSON.parse(decodeUtf8(bytes, 'GitHub JSON')); }
    catch (error) {
      if (error instanceof ReleaseAssetValidationError) throw error;
      throw new ReleaseAssetValidationError('github_json_invalid', 'GitHub returned malformed JSON.');
    }
  }
  const releasePath = releaseId ? `/releases/${releaseId}` : `/releases/tags/${encodeURIComponent(tag)}`;
  const release = await json(releasePath);
  const identity = releaseIdentity(release, { tag, mode, releaseId });
  requireProof(release.target_commitish === manifest.sourceSha, 'release_source_mismatch',
    'Release target_commitish must be the full source SHA captured in the local manifest.');
  async function assetsSnapshot() {
    const assets = [], ids = new Set(), names = new Set();
    let exhausted = false;
    for (let page = 1; page <= 3; page++) {
      const entries = await json(`/releases/${release.id}/assets?per_page=100&page=${page}`);
      requireProof(Array.isArray(entries) && entries.length <= 100, 'asset_page_invalid', 'Asset listing was incomplete or malformed.');
      for (const entry of entries) {
        assetIdentity(entry);
        requireProof(!ids.has(entry.id) && !names.has(entry.name.toLowerCase()),
          'duplicate_remote_asset', 'Duplicate asset ID or ambiguous filename was refused.');
        ids.add(entry.id); names.add(entry.name.toLowerCase()); assets.push(entry);
      }
      requireProof(assets.length <= MAX_ASSETS, 'too_many_assets', 'Release asset count exceeded its bound.');
      if (entries.length < 100) { exhausted = true; break; }
    }
    requireProof(exhausted, 'asset_listing_unexhausted', 'Release assets were not exhaustively enumerated.');
    return assets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }
  const assets = await assetsSnapshot();
  const expectedByName = new Map(manifest.assets.map(item => [item.name, item]));
  requireProof(assets.length === manifest.assets.length && assets.every(asset => expectedByName.has(asset.name)),
    'asset_set_mismatch', 'Uploaded assets do not exactly match the captured local manifest.');
  const actual = new Map();
  for (const asset of assets) {
    const expected = expectedByName.get(asset.name);
    requireProof(asset.size === expected.size, 'asset_size_mismatch', `${asset.name} size differs from the local manifest.`);
    const retainBytes = ['latest.yml', 'checksums-sha256.txt', 'provenance.json'].includes(asset.name);
    const result = await request(`/releases/assets/${asset.id}`, 'application/octet-stream', async (body, signal) => {
      const hash256 = createHash('sha256'), hash512 = createHash('sha512'), chunks = [];
      let count = 0;
      for await (const chunk of body) {
        signal.throwIfAborted();
        requireProof(chunk instanceof Uint8Array, 'asset_body_invalid', 'An asset contained a non-byte chunk.');
        count += chunk.byteLength;
        requireProof(count <= expected.size && (!retainBytes || count <= MAX_MANIFEST_BYTES),
          'asset_size_mismatch', `${asset.name} bytes exceeded the captured size bound.`);
        hash256.update(chunk); hash512.update(chunk);
        if (retainBytes) chunks.push(Buffer.from(chunk));
      }
      return { size: count, sha256: hash256.digest('hex'), sha512: hash512.digest('base64'),
        bytes: retainBytes ? Buffer.concat(chunks, count) : undefined };
    });
    requireProof(result.size === expected.size && result.sha256 === expected.sha256 &&
      (!asset.digest || asset.digest === 'sha256:' + result.sha256),
    'asset_digest_mismatch', `${asset.name} bytes do not match the immutable local manifest.`);
    actual.set(asset.name, result);
  }
  const executables = manifest.assets.filter(item => item.name.endsWith('.exe')).map(item => item.name);
  const checksums = parseReleaseChecksums(actual.get('checksums-sha256.txt').bytes, executables);
  for (const name of executables) requireProof(checksums.get(name) === actual.get(name).sha256,
    'executable_checksum_mismatch', `${name} uploaded bytes do not match checksums-sha256.txt.`);
  const latest = parseWindowsLatest(actual.get('latest.yml').bytes, tag);
  requireProof(latest.size === actual.get(latest.setupName).size && latest.sha512 === actual.get(latest.setupName).sha512,
    'updater_digest_mismatch', 'Uploaded Setup size or SHA-512 does not match latest.yml.');
  verifyProvenance(actual.get('provenance.json').bytes, manifest);
  const finalRelease = await json(releasePath);
  requireProof(releaseIdentity(finalRelease, { tag, mode, releaseId: release.id }) === identity,
    'release_changed', 'Release identity/state changed during byte verification.');
  const finalAssets = await assetsSnapshot();
  requireProof(JSON.stringify(finalAssets.map(assetIdentity)) === JSON.stringify(assets.map(assetIdentity)),
    'assets_changed', 'Assets were added, replaced or changed during byte verification.');
  return Object.freeze({ schemaVersion: 1, repository: RELEASE_REPOSITORY, tag, mode, releaseId: release.id,
    manifestSourceSha: manifest.sourceSha, manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
    releaseIdentity: identity, assets: Object.freeze(assets.map(asset => Object.freeze({
      id: asset.id, name: asset.name, size: actual.get(asset.name).size,
      sha256: actual.get(asset.name).sha256, identity: assetIdentity(asset) }))),
    allUploadedBytesVerified: true, updaterMetadataVerified: true,
    publicationPerformed: false, nativeAcceptanceEstablished: false });
}

function cliOptions(args) {
  const options = { mode: 'published' }; let tag = '';
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['--mode', '--release-id', '--manifest'].includes(value)) {
      const key = { '--mode': 'mode', '--release-id': 'releaseId', '--manifest': 'manifestPath' }[value];
      requireProof(index + 1 < args.length && !args[index + 1].startsWith('--') && !Object.hasOwn(options, key + 'Given'),
        'usage', 'A required option value is missing or duplicated.');
      options[key + 'Given'] = true; options[key] = args[++index];
    } else {
      requireProof(!value.startsWith('-') && !tag, 'usage', 'Usage: validate-release-assets.mjs <tag> --mode draft|published --release-id <id> --manifest <file>');
      tag = value;
    }
  }
  options.tag = tag || process.env.RELEASE_TAG || '';
  requireProof(typeof options.manifestPath === 'string', 'usage', '--manifest is required; remote checksums cannot substitute for a local manifest.');
  if (options.releaseId !== undefined) {
    requireProof(/^[1-9][0-9]*$/.test(options.releaseId) && positiveInteger(Number(options.releaseId)), 'usage', '--release-id must be a positive exact integer.');
    options.releaseId = Number(options.releaseId);
  }
  return options;
}
async function main() {
  try {
    requireProof((process.env.RELEASES_OWNER || '1132-Fixer').toLowerCase() === '1132-fixer' &&
      (process.env.RELEASES_REPO || 'windows').toLowerCase() === 'windows', 'repository_mismatch',
    'This validator only admits the canonical 1132-Fixer/windows repository.');
    const options = cliOptions(process.argv.slice(2));
    const stat = fs.lstatSync(options.manifestPath);
    requireProof(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_MANIFEST_BYTES,
      'manifest_file_invalid', 'The local manifest must be a bounded regular file.');
    const manifestBytes = fs.readFileSync(options.manifestPath);
    const expectedManifest = JSON.parse(decodeUtf8(manifestBytes, 'Local manifest'));
    const receipt = await validateReleaseAssets({ tag: options.tag, mode: options.mode, releaseId: options.releaseId,
      expectedManifest, token: process.env.RELEASES_PAT || process.env.GITHUB_TOKEN || '' });
    console.log(JSON.stringify({ ...receipt, localManifestFileSha256: sha256(manifestBytes) }, null, 2));
  } catch (error) {
    const known = error instanceof ReleaseAssetValidationError;
    console.error(`FAIL: ${known ? error.code + ': ' + error.message : 'release_validation_failed: Local manifest or authenticated read failed.'}`);
    process.exitCode = known && error.code === 'usage' ? 2 : 1;
  }
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
const invokedDirectly = process.platform === 'win32'
  ? invokedPath.toLowerCase() === modulePath.toLowerCase() : invokedPath === modulePath;
if (invokedDirectly) await main();
