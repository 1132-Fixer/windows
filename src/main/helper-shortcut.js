'use strict';

// A verified shortcut carrier is not verified standalone Zoom launch. Main
// supplies an already verified delivered app identity and its tracked protected
// Core7 runPSCapture adapter. That adapter owns deadlines and durable custody.
// This module creates no timer, process, launcher script, credential or cleanup.
const path = require('node:path').win32;
const OPEN_HELPER_ZOOM_ARG = '--open-helper-zoom';
const SHORTCUT_TIMEOUT_MS = 15000;
const MAX_REPLY_BYTES = 32768;
const FAILURE_CODES = new Set(['shortcut_app_unverified', 'shortcut_path_unverified', 'shortcut_desktop_unverified',
  'shortcut_existing_unowned', 'shortcut_readback_unverified', 'shortcut_write_failed', 'shortcut_timeout']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const quote = value => "'" + value.replace(/'/g, "''") + "'";
function dataFields(value, allowed, required = allowed) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value')) ||
      required.some(key => !Object.hasOwn(descriptors, key))) return null;
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function component(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f\\\/"<>|?*:%]/.test(value) &&
    !/[. ]$/.test(value) && value !== '.' && value !== '..' && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
}
function canonicalPath(value, rootAllowed = false) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value) return false;
  const parts = value.slice(3).split('\\');
  return rootAllowed && value.length === 3 || parts.every(component);
}
function planRequest(request) {
  const input = dataFields(request, ['app', 'desktopPath', 'shortcutName', 'iconPath']);
  const app = input && dataFields(input.app, ['path', 'sha256', 'verified', 'delivered']);
  if (!input || !app || app.verified !== true || app.delivered !== true || !hash(app.sha256) ||
      !canonicalPath(app.path) || path.extname(app.path).toLowerCase() !== '.exe' ||
      !canonicalPath(input.desktopPath) || !component(input.shortcutName) || path.extname(input.shortcutName).toLowerCase() !== '.lnk' ||
      !canonicalPath(input.iconPath)) return null;
  const workingDirectory = path.dirname(app.path);
  const root = workingDirectory.toLowerCase().replace(/\\$/, '') + '\\';
  if (!input.iconPath.toLowerCase().startsWith(root) || path.extname(input.iconPath).toLowerCase() !== '.ico') return null;
  const shortcutPath = path.join(input.desktopPath, input.shortcutName);
  if (!canonicalPath(shortcutPath)) return null;
  return Object.freeze({ appPath: app.path, appSha256: app.sha256.toLowerCase(), desktopPath: input.desktopPath,
    shortcutPath, iconPath: input.iconPath, iconLocation: input.iconPath + ',0', workingDirectory });
}
function buildScript(plan) {
  return [
    '$appPath=' + quote(plan.appPath), '$expectedAppHash=' + quote(plan.appSha256),
    '$desktopPath=' + quote(plan.desktopPath), '$destination=' + quote(plan.shortcutPath),
    '$iconPath=' + quote(plan.iconPath), '$expectedIcon=' + quote(plan.iconLocation),
    '$workingDirectory=' + quote(plan.workingDirectory), '$fixedArguments=' + quote(OPEN_HELPER_ZOOM_ARG)
  ].join('\n') + '\n' + String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$watch=[Diagnostics.Stopwatch]::StartNew()
$handles=[Collections.Generic.List[IO.FileStream]]::new()
$shell=$null;$link=$null;$result=$null
function Refuse([string]$code){throw [InvalidOperationException]::new($code)}
function Budget {if($watch.ElapsedMilliseconds -ge 12000){Refuse 'shortcut_timeout'}}
function Attributes([string]$value){
  Budget
  try{return [IO.File]::GetAttributes($value)}catch [IO.FileNotFoundException]{return $null}catch [IO.DirectoryNotFoundException]{return $null}
}
function Physical([string]$value,[bool]$directory){
  Budget
  if([IO.Path]::GetFullPath($value) -cne $value){Refuse 'shortcut_path_unverified'}
  $chain=[Collections.Generic.List[string]]::new();$current=$value
  while($true){$chain.Add($current);$parent=[IO.Path]::GetDirectoryName($current);if([string]::IsNullOrEmpty($parent) -or $parent -ceq $current){break};$current=$parent}
  $chain.Reverse()
  for($index=0;$index -lt $chain.Count;$index++){
    $attributes=Attributes $chain[$index]
    $isDirectory=($index -lt $chain.Count-1) -or $directory
    if($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
       (($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $isDirectory){Refuse 'shortcut_path_unverified'}
  }
}
function Read-Guard([string]$value,[bool]$allowMove=$false){
  Physical $value $false
  $share=if($allowMove){[IO.FileShare]::Read -bor [IO.FileShare]::Delete}else{[IO.FileShare]::Read}
  $stream=[IO.File]::Open($value,[IO.FileMode]::Open,[IO.FileAccess]::Read,$share)
  $handles.Add($stream);return $stream
}
function Digest($stream){
  Budget;$stream.Position=0;$sha=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Inspect([string]$value){
  Budget
  $read=$shell.CreateShortcut($value)
  try{return [ordered]@{path=[string]$read.FullName;target=[string]$read.TargetPath;arguments=[string]$read.Arguments;icon=[string]$read.IconLocation;workingDirectory=[string]$read.WorkingDirectory}}
  finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($read)}
}
function Matches($value,[string]$expectedPath){
  return $value.path.Equals($expectedPath,[StringComparison]::OrdinalIgnoreCase) -and
    $value.target.Equals($appPath,[StringComparison]::OrdinalIgnoreCase) -and $value.arguments -ceq $fixedArguments -and
    $value.icon.Equals($expectedIcon,[StringComparison]::OrdinalIgnoreCase) -and
    $value.workingDirectory.Equals($workingDirectory,[StringComparison]::OrdinalIgnoreCase)
}
function Receipt([string]$status,$readback,[string]$digest){
  return [ordered]@{schemaVersion=1;kind='helper-shortcut';status=$status;path=$readback.path;target=$readback.target;arguments=$readback.arguments;icon=$readback.icon;workingDirectory=$readback.workingDirectory;appSha256=$expectedAppHash;shortcutSha256=$digest;appHashVerified=$true;pathVerified=$true;readbackVerified=$true;legacyPreserved=$true}
}
try{
  if(!$IsWindows -or $PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::Is64BitProcess){Refuse 'shortcut_app_unverified'}
  $knownDesktop=[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  if([string]::IsNullOrEmpty($knownDesktop) -or !$knownDesktop.Equals($desktopPath,[StringComparison]::OrdinalIgnoreCase)){Refuse 'shortcut_desktop_unverified'}
  Physical $desktopPath $true;Physical $workingDirectory $true
  $app=Read-Guard $appPath;$icon=Read-Guard $iconPath
  if((Digest $app) -cne $expectedAppHash){Refuse 'shortcut_app_unverified'}
  $shell=New-Object -ComObject WScript.Shell
  if($null -ne (Attributes $destination)){
    $existing=Read-Guard $destination;$observed=Inspect $destination
    if(!(Matches $observed $destination)){Refuse 'shortcut_existing_unowned'}
    $result=Receipt 'current' $observed (Digest $existing)
  }else{
    # Only a unique new candidate is saved. Final Move has no overwrite option.
    $staging=[IO.Path]::Combine($desktopPath,('.1132-fixer-shortcut-'+[Guid]::NewGuid().ToString('N')+'.lnk'))
    if($null -ne (Attributes $staging)){Refuse 'shortcut_existing_unowned'}
    $link=$shell.CreateShortcut($staging)
    $link.TargetPath=$appPath;$link.Arguments=$fixedArguments;$link.IconLocation=$expectedIcon;$link.WorkingDirectory=$workingDirectory
    Budget;$link.Save();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link);$link=$null
    $candidate=Read-Guard $staging $true;$observed=Inspect $staging
    if(!(Matches $observed $staging)){Refuse 'shortcut_readback_unverified'}
    $candidateHash=Digest $candidate
    Physical $desktopPath $true;Budget
    if($null -ne (Attributes $destination)){Refuse 'shortcut_existing_unowned'}
    [IO.File]::Move($staging,$destination)
    $final=Read-Guard $destination;$readback=Inspect $destination
    if(!(Matches $readback $destination) -or (Digest $final) -cne $candidateHash){Refuse 'shortcut_readback_unverified'}
    $result=Receipt 'created' $readback $candidateHash
  }
  Physical $desktopPath $true;Physical $appPath $false;Physical $iconPath $false;Budget
}catch{
  $code=$_.Exception.Message
  if($code -notin @('shortcut_app_unverified','shortcut_path_unverified','shortcut_desktop_unverified','shortcut_existing_unowned','shortcut_readback_unverified','shortcut_timeout')){$code='shortcut_write_failed'}
  $result=[ordered]@{schemaVersion=1;kind='helper-shortcut';status='blocked';reason=$code;legacyPreserved=$true}
}finally{
  foreach($handle in $handles){$handle.Dispose()}
  if($null -ne $link){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)}
  if($null -ne $shell){[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
}
# Never sweep legacy or unverified candidate files, including on failed saves.
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 4 -Compress))
`;
}
const acceptance = Object.freeze({ launchVerified: false, nativeLaunchAcceptance: 'not-verified', requiresNativeLaunchVerification: true });
function failure(reason, custodyUnresolved = false) {
  return { success: false, status: 'blocked', shortcutVerified: false, reason, custodyUnresolved, legacyPreserved: true, ...acceptance };
}
function parseResult(result, plan) {
  if (!record(result) || result.code !== 0 || result.timedOut !== false || result.cleanupConfirmed !== true || result.rootExitConfirmed !== true ||
      result.stdinComplete !== true || result.stdoutTruncated !== false || result.stderrTruncated !== false ||
      !['ok', 'exited'].includes(result.outcome) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
      result.stderr.length || Buffer.byteLength(result.stdout) > MAX_REPLY_BYTES) return failure('shortcut_process_unverified', !record(result) ||
        result.cleanupConfirmed !== true || result.rootExitConfirmed !== true || result.stdinComplete !== true || result.timedOut !== false || !['ok', 'exited'].includes(result.outcome));
  let receipt;
  try { const text=result.stdout.trim();receipt=JSON.parse(text);if(JSON.stringify(receipt)!==text)return failure('shortcut_readback_unverified'); }
  catch (_) { return failure('shortcut_readback_unverified'); }
  if (!record(receipt) || receipt.schemaVersion !== 1 || receipt.kind !== 'helper-shortcut' || receipt.legacyPreserved !== true) return failure('shortcut_readback_unverified');
  if (receipt.status === 'blocked' && FAILURE_CODES.has(receipt.reason) && Object.keys(receipt).length === 5) return failure(receipt.reason);
  const keys = ['schemaVersion','kind','status','path','target','arguments','icon','workingDirectory','appSha256','shortcutSha256',
    'appHashVerified','pathVerified','readbackVerified','legacyPreserved'];
  if (Object.keys(receipt).length !== keys.length || keys.some(key=>!Object.hasOwn(receipt,key)) || !['created','current'].includes(receipt.status) ||
      !samePath(receipt.path,plan.shortcutPath) || !samePath(receipt.target,plan.appPath) || receipt.arguments !== OPEN_HELPER_ZOOM_ARG ||
      !samePath(receipt.icon,plan.iconLocation) || !samePath(receipt.workingDirectory,plan.workingDirectory) || receipt.appSha256 !== plan.appSha256 ||
      !hash(receipt.shortcutSha256) || receipt.appHashVerified !== true || receipt.pathVerified !== true || receipt.readbackVerified !== true) return failure('shortcut_readback_unverified');
  return { success: true, status: receipt.status, shortcutVerified: true, path: plan.shortcutPath, target: plan.appPath,
    arguments: OPEN_HELPER_ZOOM_ARG, shortcutSha256: receipt.shortcutSha256.toLowerCase(), legacyPreserved: true, custodyUnresolved: false, ...acceptance };
}
function createHelperShortcutWriter({ runPSCapture } = {}) {
  if (typeof runPSCapture !== 'function') throw new TypeError('Tracked protected PowerShell 7 runner is required');
  let busy = false;
  let unresolved = false;
  return Object.freeze({ async write(request) {
    if (unresolved) return failure('shortcut_process_unverified', true);
    if (busy) return failure('shortcut_writer_busy');
    let plan;
    try { plan=planRequest(request); } catch (_) { return failure('shortcut_input_invalid'); }
    if (!plan) return failure('shortcut_input_invalid');
    busy = true;
    try {
      const result = parseResult(await runPSCapture(buildScript(plan), { timeoutMs: SHORTCUT_TIMEOUT_MS, maxOutputBytes: MAX_REPLY_BYTES }), plan);
      if (result.custodyUnresolved) unresolved = true;
      return result;
    }
    catch (_) { unresolved = true; return failure('shortcut_process_unverified', true); }
    finally { busy = false; }
  }, hasUnresolvedCustody: () => unresolved });
}
module.exports = { createHelperShortcutWriter, OPEN_HELPER_ZOOM_ARG, SHORTCUT_TIMEOUT_MS, MAX_REPLY_BYTES };
