'use strict';

// Actual writer module, synthetic tracked runner and COM receipts only.
// No filesystem, shell, COM, process, network or UI operation is performed.
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const restores = [], nativeAttempts = [];
let finished = false, passed = 0, failed = 0;
process.once('beforeExit', () => { if (!finished) { console.error('FAIL helper-shortcut: unfinished async suite'); process.exitCode = 1; } });
class Clock {
  constructor() { this.now = 0; this.serial = 0; this.jobs = new Map(); }
  setTimeout(fn, ms) { const id = ++this.serial; this.jobs.set(id, { fn, at: this.now + ms }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  tick(ms) {
    const end = this.now + ms; let turns = 0;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      assert.ok(++turns < 1000); this.now = next[1].at; this.jobs.delete(next[0]); next[1].fn();
    }
    this.now = end;
  }
}
const clock = new Clock();
const denied = new Set(['fs','fs/promises','child_process','os','electron','net','http','https','worker_threads','timers','timers/promises']);
Module._load = function (name, parent, main) {
  if (denied.has(name.replace(/^node:/,''))) { nativeAttempts.push(name); throw new Error('native dependency denied'); }
  return originalLoad.call(this, name, parent, main);
};
for (const [object,key,replacement] of [[process,'kill'],[process,'exit'],[process,'chdir'],[globalThis,'setTimeout',clock.setTimeout.bind(clock)],
  [globalThis,'clearTimeout',clock.clearTimeout.bind(clock)],[globalThis,'setInterval'],[globalThis,'fetch']]) {
  const original=object[key]; if(typeof original!=='function')continue;
  object[key]=replacement || (()=>{nativeAttempts.push(key);throw new Error('native API denied');});
  restores.push(()=>{object[key]=original;});
}
const api = require('../src/main/helper-shortcut');
const APP = 'C:\\Program Files\\1132 Fixer\\1132 Fixer.exe';
const DIRECTORY = 'C:\\Program Files\\1132 Fixer';
const DESKTOP = "C:\\Users\\O'Brien\\\u6771\u4eac\\Desktop";
const ICON = DIRECTORY + '\\resources\\1132-helper-shortcut.ico';
const NAME = 'Zoom - User1.lnk';
const SHA = 'a'.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
function request() { return { app:{path:APP,sha256:SHA,verified:true,delivered:true}, desktopPath:DESKTOP,shortcutName:NAME,iconPath:ICON }; }
function receipt(status='created') {
  return {schemaVersion:1,kind:'helper-shortcut',status,path:DESKTOP+'\\'+NAME,target:APP,arguments:api.OPEN_HELPER_ZOOM_ARG,
    icon:ICON+',0',workingDirectory:DIRECTORY,appSha256:SHA,shortcutSha256:'b'.repeat(64),
    appHashVerified:true,pathVerified:true,readbackVerified:true,legacyPreserved:true};
}
function processResult(value=receipt()) { return {code:0,timedOut:false,cleanupConfirmed:true,rootExitConfirmed:true,stdinComplete:true,
  stdoutTruncated:false,stderrTruncated:false,outcome:'exited',stdout:JSON.stringify(value)+'\n',stderr:''}; }
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
function fixture(options={}) {
  const calls=[], legacy=new Map([['old-shortcut.lnk',{target:'legacy-target',arguments:'preserve'}]]);
  let cleanupCalls=0;
  const writer=api.createHelperShortcutWriter({runPSCapture:async (script,runOptions)=>{
    calls.push({script,options:runOptions});
    const timer=clock.setTimeout(()=>{throw new Error('runner deadline leaked after completion');},api.SHORTCUT_TIMEOUT_MS);
    if(options.wait){clock.clearTimeout(timer);return options.wait.promise;}
    clock.clearTimeout(timer);
    if(options.throw)throw new Error('private runner exception');
    return options.result ? options.result() : processResult();
  },cleanupLegacy:()=>{cleanupCalls++;legacy.clear();}});
  return {writer,calls,legacy,cleanupCalls:()=>cleanupCalls};
}
async function test(name,invoke) {try{await invoke();passed++;}catch(error){failed++;console.error('FAIL helper-shortcut: '+name+': '+error.message);}}
function unverifiedLaunch(value) {
  assert.equal(value.launchVerified,false);assert.equal(value.nativeLaunchAcceptance,'not-verified');assert.equal(value.requiresNativeLaunchVerification,true);
}
async function rejection(name,mutate) {
  await test(name,async()=>{
    const control=fixture();assert.equal((await control.writer.write(request())).shortcutVerified,true,'baseline ready before mutation');
    const result=processResult();mutate(result);const f=fixture({result:()=>result});const before=JSON.stringify([...f.legacy]);
    const actual=await f.writer.write(request());assert.equal(actual.success,false);unverifiedLaunch(actual);
    assert.equal(f.cleanupCalls(),0);assert.equal(JSON.stringify([...f.legacy]),before);
  });
}
(async()=>{
  await test('factory requires explicit tracked protected runner',()=>{assert.throws(()=>api.createHelperShortcutWriter(),/runner/);});
  await test('verified fixed-action carrier does not claim standalone native acceptance',async()=>{
    const f=fixture();const result=await f.writer.write(request());assert.equal(result.success,true);assert.equal(result.status,'created');
    assert.equal(result.shortcutVerified,true);assert.equal(result.target,APP);assert.equal(result.arguments,'--open-helper-zoom');
    unverifiedLaunch(result);assert.equal(f.calls.length,1);assert.equal(f.cleanupCalls(),0);
    assert.deepEqual(f.calls[0].options,{timeoutMs:api.SHORTCUT_TIMEOUT_MS,maxOutputBytes:api.MAX_REPLY_BYTES});
    assert.equal(clock.jobs.size,0);clock.tick(1000000);assert.deepEqual(nativeAttempts,[]);assert.equal(f.cleanupCalls(),0);
  });
  await test('current exact link is idempotently verified without changing ownership claims',async()=>{
    const f=fixture({result:()=>processResult(receipt('current'))});const result=await f.writer.write(request());
    assert.equal(result.success,true);assert.equal(result.status,'current');assert.equal(result.legacyPreserved,true);unverifiedLaunch(result);
  });
  await test('maintained script uses protected Core guards, exact COM readback and non-overwriting final publication',async()=>{
    const f=fixture();await f.writer.write(request());const script=f.calls[0].script;
    assert.match(script,/\$PSEdition -ne 'Core'/);assert.match(script,/PSVersion\.Major -lt 7/);
    assert.match(script,/DesktopDirectory/);assert.match(script,/FileAttributes\]::ReparsePoint/);
    assert.match(script,/ComputeHash\(\$stream\)/);assert.match(script,/\[IO\.File\]::Move\(\$staging,\$destination\)/);
    assert.match(script,/\$value\.arguments -ceq \$fixedArguments/);assert.match(script,/\$value\.icon\.Equals/);
    const ownership=script.indexOf("Refuse 'shortcut_existing_unowned'"),save=script.indexOf('$link.Save()');
    const finalHash=script.indexOf('(Digest $final) -cne $candidateHash'),move=script.indexOf('::Move($staging,$destination)');
    assert.ok(ownership>=0&&save>=0&&ownership<save);
    assert.ok(finalHash>=0&&move>=0&&finalHash>move);
    assert.doesNotMatch(script,/powershell\.exe|ExecutionPolicy|Bypass|Start-Process|taskkill|Remove-Item|\.Delete\(|PSCredential|helper-credential|\.ps1/i);
  });
  await test('apostrophe and Unicode paths are quoted as literal script data',async()=>{
    const f=fixture();await f.writer.write(request());
    assert.ok(f.calls[0].script.includes("$desktopPath='C:\\Users\\O''Brien\\\u6771\u4eac\\Desktop'"));
    assert.ok(f.calls[0].script.includes("$fixedArguments='--open-helper-zoom'"));
  });
  const inputMutations=[
    value=>{value.app.verified=false;},value=>{value.app.delivered=false;},value=>{delete value.app.sha256;},
    value=>{value.app.path='1132 Fixer.exe';},value=>{value.app.path='\\\\server\\share\\Fixer.exe';},
    value=>{value.app.path='C:\\App\\..\\Fixer.exe';},value=>{value.app.path='C:\\App\\Fixer.exe:stream';},
    value=>{value.app.path='C:\\App\\CON.exe';},value=>{value.desktopPath='C:\\Users\\%USER%\\Desktop';},
    value=>{value.shortcutName='..\\foreign.lnk';},value=>{value.shortcutName='foreign.url';},
    value=>{value.shortcutName='foreign .lnk ';},value=>{value.iconPath='C:\\Unrelated\\icon.ico';},
    value=>{value.arguments='--arbitrary';},value=>{value.script='arbitrary';},value=>{value.app.sha256='not-a-hash';}
  ];
  for(const mutate of inputMutations)await test('invalid, unverified or configurable command input never reaches runner',async()=>{
    const f=fixture(),input=request();mutate(input);const result=await f.writer.write(input);
    assert.equal(result.reason,'shortcut_input_invalid');assert.equal(f.calls.length,0);assert.equal(f.cleanupCalls(),0);unverifiedLaunch(result);
  });
  await test('input accessors are refused without invoking them',async()=>{
    const f=fixture(),input=request();let reads=0;Object.defineProperty(input,'desktopPath',{get(){reads++;return DESKTOP;},enumerable:true});
    assert.equal((await f.writer.write(input)).success,false);assert.equal(reads,0);assert.equal(f.calls.length,0);
  });
  await test('caller mutation after dispatch cannot alter expected readback or script',async()=>{
    const wait=deferred(),f=fixture({wait}),input=request();const pending=f.writer.write(input);
    input.app.path='C:\\Other\\foreign.exe';input.shortcutName='foreign.lnk';wait.resolve(processResult());
    const result=await pending;assert.equal(result.target,APP);assert.equal(result.path,DESKTOP+'\\'+NAME);
  });
  for(const [field,value]of Object.entries({code:1,timedOut:true,cleanupConfirmed:false,rootExitConfirmed:false,stdinComplete:false,
    stdoutTruncated:true,stderrTruncated:true,outcome:'exit-unclosed',stderr:'private stderr'})){
    await rejection('unverified runner '+field+' cannot certify shortcut or clean legacy',result=>{result[field]=value;});
  }
  const readbackMutations=[
    value=>{value.path=DESKTOP+'\\foreign.lnk';},value=>{value.target='C:\\Other\\Fixer.exe';},
    value=>{value.arguments='--open-helper-zoom --arbitrary';},value=>{value.icon='C:\\Other\\icon.ico,0';},
    value=>{value.workingDirectory='C:\\Other';},value=>{value.appSha256='c'.repeat(64);},
    value=>{value.shortcutSha256='invalid';},value=>{value.appHashVerified=false;},value=>{value.pathVerified=false;},
    value=>{value.readbackVerified=false;},value=>{value.legacyPreserved=false;},value=>{value.status='launched';},
    value=>{value.extra='unknown';},value=>{delete value.icon;}
  ];
  for(const mutate of readbackMutations)await rejection('mismatched or partial COM readback stays blocked',result=>{
    const value=receipt();mutate(value);result.stdout=JSON.stringify(value)+'\n';
  });
  for(const stdout of ['','{bad}',JSON.stringify(receipt())+'\n'+JSON.stringify(receipt()),
    JSON.stringify(receipt()).replace('{','{"schemaVersion":1,'),'x'.repeat(api.MAX_REPLY_BYTES+1)]){
    await rejection('missing, malformed, duplicate, multi-frame or oversized readback never succeeds',result=>{result.stdout=stdout;});
  }
  await test('unknown existing link is preserved and failure is useful',async()=>{
    const f=fixture({result:()=>processResult({schemaVersion:1,kind:'helper-shortcut',status:'blocked',reason:'shortcut_existing_unowned',legacyPreserved:true})});
    const before=JSON.stringify([...f.legacy]);const result=await f.writer.write(request());
    assert.equal(result.reason,'shortcut_existing_unowned');assert.equal(result.success,false);assert.equal(f.cleanupCalls(),0);
    assert.equal(JSON.stringify([...f.legacy]),before);unverifiedLaunch(result);
  });
  await test('unknown native error text never escapes result',async()=>{
    const f=fixture({result:()=>processResult({schemaVersion:1,kind:'helper-shortcut',status:'blocked',reason:'private native exception',legacyPreserved:true})});
    const result=await f.writer.write(request());assert.equal(result.reason,'shortcut_readback_unverified');assert.equal(JSON.stringify(result).includes('private'),false);
  });
  await test('concurrent write cannot dispatch another Save',async()=>{
    const wait=deferred(),f=fixture({wait});const first=f.writer.write(request());
    assert.equal((await f.writer.write(request())).reason,'shortcut_writer_busy');assert.equal(f.calls.length,1);
    wait.resolve(processResult());assert.equal((await first).success,true);
  });
  for(const mode of ['throw','timeout'])await test('uncertain '+mode+' latches local custody and never retries or cleans legacy',async()=>{
    const f=fixture(mode==='throw'?{throw:true}:{result:()=>({...processResult(),timedOut:true,cleanupConfirmed:false,outcome:'timeout'})});
    const result=await f.writer.write(request());assert.equal(result.success,false);assert.equal(result.custodyUnresolved,true);
    assert.equal(f.writer.hasUnresolvedCustody(),true);assert.equal((await f.writer.write(request())).success,false);
    assert.equal(f.calls.length,1);assert.equal(f.cleanupCalls(),0);clock.tick(1000000);assert.equal(clock.jobs.size,0);
  });
  await test('no native dependency/API or delayed timer remains',()=>{assert.deepEqual(nativeAttempts,[]);assert.equal(clock.jobs.size,0);});
  Module._load=originalLoad;for(const restore of restores.reverse())restore();
  console.log('helper-shortcut-smoke: '+passed+' passed, '+failed+' failed; inert tracked-runner/COM receipts only');
  if(failed)process.exitCode=1;finished=true;
})().catch(error=>{
  Module._load=originalLoad;for(const restore of restores.reverse())restore();
  console.error('FAIL helper-shortcut harness:',error.message);process.exitCode=1;finished=true;
});
