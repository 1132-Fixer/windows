'use strict';

// In-memory GitHub/asset fixtures only. The actual validator module is imported;
// no release, network, package, subprocess, browser or filesystem write occurs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const TAG = 'v6.4.1';
const VERSION = '6.4.1';
const SOURCE = '1'.repeat(40);
const SETUP = `1132-Fixer-Setup-${VERSION}.exe`;
const PORTABLE = `1132-Fixer-Portable-${VERSION}.exe`;
const API = 'https://api.github.com/repos/1132-Fixer/windows';
const TOKEN = 'synthetic-validator-token';
const DATE = '2026-11-05T20:00:00Z';
const HASH = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0, failed = 0, finished = false;
let createManifest, validate;
const forbidden = [];
const restorers = [];
function deny(object, key) {
  const original = object[key];
  if (typeof original !== 'function') return;
  object[key] = () => { forbidden.push(key); throw new Error('External effect attempted: ' + key); };
  restorers.push(() => { object[key] = original; });
}
process.once('beforeExit', () => {
  if (!finished) { console.error('FAIL release-assets: asynchronous harness did not complete'); process.exitCode = 1; }
});
function response(bytes, { status = 200, location } = {}) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes));
  return { status, headers: { get(name) { return name.toLowerCase() === 'location' ? location : null; } },
    body: (async function* () { for (let index = 0; index < payload.length; index += 7) yield payload.subarray(index, index + 7); })() };
}
function fixture(mode = 'draft') {
  const local = new Map([
    [SETUP, Buffer.from('MZ synthetic installer fixture')],
    [PORTABLE, Buffer.from('MZ synthetic portable fixture')],
    [`${SETUP}.blockmap`, Buffer.from('synthetic compressed blockmap')],
    ['signature-state.json', Buffer.from('{"overall":"unsigned"}\n')],
    ['package-inventory.json', Buffer.from('{"fixture":"inventory"}\n')],
    ['sbom.spdx.json', Buffer.from('{"spdxVersion":"SPDX-2.3"}\n')]
  ]);
  local.set('latest.yml', Buffer.from(`version: ${VERSION}\nfiles:\n  - url: ${SETUP}\n    sha512: ${HASH(local.get(SETUP), 'sha512', 'base64')}\n    size: ${local.get(SETUP).length}\npath: ${SETUP}\nsha512: ${HASH(local.get(SETUP), 'sha512', 'base64')}\nreleaseDate: '${DATE}'\n`));
  local.set('checksums-sha256.txt', Buffer.from([PORTABLE, SETUP].map(name => `${HASH(local.get(name))}  ${name}\n`).join('')));
  const calls = [], bodyOverrides = new Map();
  const release = { id:42, tag_name:TAG, draft:mode === 'draft', prerelease:false,
    published_at:mode === 'draft' ? null : DATE, updated_at:DATE, target_commitish:SOURCE, immutable:false };
  const state = { local, calls, bodyOverrides, release, listingReads:0, releaseReads:0, publicationAttempts:0,
    redirectAsset:null, redirectHost:'release-assets.githubusercontent.com', listChange:null, releaseChange:null };
  function syncLocal(updateProvenance = true) {
    if (updateProvenance) {
      const artifacts = [...local.entries()].filter(([name]) => name !== 'provenance.json')
        .map(([name, bytes]) => ({ name, size:bytes.length, sha256:HASH(bytes) }));
      local.set('provenance.json', Buffer.from(JSON.stringify({ schema:'1132-fixer/provenance/v1',
        disclaimer:'Unsigned fixture, not an attestation.', product:{name:'1132-fixer',version:VERSION},
        source:{repository:'1132-Fixer/windows',commit:SOURCE}, artifacts })));
    }
    state.assets = [...local.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, bytes], index) => ({
      id:100 + index, name, size:bytes.length, state:'uploaded', created_at:DATE, updated_at:DATE,
      digest:null, url:'https://untrusted.invalid/ignored', browser_download_url:'https://untrusted.invalid/also-ignored'
    }));
    state.manifest = createManifest({tag:TAG,sourceSha:SOURCE,assets:[...local.entries()].map(([name, bytes]) => ({name,bytes}))});
  }
  state.syncLocal = syncLocal;
  state.replaceLocal = (name, text) => { local.set(name, Buffer.from(text)); syncLocal(); };
  syncLocal();
  state.fetch = async (url, options) => {
    calls.push({url,method:options.method,headers:{...options.headers},redirect:options.redirect});
    if (options.method !== 'GET') { state.publicationAttempts++; throw new Error('Publication forbidden in validator'); }
    assert.equal(options.redirect, 'manual');
    if (url.startsWith('https://release-assets.githubusercontent.com/') || url.startsWith('https://objects.githubusercontent.com/')) {
      assert.equal(Object.hasOwn(options.headers, 'Authorization'), false, 'No API credential may reach signed storage');
      const asset = state.assets.find(item => item.id === state.redirectAsset);
      return response(bodyOverrides.get(asset.name) || local.get(asset.name));
    }
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`, 'Every API metadata and asset-ID read must authenticate');
    assert.ok(url.startsWith(API + '/'), 'Never fetch a repository/asset supplied URL');
    if (url === API + '/releases/42' || url === API + '/releases/tags/' + TAG) {
      state.releaseReads++;
      let value = clone(release);
      if (state.releaseChange) value = state.releaseChange(value, state.releaseReads);
      return response(value);
    }
    if (url === API + '/releases/42/assets?per_page=100&page=1') {
      state.listingReads++;
      let value = clone(state.assets);
      if (state.listChange) value = state.listChange(value, state.listingReads);
      return response(value);
    }
    const match = new RegExp('^' + API.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/releases/assets/([0-9]+)$').exec(url);
    assert.ok(match, 'Only the canonical release and API asset-ID routes are permitted');
    const asset = state.assets.find(item => item.id === Number(match[1]));
    assert.ok(asset, 'The requested asset ID must come from the captured listing');
    if (state.redirectAsset === asset.id) return response(Buffer.alloc(0), {status:302,
      location:`https://${state.redirectHost}/fixture/${asset.id}?signed=synthetic`});
    return response(bodyOverrides.get(asset.name) || local.get(asset.name));
  };
  state.options = () => ({tag:TAG,mode,releaseId:42,expectedManifest:state.manifest,token:TOKEN,fetchImpl:state.fetch,timeoutMs:1000});
  return state;
}
async function check(name, fn) {
  try { await fn(); passed++; }
  catch (error) { failed++; console.error('FAIL release-assets: ' + name + ': ' + error.message); }
}
async function refuses(f, code, options = {}) {
  await assert.rejects(validate({...f.options(), ...options}), error => {
    assert.equal(error.code, code);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
  assert.equal(f.publicationAttempts, 0);
  assert.ok(f.calls.every(call => call.method === 'GET'));
}

(async () => {
  for (const key of ['writeFile','writeFileSync','appendFile','appendFileSync','rm','rmSync','unlink','unlinkSync','mkdir','mkdirSync']) deny(fs,key);
  for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) deny(childProcess,key);
  deny(globalThis,'fetch');
  try {
    const source = await import(pathToFileURL(require.resolve('../scripts/validate-release-assets.mjs')).href);
    createManifest = source.createReleaseAssetManifest;
    validate = source.validateReleaseAssets;
    await check('identified draft verifies every uploaded byte and remains unpublished', async () => {
      const f = fixture(); const receipt = await validate(f.options());
      assert.equal(receipt.mode,'draft'); assert.equal(receipt.releaseId,42);
      assert.equal(receipt.assets.length,9); assert.equal(receipt.allUploadedBytesVerified,true);
      assert.equal(receipt.updaterMetadataVerified,true); assert.equal(receipt.publicationPerformed,false);
      assert.equal(receipt.nativeAcceptanceEstablished,false);
      assert.equal(receipt.manifestSourceSha,SOURCE); assert.equal(f.listingReads,2); assert.equal(f.releaseReads,2);
      for (const asset of receipt.assets) assert.equal(asset.sha256,HASH(f.local.get(asset.name)));
      assert.equal(f.publicationAttempts,0);
    });
    await check('published mode independently verifies the same exact bytes', async () => {
      const f = fixture('published'); const receipt = await validate(f.options());
      assert.equal(receipt.mode,'published'); assert.equal(receipt.publicationPerformed,false);
    });
    await check('published tag lookup remains explicit and canonical', async () => {
      const f = fixture('published'); const receipt = await validate({...f.options(),releaseId:undefined});
      assert.equal(receipt.releaseId,42); assert.ok(f.calls[0].url.endsWith('/releases/tags/' + TAG));
    });
    await check('signed GitHub storage redirect strips API credentials', async () => {
      const f = fixture(); f.redirectAsset = f.assets.find(item => item.name === PORTABLE).id;
      assert.equal((await validate(f.options())).allUploadedBytesVerified,true);
      assert.equal(f.calls.filter(call => call.url.startsWith('https://release-assets.githubusercontent.com/')).length,1);
    });
    for (const tag of ['v6.4.1-beta.1','v06.4.1','6.4.1','v6.4.1+build']) await check('unstable/noncanonical tag refuses before any read: ' + tag, async () => {
      const f = fixture(); await refuses(f,'stable_tag_required',{tag}); assert.equal(f.calls.length,0);
    });
    await check('draft mode requires the intended release ID', async () => {
      const f = fixture(); await refuses(f,'validation_mode_invalid',{releaseId:undefined}); assert.equal(f.calls.length,0);
    });
    await check('authenticated API reads are mandatory', async () => {
      const f = fixture(); await refuses(f,'authentication_required',{token:''}); assert.equal(f.calls.length,0);
    });
    await check('a local full-source manifest is mandatory', async () => {
      const f = fixture(); await refuses(f,'manifest_invalid',{expectedManifest:undefined}); assert.equal(f.calls.length,0);
    });
    await check('another repository cannot be supplied by the manifest', async () => {
      const f = fixture(), manifest = clone(f.manifest); manifest.repository='other/windows';
      await refuses(f,'manifest_invalid',{expectedManifest:manifest}); assert.equal(f.calls.length,0);
    });
    await check('short source identity cannot substitute for the full SHA', async () => {
      const f = fixture(), manifest = clone(f.manifest); manifest.sourceSha='1'.repeat(7);
      await refuses(f,'manifest_invalid',{expectedManifest:manifest}); assert.equal(f.calls.length,0);
    });
    await check('missing local blockmap cannot be hidden by extra metadata', async () => {
      const f = fixture(), manifest = clone(f.manifest);
      manifest.assets = manifest.assets.filter(item => !item.name.endsWith('.blockmap'));
      manifest.assets.push({name:'extra.json',size:1,sha256:'a'.repeat(64)});
      await refuses(f,'required_asset_missing',{expectedManifest:manifest}); assert.equal(f.calls.length,0);
    });
    await check('ambiguous local filenames are rejected', async () => {
      const f = fixture(), manifest = clone(f.manifest); manifest.assets.push({...manifest.assets[0],name:manifest.assets[0].name.toUpperCase()});
      await refuses(f,'manifest_asset_invalid',{expectedManifest:manifest}); assert.equal(f.calls.length,0);
    });
    await check('manifest filenames cannot traverse or select another stream', async () => {
      const f = fixture(), manifest = clone(f.manifest); manifest.assets[0].name='../foreign.exe';
      await refuses(f,'manifest_asset_invalid',{expectedManifest:manifest}); assert.equal(f.calls.length,0);
    });
    await check('draft validation refuses an already published release', async () => {
      const f = fixture('draft'); f.release.draft=false; f.release.published_at=DATE;
      await refuses(f,'release_state_mismatch');
    });
    await check('published validation refuses an unpublished draft', async () => {
      const f = fixture('published'); f.release.draft=true; f.release.published_at=null;
      await refuses(f,'release_state_mismatch');
    });
    await check('prerelease metadata cannot enter the stable updater feed', async () => {
      const f = fixture(); f.release.prerelease=true; await refuses(f,'release_identity_invalid');
    });
    await check('release ID response must match the intended ID', async () => {
      const f = fixture(); f.release.id=43; await refuses(f,'release_id_mismatch');
    });
    await check('release target must bind the exact captured source SHA', async () => {
      const f = fixture(); f.release.target_commitish='main'; await refuses(f,'release_source_mismatch');
    });
    await check('duplicate remote asset IDs are rejected', async () => {
      const f = fixture(); f.assets[1].id=f.assets[0].id; await refuses(f,'duplicate_remote_asset');
    });
    await check('case-conflicting remote names are rejected', async () => {
      const f = fixture(); f.assets[1].name=f.assets[0].name.toUpperCase(); await refuses(f,'duplicate_remote_asset');
    });
    await check('missing uploaded blockmap refuses the release', async () => {
      const f = fixture(); f.assets=f.assets.filter(item => !item.name.endsWith('.blockmap')); await refuses(f,'asset_set_mismatch');
    });
    await check('unexpected existing assets cannot be silently overwritten or ignored', async () => {
      const f = fixture(); f.assets.push({...f.assets[0],id:999,name:'obsolete.exe'}); await refuses(f,'asset_set_mismatch');
    });
    await check('altered Portable bytes are rejected even when size/checksum text look valid', async () => {
      const f = fixture(), changed=Buffer.from(f.local.get(PORTABLE)); changed[changed.length-1]^=1;
      f.bodyOverrides.set(PORTABLE,changed); await refuses(f,'asset_digest_mismatch');
    });
    await check('altered installer bytes are rejected before updater acceptance', async () => {
      const f = fixture(), changed=Buffer.from(f.local.get(SETUP)); changed[0]^=1;
      f.bodyOverrides.set(SETUP,changed); await refuses(f,'asset_digest_mismatch');
    });
    await check('oversized streamed asset is bounded', async () => {
      const f = fixture(); f.bodyOverrides.set(PORTABLE,Buffer.concat([f.local.get(PORTABLE),Buffer.from('x')]));
      await refuses(f,'asset_size_mismatch');
    });
    await check('truncated streamed asset is not accepted', async () => {
      const f = fixture(); f.bodyOverrides.set(PORTABLE,f.local.get(PORTABLE).subarray(0,-1));
      await refuses(f,'asset_digest_mismatch');
    });
    await check('checksum duplicates are rejected rather than collapsed into a set', async () => {
      const f = fixture(); const line=f.local.get('checksums-sha256.txt').toString().split('\n')[0];
      f.replaceLocal('checksums-sha256.txt',f.local.get('checksums-sha256.txt').toString()+line+'\n');
      await refuses(f,'checksums_entry_invalid');
    });
    await check('checksums are compared with actual executable hashes', async () => {
      const f = fixture(); f.replaceLocal('checksums-sha256.txt',f.local.get('checksums-sha256.txt').toString().replace(HASH(f.local.get(PORTABLE)),'0'.repeat(64)));
      await refuses(f,'executable_checksum_mismatch');
    });
    await check('every shipped executable requires a checksum', async () => {
      const f = fixture(); f.replaceLocal('checksums-sha256.txt',`${HASH(f.local.get(SETUP))}  ${SETUP}\n`);
      await refuses(f,'checksums_missing_executable');
    });
    await check('published checksum CRLF is still refused', async () => {
      const f = fixture(); f.replaceLocal('checksums-sha256.txt',f.local.get('checksums-sha256.txt').toString().replace(/\n/g,'\r\n'));
      await refuses(f,'checksums_format');
    });
    await check('published checksum BOM is still refused', async () => {
      const f = fixture(); f.local.set('checksums-sha256.txt',Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),f.local.get('checksums-sha256.txt')])); f.syncLocal();
      await refuses(f,'text_bom');
    });
    await check('checksums require a final LF', async () => {
      const f = fixture(); f.replaceLocal('checksums-sha256.txt',f.local.get('checksums-sha256.txt').toString().slice(0,-1));
      await refuses(f,'checksums_format');
    });
    await check('duplicate updater path is ambiguous even when its last value is correct', async () => {
      const f = fixture(); f.replaceLocal('latest.yml',`path: ${SETUP}\n`+f.local.get('latest.yml').toString());
      await refuses(f,'metadata_key_invalid');
    });
    await check('missing metadata files entry is not accepted', async () => {
      const f = fixture(); f.replaceLocal('latest.yml',`version: ${VERSION}\nfiles:\npath: ${SETUP}\nsha512: ${HASH(f.local.get(SETUP),'sha512','base64')}\nreleaseDate: '${DATE}'\n`);
      await refuses(f,'metadata_files_invalid');
    });
    await check('nested/top-level updater SHA512 disagreement is refused', async () => {
      const f = fixture(); f.replaceLocal('latest.yml',f.local.get('latest.yml').toString().replace('    sha512: '+HASH(f.local.get(SETUP),'sha512','base64'),'    sha512: '+HASH(Buffer.from('wrong'),'sha512','base64')));
      await refuses(f,'metadata_files_invalid');
    });
    await check('matching metadata fields still require the actual installer SHA512', async () => {
      const f = fixture(); f.replaceLocal('latest.yml',f.local.get('latest.yml').toString().split(HASH(f.local.get(SETUP),'sha512','base64')).join(HASH(Buffer.from('wrong'),'sha512','base64')));
      await refuses(f,'updater_digest_mismatch');
    });
    await check('updater size is checked against actual uploaded Setup', async () => {
      const f = fixture(); f.replaceLocal('latest.yml',f.local.get('latest.yml').toString().replace('    size: '+f.local.get(SETUP).length,'    size: '+(f.local.get(SETUP).length+1)));
      await refuses(f,'updater_digest_mismatch');
    });
    await check('unsupported updater elevation flag is refused', async () => {
      const f = fixture(); f.replaceLocal('latest.yml',f.local.get('latest.yml').toString()+'isAdminRightsRequired: true\n');
      await refuses(f,'metadata_admin_flag');
    });
    await check('unsigned provenance must name the manifest source revision', async () => {
      const f = fixture(), value=JSON.parse(f.local.get('provenance.json')); value.source.commit='2'.repeat(40);
      f.local.set('provenance.json',Buffer.from(JSON.stringify(value))); f.syncLocal(false);
      await refuses(f,'provenance_identity_mismatch');
    });
    await check('unsigned provenance must include the same Portable artifact identity', async () => {
      const f = fixture(), value=JSON.parse(f.local.get('provenance.json')); value.artifacts.find(item => item.name===PORTABLE).sha256='0'.repeat(64);
      f.local.set('provenance.json',Buffer.from(JSON.stringify(value))); f.syncLocal(false);
      await refuses(f,'provenance_artifact_mismatch');
    });
    await check('publication/state change during reads invalidates draft verification', async () => {
      const f = fixture(); f.releaseChange=(value,n)=>n===1?value:{...value,draft:false,published_at:DATE};
      await refuses(f,'release_state_mismatch');
    });
    await check('changed release identity invalidates byte verification', async () => {
      const f = fixture(); f.releaseChange=(value,n)=>n===1?value:{...value,updated_at:'2026-11-05T20:01:00Z'};
      await refuses(f,'release_changed');
    });
    await check('same-name asset replacement during reads is detected by asset ID', async () => {
      const f = fixture(); f.listChange=(value,n)=>{if(n>1)value[0].id=999;return value;};
      await refuses(f,'assets_changed');
    });
    await check('asset metadata timestamp change during verification remains a conflict', async () => {
      const f = fixture(); f.listChange=(value,n)=>{if(n>1)value[0].updated_at='2026-11-05T20:01:00Z';return value;};
      await refuses(f,'assets_changed');
    });
    await check('unknown-host asset redirect is refused without forwarding the token', async () => {
      const f = fixture(); f.redirectAsset=f.assets.find(item=>item.name===PORTABLE).id; f.redirectHost='attacker.invalid';
      await refuses(f,'untrusted_asset_redirect');
      assert.equal(f.calls.some(call=>call.url.startsWith('https://attacker.invalid')),false);
    });
    await check('metadata repository redirect is refused', async () => {
      const f = fixture(); const fetchImpl=async()=>response(Buffer.alloc(0),{status:301,location:'https://api.github.com/repos/other/windows/releases/42'});
      await refuses(f,'unexpected_redirect',{fetchImpl});
    });
    await check('a nonresponsive transport returns a bounded failure', async () => {
      const f = fixture(); await refuses(f,'asset_read_timeout',{fetchImpl:()=>new Promise(()=>{}),timeoutMs:5});
    });
    assert.deepEqual(forbidden,[],'The pure suite must never attempt native/process/network/write effects');
  } finally { for (const restore of restorers.reverse()) restore(); }
  console.log(`release-assets-smoke: ${passed} passed, ${failed} failed; in-memory API/bytes only; no publication`);
  if (failed) process.exitCode=1;
  finished=true;
})().catch(error=>{
  for(const restore of restorers.reverse()) restore();
  console.error('FAIL release-assets harness: '+error.message); process.exitCode=1; finished=true;
});
