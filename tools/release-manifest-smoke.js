'use strict';

// Actual temporary-file capture/race fixtures. Never reads a real checkout's
// source identity or launches Git/PowerShell/network/native repair. Explicit
// source/path proof adapters are identified as fixtures in returned receipts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const TAG = 'v6.4.1', VERSION = '6.4.1', SOURCE = '1'.repeat(40);
const SETUP = `1132-Fixer-Setup-${VERSION}.exe`;
const PORTABLE = `1132-Fixer-Portable-${VERSION}.exe`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const attempts = [], restores = [];
let build, checkUntracked, passed = 0, failed = 0;
function sourceProof(root, head = SOURCE, change = {}) {
  return { available:true, repository:'1132-Fixer/windows', root, head,
    clean:true, cleanHead:head, cleanReason:'tracked-head-equal-and-untracked-policy-verified',
    cleanFingerprint:'a'.repeat(64), ...change };
}
function deny(object, key) {
  const original = object[key];
  if (typeof original !== 'function') return;
  object[key] = () => { attempts.push(key); throw new Error('External process/network operation forbidden: ' + key); };
  restores.push(() => { object[key] = original; });
}
function fixture() {
  const base = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, '1132-release-manifest-'));
  const dist = path.join(root, 'dist'); fs.mkdirSync(dist);
  const output = path.join(root, 'release-manifest.json');
  const files = new Map([
    [SETUP, Buffer.from([0x4d,0x5a,0,0xff,13,10,0xef,0xbb,0xbf,1,2,3,4,5])],
    [PORTABLE, Buffer.from([0x4d,0x5a,0,0xfe,13,10,10,13,0,8,7,6])],
    [SETUP + '.blockmap', Buffer.from('compressed fixture bytes')],
    ['latest.yml', Buffer.from('version: 6.4.1\n')],
    ['checksums-sha256.txt', Buffer.from('owned fixture checksum bytes\n')],
    ['signature-state.json', Buffer.from('{"fixture":"unsigned"}\n')],
    ['package-inventory.json', Buffer.from('{"fixture":"inventory"}\n')],
    ['sbom.spdx.json', Buffer.from('{"fixture":"sbom"}\n')],
    ['provenance.json', Buffer.from('{"fixture":"unsigned provenance"}\n')]
  ]);
  for (const [name, bytes] of files) fs.writeFileSync(path.join(dist, name), bytes, {flag:'wx'});
  const state = {root,base,dist,output,files,sourceReads:0,inspections:0};
  state.reader = () => { state.sourceReads++; return sourceProof(root); };
  state.inspector = paths => { state.inspections++; return {schema:'1132-release-physical-paths/1',paths:paths.map(value=>({path:value,nonReparse:true}))}; };
  state.options = () => ({dist,tag:TAG,sourceSha:SOURCE,out:output,sourceRoot:root,sourceReader:state.reader,pathInspector:state.inspector});
  state.cleanup = () => {
    const actual = fs.realpathSync.native(root);
    const expectedPrefix = path.join(base,'1132-release-manifest-');
    const same = process.platform==='win32' ? actual.toLowerCase()===root.toLowerCase() : actual===root;
    assert.ok(same && root.startsWith(expectedPrefix) && path.dirname(root)===base && root!==base,
      'Cleanup must remain within the uniquely owned temporary fixture');
    fs.rmSync(root,{recursive:true,force:true});
  };
  return state;
}
function refuses(f, code, override = {}) {
  let result;
  assert.throws(()=>build({...f.options(),...override}),error=>{
    result=error;
    if(Array.isArray(code))assert.ok(code.includes(error.code),'Expected a proven input-change refusal, got '+error.code);
    else assert.equal(error.code,code);
    return true;
  });
  return result;
}
function test(name, run) {
  const f = fixture();
  try { run(f); passed++; }
  catch(error) { failed++; console.error('FAIL release-manifest: '+name+': '+error.message); }
  finally { f.cleanup(); }
}
(async()=>{
  for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) deny(childProcess,key);
  deny(globalThis,'fetch');
  syncBuiltinESMExports();
  try {
    ({buildDistReleaseManifest:build,checkUntrackedReleaseInputs:checkUntracked}=await import(pathToFileURL(require.resolve('../scripts/create-release-manifest.mjs')).href));
    test('captures exact binary bytes into a new LF/no-BOM manifest',f=>{
      const result=build(f.options()), bytes=fs.readFileSync(f.output);
      assert.equal(result.manifest.repository,'1132-Fixer/windows'); assert.equal(result.manifest.tag,TAG);
      assert.equal(result.manifest.sourceSha,SOURCE); assert.equal(result.manifest.assets.length,9);
      for(const entry of result.manifest.assets) {
        assert.equal(entry.size,f.files.get(entry.name).length); assert.equal(entry.sha256,hash(f.files.get(entry.name)));
        assert.deepEqual(fs.readFileSync(path.join(f.dist,entry.name)),f.files.get(entry.name),'Input bytes must be preserved');
      }
      assert.equal(result.file.sha256,hash(bytes)); assert.equal(result.file.size,bytes.length);
      assert.ok(bytes.toString('utf8').endsWith('\n')); assert.equal(bytes.includes(Buffer.from('\r')),false);
      assert.notEqual(bytes[0],0xef); assert.deepEqual(JSON.parse(bytes),result.manifest);
      assert.equal(result.receipt.contentPasses,3); assert.equal(result.receipt.createNew,true);
      assert.equal(result.receipt.fileFlushed,true); assert.equal(result.receipt.readbackVerified,true);
      assert.equal(result.receipt.sourceClean,true);assert.equal(result.receipt.sourceCleanFingerprint,'a'.repeat(64));
      assert.equal(result.receipt.sourceAdapter,'EXPLICIT_ADAPTER'); assert.equal(result.receipt.pathAdapter,'EXPLICIT_ADAPTER');
      assert.equal(result.receipt.publicationPerformed,false); assert.equal(result.receipt.nativeAcceptanceEstablished,false);
      assert.equal(result.receipt.sharedAtomicPublication,false); assert.equal(result.receipt.authenticatedOriginEstablished,false);
      assert.equal(f.sourceReads,3); assert.equal(f.inspections,4);
    });
    test('known physical builder scratch is excluded from upload set',f=>{
      fs.mkdirSync(path.join(f.dist,'win-unpacked'));
      fs.writeFileSync(path.join(f.dist,'win-unpacked','fixture.exe'),'not an upload');
      fs.writeFileSync(path.join(f.dist,'builder-debug.yml'),'fixture: debug\n');
      fs.writeFileSync(path.join(f.dist,'builder-effective-config.yaml'),'fixture: config\n');
      const result=build(f.options()); assert.equal(result.manifest.assets.length,9);
      assert.equal(result.manifest.assets.some(item=>item.name.includes('builder')),false);
      assert.equal(fs.existsSync(path.join(f.dist,'win-unpacked','fixture.exe')),true);
    });
    test('existing output is preserved rather than overwritten',f=>{
      const original=Buffer.from('prior interrupted capture'); fs.writeFileSync(f.output,original);
      refuses(f,'output_exists'); assert.deepEqual(fs.readFileSync(f.output),original);
    });
    test('manifest cannot join its own upload set',f=>{
      const target=path.join(f.dist,'release-manifest.json'); refuses(f,'output_inside_dist',{out:target}); assert.equal(fs.existsSync(target),false);
    });
    test('a missing exact required input is refused',f=>{
      fs.unlinkSync(path.join(f.dist,SETUP+'.blockmap')); refuses(f,'required_asset_missing'); assert.equal(fs.existsSync(f.output),false);
    });
    for(const name of ['1132-Fixer-Setup-6.4.0.exe','beta.yml','unexpected.blockmap','private.json']) test('foreign dist entry refused: '+name,f=>{
      fs.writeFileSync(path.join(f.dist,name),'foreign fixture'); refuses(f,'unexpected_dist_entry'); assert.equal(fs.existsSync(f.output),false);
    });
    test('unsafe filenames are refused',f=>{
      fs.writeFileSync(path.join(f.dist,'private notes.txt'),'fixture'); refuses(f,'dist_entry_invalid');
    });
    test('required input cannot be a directory',f=>{
      fs.unlinkSync(path.join(f.dist,SETUP)); fs.mkdirSync(path.join(f.dist,SETUP)); refuses(f,'regular_file_required');
    });
    test('empty required inputs cannot be shipped',f=>{
      fs.writeFileSync(path.join(f.dist,SETUP),Buffer.alloc(0)); refuses(f,'regular_file_required');
    });
    test('input size limits are enforced before reading',f=>{
      refuses(f,'asset_size_invalid',{maxAssetBytes:8}); assert.equal(fs.existsSync(f.output),false);
    });
    test('a hard-linked release input is refused',f=>{
      fs.linkSync(path.join(f.dist,SETUP),path.join(f.root,'alias.exe')); refuses(f,'regular_file_required');
    });
    test('a physical fixture directory junction cannot become dist',f=>{
      const alias=path.join(f.root,'linked-dist'); fs.symlinkSync(f.dist,alias,process.platform==='win32'?'junction':'dir');
      refuses(f,'reparse_path_refused',{dist:alias}); assert.equal(fs.existsSync(f.output),false);
    });
    test('a junction among known scratch is refused, not silently ignored',f=>{
      const target=path.join(f.root,'scratch-target'); fs.mkdirSync(target);
      fs.symlinkSync(target,path.join(f.dist,'win-unpacked'),process.platform==='win32'?'junction':'dir');
      refuses(f,'reparse_path_refused');
    });
    test('a junction output parent is refused',f=>{
      const target=path.join(f.root,'output-target'), alias=path.join(f.root,'output-alias'); fs.mkdirSync(target);
      fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');
      refuses(f,'reparse_path_refused',{out:path.join(alias,'manifest.json')});
    });
    test('exact source HEAD is required',f=>{
      refuses(f,'source_sha_mismatch',{sourceReader:()=>sourceProof(f.root,'2'.repeat(40))});
      assert.equal(fs.existsSync(f.output),false);
    });
    test('unavailable source is not treated as verified',f=>{
      refuses(f,'source_unverified',{sourceReader:()=>({available:false})});
    });
    test('foreign repository cannot bind release source',f=>{
      refuses(f,'source_unverified',{sourceReader:()=>({available:true,repository:'other/windows',root:f.root,head:SOURCE})});
    });
    test('a different checkout root is not accepted',f=>{
      refuses(f,'source_unverified',{sourceReader:()=>({available:true,repository:'1132-Fixer/windows',root:f.dist,head:SOURCE})});
    });
    test('source change between input passes and output refuses capture',f=>{
      let calls=0;
      refuses(f,'source_changed',{sourceReader:()=>sourceProof(f.root,++calls===1?SOURCE:'2'.repeat(40))});
      assert.equal(fs.existsSync(f.output),false);
    });
    test('source change after output preserves the identified failed attempt',f=>{
      let calls=0;
      const error=refuses(f,'source_changed',{sourceReader:()=>sourceProof(f.root,++calls<3?SOURCE:'2'.repeat(40))});
      assert.equal(error.outputCreated,true); assert.equal(error.outputDisposition,'PRESERVED_REQUIRES_READBACK'); assert.equal(fs.existsSync(f.output),true);
      refuses(f,'output_exists');
    });
    test('incomplete path proof is refused',f=>{
      refuses(f,'path_inspection_invalid',{pathInspector:()=>({schema:'1132-release-physical-paths/1',paths:[]})});
    });
    test('unknown Windows reparse evidence is refused',f=>{
      refuses(f,'path_inspection_invalid',{pathInspector:paths=>({schema:'1132-release-physical-paths/1',paths:paths.map(value=>({path:value,nonReparse:false}))})});
    });
    test('same-size content change after first pass is detected',f=>{
      let changed=false;
      refuses(f,['asset_identity_changed','asset_changed'],{onBoundary:event=>{
        if(event.phase==='after-first-pass'&&!changed){changed=true;const bytes=Buffer.from(f.files.get(SETUP));bytes[0]^=1;fs.writeFileSync(path.join(f.dist,SETUP),bytes);}
      }}); assert.equal(fs.existsSync(f.output),false);
    });
    test('same bytes at a replacement file identity cannot authorize capture',f=>{
      refuses(f,['asset_identity_changed','asset_changed'],{onBoundary:event=>{
        if(event.phase==='after-first-pass'){fs.renameSync(path.join(f.dist,SETUP),path.join(f.root,'preserved-original.exe'));fs.writeFileSync(path.join(f.dist,SETUP),f.files.get(SETUP));}
      }}); assert.equal(fs.existsSync(f.output),false);
    });
    test('concurrent extra update metadata invalidates the dist snapshot',f=>{
      refuses(f,'unexpected_dist_entry',{onBoundary:event=>{
        if(event.phase==='after-second-pass')fs.writeFileSync(path.join(f.dist,'alpha.yml'),'foreign fixture');
      }}); assert.equal(fs.existsSync(f.output),false);
    });
    test('last-moment input change cannot be hidden by finished digest passes',f=>{
      const error=refuses(f,['asset_identity_changed','asset_changed','dist_changed'],{onBoundary:event=>{
        if(event.phase==='before-output-open'){const bytes=Buffer.from(f.files.get(PORTABLE));bytes[0]^=1;fs.writeFileSync(path.join(f.dist,PORTABLE),bytes);}
      }});
      if(fs.existsSync(f.output))assert.equal(error.outputDisposition,'PRESERVED_REQUIRES_READBACK');
    });
    test('competing CreateNew output cannot be overwritten',f=>{
      const competing=Buffer.from('competing producer fixture');
      const error=refuses(f,'output_exists',{onBoundary:event=>{
        if(event.phase==='before-output-open')fs.writeFileSync(f.output,competing,{flag:'wx'});
      }}); assert.notEqual(error.outputCreated,true); assert.deepEqual(fs.readFileSync(f.output),competing);
    });
    test('replaced output parent junction is refused before creation',f=>{
      const parent=path.join(f.root,'manifest-parent'), destination=path.join(f.root,'other-target');
      fs.mkdirSync(parent);fs.mkdirSync(destination);
      const target=path.join(parent,'manifest.json');
      refuses(f,'reparse_path_refused',{out:target,onBoundary:event=>{
        if(event.phase==='before-output-open'){
          fs.renameSync(parent,path.join(f.root,'preserved-parent'));
          fs.symlinkSync(destination,parent,process.platform==='win32'?'junction':'dir');
        }
      }});assert.equal(fs.existsSync(path.join(destination,'manifest.json')),false);
    });
    test('same-path real output directory replacement is refused by identity',f=>{
      const parent=path.join(f.root,'manifest-parent');fs.mkdirSync(parent);
      const target=path.join(parent,'manifest.json');
      refuses(f,'directory_identity_changed',{out:target,onBoundary:event=>{
        if(event.phase==='before-output-open'){fs.renameSync(parent,path.join(f.root,'preserved-parent'));fs.mkdirSync(parent);}
      }});assert.equal(fs.existsSync(target),false);
    });
    test('interrupted output is preserved and cannot be blindly replayed',f=>{
      const error=refuses(f,'capture_failed',{onBoundary:event=>{if(event.phase==='output-created')throw new Error('Fixture interruption');}});
      assert.equal(error.outputCreated,true); assert.equal(error.outputDisposition,'PRESERVED_REQUIRES_READBACK');
      assert.equal(fs.statSync(f.output).size,0); refuses(f,'output_exists'); assert.equal(fs.statSync(f.output).size,0);
    });
    test('changed output bytes fail the actual held-file readback',f=>{
      const error=refuses(f,'output_readback_failed',{onBoundary:event=>{
        if(event.phase==='output-written'){const size=fs.statSync(f.output).size;fs.writeFileSync(f.output,Buffer.alloc(size,120));}
      }}); assert.equal(error.outputCreated,true); assert.equal(error.outputDisposition,'PRESERVED_REQUIRES_READBACK');
    });
    test('input mutation after output stays a failed preserved generation',f=>{
      const error=refuses(f,['dist_changed','asset_identity_changed','asset_changed'],{onBoundary:event=>{
        if(event.phase==='before-final-check'){const bytes=Buffer.from(f.files.get(SETUP));bytes[0]^=1;fs.writeFileSync(path.join(f.dist,SETUP),bytes);}
      }}); assert.equal(error.outputCreated,true); assert.equal(error.outputDisposition,'PRESERVED_REQUIRES_READBACK');
    });
    test('final output content is re-read after the last source check',f=>{
      let calls=0;
      const error=refuses(f,['output_readback_failed','output_identity_changed'],{sourceReader:()=>{
        if(++calls===3){const size=fs.statSync(f.output).size;fs.writeFileSync(f.output,Buffer.alloc(size,120));}
        return sourceProof(f.root);
      }});assert.equal(error.outputCreated,true);assert.equal(error.outputDisposition,'PRESERVED_REQUIRES_READBACK');
    });
    test('unresolved asynchronous observer cannot outlive capture authority',f=>{
      refuses(f,'observer_async',{onBoundary:()=>Promise.resolve()}); assert.equal(fs.existsSync(f.output),false);
    });
    for(const tag of ['v6.4.1-beta.1','v06.4.1','6.4.1']) test('stable tag contract refuses '+tag,f=>{
      refuses(f,'stable_tag_required',{tag}); assert.equal(fs.existsSync(f.output),false);
    });
    test('short source SHA is refused before filesystem capture',f=>{
      refuses(f,'source_sha_invalid',{sourceSha:'1'.repeat(7)}); assert.equal(fs.existsSync(f.output),false);
    });
    for(const reason of ['tracked-source-differs-from-head','staged-source-differs-from-head','undeclared-untracked-source'])test('dirty source cannot be labeled as unchanged HEAD: '+reason,f=>{
      refuses(f,'source_dirty',{sourceReader:()=>sourceProof(f.root,SOURCE,{clean:false,cleanReason:reason})});
      assert.equal(fs.existsSync(f.output),false);
    });
    for(const field of ['clean','cleanHead','cleanReason','cleanFingerprint'])test('missing source cleanliness proof refuses capture: '+field,f=>{
      const proof=sourceProof(f.root);delete proof[field];
      refuses(f,'source_clean_unverified',{sourceReader:()=>proof});assert.equal(fs.existsSync(f.output),false);
    });
    test('unknown source cleanliness is not truthy success',f=>{
      refuses(f,'source_clean_unverified',{sourceReader:()=>sourceProof(f.root,SOURCE,{clean:'unknown'})});
    });
    test('clean proof for an older HEAD cannot admit current source',f=>{
      refuses(f,'source_clean_unverified',{sourceReader:()=>sourceProof(f.root,SOURCE,{cleanHead:'2'.repeat(40)})});
    });
    test('clean proof must cover the full tracked and untracked policy',f=>{
      refuses(f,'source_clean_unverified',{sourceReader:()=>sourceProof(f.root,SOURCE,{cleanReason:'git-status-excluded-ignored-files'})});
    });
    test('a changed public build-input fingerprint invalidates capture',f=>{
      let calls=0;
      refuses(f,'source_changed',{sourceReader:()=>sourceProof(f.root,SOURCE,{cleanFingerprint:++calls===1?'a'.repeat(64):'b'.repeat(64)})});
      assert.equal(fs.existsSync(f.output),false);
    });
    test('source becoming dirty before output cannot reuse the initial proof',f=>{
      let calls=0;
      refuses(f,'source_dirty',{sourceReader:()=>sourceProof(f.root,SOURCE,{clean:++calls===1})});assert.equal(fs.existsSync(f.output),false);
    });
    test('source becoming dirty after output preserves a failed generation',f=>{
      let calls=0;
      const error=refuses(f,'source_dirty',{sourceReader:()=>sourceProof(f.root,SOURCE,{clean:++calls<3})});
      assert.equal(error.outputCreated,true);assert.equal(error.outputDisposition,'PRESERVED_REQUIRES_READBACK');refuses(f,'output_exists');
    });
    test('only the explicit dependency/build/output paths are admitted as untracked',f=>{
      const result=checkUntracked({entries:['node_modules/','dist/','release-manifest.json'],sourceRoot:f.root,distPath:f.dist,outputPath:f.output});
      assert.equal(result.clean,true);assert.equal(result.distRelative,'dist');assert.equal(result.outputRelative,'release-manifest.json');
    });
    for(const name of ['ignored.exe','scratch.ps1','.env','src/main/untracked.js','dist-copy/','node_modules-old/','release-manifest.json.old'])test('ignore patterns cannot hide undeclared untracked source: '+name,f=>{
      const result=checkUntracked({entries:[name],sourceRoot:f.root,distPath:f.dist,outputPath:f.output});
      assert.equal(result.clean,false);assert.equal(result.reason,'undeclared-untracked-source');
    });
    test('generated config needs its explicit ignored/untracked/deterministic-byte proof',f=>{
      const input={entries:['src/main/config.generated.js'],sourceRoot:f.root,distPath:f.dist,outputPath:f.output};
      assert.equal(checkUntracked(input).clean,false);
      const proof={ignored:true,untracked:true,bodyVerified:true,sha256:'b'.repeat(64)};
      assert.equal(checkUntracked({...input,generatedConfigProof:proof}).clean,true);
      for(const key of ['ignored','untracked','bodyVerified'])assert.equal(checkUntracked({...input,generatedConfigProof:{...proof,[key]:false}}).clean,false);
    });
    test('untracked traversal and duplicate inventories are rejected',f=>{
      for(const entries of [['../foreign.js'],['/foreign.js'],['node_modules/','node_modules/']])assert.throws(()=>checkUntracked({entries,sourceRoot:f.root,distPath:f.dist,outputPath:f.output}),error=>error.code==='untracked_proof_invalid');
    });
    test('the whole source checkout cannot be declared build scratch',f=>{
      assert.throws(()=>checkUntracked({entries:['src/'],sourceRoot:f.root,distPath:f.root,outputPath:f.output}),error=>error.code==='untracked_policy_invalid');
    });
    assert.deepEqual(attempts,[],'No Git/PowerShell/network/native process is allowed in filesystem fixtures');
  } finally {
    for(const restore of restores.reverse())restore(); syncBuiltinESMExports();
  }
  console.log(`release-manifest-smoke: ${passed} passed, ${failed} failed; owned temporary files and explicit adapters only`);
  if(failed)process.exitCode=1;
})().catch(error=>{
  for(const restore of restores.reverse())restore(); syncBuiltinESMExports();
  console.error('FAIL release-manifest harness: '+error.message);process.exitCode=1;
});
