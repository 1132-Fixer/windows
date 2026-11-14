'use strict';

// Startup evidence only. This read-only observation is never a machine lease
// or permission for a repair effect; the native controller must acquire its
// own exclusive lease and revalidate the target immediately before effects.
const STATE_ROOT = 'C:\\ProgramData\\1132 Fixer\\helper-reset';
const PROBE_TIMEOUT_MS = 8000;
const MAX_AGE_MS = 5000;
const MAX_DOCUMENT_BYTES = 65536;
const MAX_RESULT_BYTES = 16384;
const FULL_CONTROL = 2032127;
const PRINCIPALS = Object.freeze(['S-1-5-18', 'S-1-5-32-544']);
const NAMESPACE_PATHS = Object.freeze(['C:\\', 'C:\\ProgramData', 'C:\\ProgramData\\1132 Fixer', STATE_ROOT]);
const JOURNAL_KEYS = Object.freeze(['status', 'complete', 'schemaVersion', 'operationId', 'generation', 'machineId',
  'accountSid', 'leaseNonce', 'capturedAtMs', 'profilePath', 'phase', 'unresolved', 'storageProtected']);
const LEASE_KEYS = Object.freeze(['status', 'scope', 'exclusive', 'operationId', 'generation', 'machineId', 'machineSid',
  'machineVerified', 'nonce', 'acquiredAtMs', 'expiresAtMs', 'unresolved']);
const BLOCK_REASONS = new Set(['unsupported_host', 'storage_unverified', 'lease_busy', 'journal_busy',
  'state_invalid', 'recovery_changed', 'read_denied', 'probe_timeout', 'probe_unverified']);

// Fixed, maintained, non-effectful script. Root runs it through the protected
// Core7 bootstrap and bounded stdin, not through the native repair worker.
const RECOVERY_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$watch = [Diagnostics.Stopwatch]::StartNew()
$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$streams = [Collections.Generic.List[IO.FileStream]]::new()
$result = [ordered]@{schemaVersion=1;kind='repair-recovery';machineId=[Environment]::MachineName;startedAtMs=$started;capturedAtMs=$started;status='blocked';complete=$false;reason='probe_unverified';namespace=$null;lease=$null;journal=$null}
function Stop-Recovery([string]$code) { throw [InvalidOperationException]::new($code) }
function Check-Budget { if($watch.ElapsedMilliseconds -ge 4000){Stop-Recovery 'probe_timeout'} }
function Read-Attributes([string]$path) {
  Check-Budget
  try { return [IO.File]::GetAttributes($path) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}
function Assert-Kind($attributes,[bool]$directory) {
  if($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
     (($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory){Stop-Recovery 'storage_unverified'}
}
function Read-PrivateAcl($target,[bool]$directory) {
  Check-Budget
  $acl = [IO.FileSystemAclExtensions]::GetAccessControl($target)
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $raw = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if($owner -notin @('S-1-5-18','S-1-5-32-544') -or !$acl.AreAccessRulesProtected -or !$acl.AreAccessRulesCanonical -or $raw.Count -ne 2){Stop-Recovery 'storage_unverified'}
  $rules = [Collections.Generic.List[object]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $inheritance = if($directory){3}else{0}
  foreach($rule in $raw){
    $sid = $rule.IdentityReference.Value
    if($sid -notin @('S-1-5-18','S-1-5-32-544') -or !$seen.Add($sid) -or $rule.AccessControlType -ne 'Allow' -or
       $rule.IsInherited -or [int64]$rule.FileSystemRights -ne 2032127 -or [int]$rule.InheritanceFlags -ne $inheritance -or [int]$rule.PropagationFlags -ne 0){Stop-Recovery 'storage_unverified'}
    $rules.Add([ordered]@{sid=$sid;allow=$true;inherited=$false;rights=2032127;inheritance=$inheritance;propagation=0})
  }
  return [ordered]@{ownerSid=$owner;protected=$true;canonical=$true;rules=$rules.ToArray()}
}
function Read-Namespace {
  $paths = @('C:\','C:\ProgramData','C:\ProgramData\1132 Fixer','C:\ProgramData\1132 Fixer\helper-reset')
  $nodes = [Collections.Generic.List[object]]::new()
  for($index=0;$index -lt $paths.Count;$index++){
    $path=$paths[$index];$attributes=Read-Attributes $path
    if($null -eq $attributes){
      if($index -lt 2){Stop-Recovery 'storage_unverified'}
      return [ordered]@{state='absent';missingPath=$path;nodes=$nodes.ToArray();observation='point-in-time'}
    }
    Assert-Kind $attributes $true
    $acl = if($index -ge 2){Read-PrivateAcl ([IO.DirectoryInfo]::new($path)) $true}else{$null}
    $nodes.Add([ordered]@{path=$path;reparseFree=$true;acl=$acl})
  }
  return [ordered]@{state='present';missingPath=$null;nodes=$nodes.ToArray();observation='point-in-time'}
}
function Read-Document([string]$name,[string]$kind) {
  $path='C:\ProgramData\1132 Fixer\helper-reset\'+$name
  $attributes=Read-Attributes $path
  if($null -eq $attributes){return [ordered]@{state='absent';path=$path;verified=$true}}
  Assert-Kind $attributes $false
  try {$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)}
  catch [IO.IOException] {
    if(($_.Exception.HResult -band 65535) -in @(32,33)){if($kind -eq 'lease'){Stop-Recovery 'lease_busy'}else{Stop-Recovery 'journal_busy'}}
    Stop-Recovery 'recovery_changed'
  }
  $streams.Add($stream)
  $acl=Read-PrivateAcl $stream $false
  if($stream.Length -lt 1 -or $stream.Length -gt 65536){Stop-Recovery 'state_invalid'}
  $length=[int]$stream.Length;$bytes=[byte[]]::new($length);$offset=0
  while($offset -lt $length){Check-Budget;$read=$stream.Read($bytes,$offset,$length-$offset);if($read -lt 1){Stop-Recovery 'state_invalid'};$offset+=$read}
  if($stream.Length -ne $length){Stop-Recovery 'recovery_changed'}
  $document=$null
  try {
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
    if($text.Length -eq 0 -or $text[0] -eq [char]0xfeff){Stop-Recovery 'state_invalid'}
    $jsonOptions=[Text.Json.JsonDocumentOptions]::new();$jsonOptions.MaxDepth=8
    $document=[Text.Json.JsonDocument]::Parse($text,$jsonOptions)
    if($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object){Stop-Recovery 'state_invalid'}
    $keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $allowed=if($kind -eq 'lease'){@('status','scope','exclusive','operationId','generation','machineId','machineSid','machineVerified','nonce','acquiredAtMs','expiresAtMs','unresolved')}else{@('status','complete','schemaVersion','operationId','generation','machineId','accountSid','leaseNonce','capturedAtMs','profilePath','phase','unresolved','storageProtected')}
    foreach($property in $document.RootElement.EnumerateObject()){
      if(!$keys.Add($property.Name) -or $property.Name -cnotin $allowed){Stop-Recovery 'state_invalid'}
      switch($property.Value.ValueKind.ToString()){
        'String' {if($property.Value.GetString().Length -gt 256){Stop-Recovery 'state_invalid'}}
        'Number' {$number=[long]0;if(!$property.Value.TryGetInt64([ref]$number) -or $number -lt 0 -or $number -gt 9007199254740991){Stop-Recovery 'state_invalid'}}
        'True' {}
        'False' {}
        'Null' {}
        default {Stop-Recovery 'state_invalid'}
      }
    }
    $value=ConvertFrom-Json -InputObject $text -AsHashtable -ErrorAction Stop
  } catch {Stop-Recovery 'state_invalid'} finally {if($null -ne $document){$document.Dispose()}}
  return [ordered]@{state='present';path=$path;verified=$true;reparseFree=$true;exclusiveRead=$true;acl=$acl;document=$value}
}
try {
  if(!$IsWindows -or $PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::Is64BitProcess){Stop-Recovery 'unsupported_host'}
  $namespace=Read-Namespace
  # Lease opens first and remains read-only/exclusive until the probe exits.
  $lease=Read-Document 'lease.json' 'lease'
  $journal=Read-Document 'journal.json' 'journal'
  if((ConvertTo-Json $namespace -Depth 12 -Compress) -cne (ConvertTo-Json (Read-Namespace) -Depth 12 -Compress)){Stop-Recovery 'recovery_changed'}
  foreach($item in @($lease,$journal)){
    $attributes=Read-Attributes $item.path
    if($item.state -eq 'absent'){if($null -ne $attributes){Stop-Recovery 'recovery_changed'}}else{Assert-Kind $attributes $false}
  }
  Check-Budget
  $result.status='observed';$result.complete=$true;$result.reason=$null;$result.namespace=$namespace;$result.lease=$lease;$result.journal=$journal
} catch {
  $code=$_.Exception.Message
  if($code -notin @('unsupported_host','storage_unverified','lease_busy','journal_busy','state_invalid','recovery_changed','probe_timeout')){$code='read_denied'}
  $result.reason=$code
} finally {
  foreach($stream in $streams){$stream.Dispose()}
}
$result.capturedAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 14 -Compress))
`;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function validAcl(acl, directory) {
  return exactKeys(acl, ['ownerSid', 'protected', 'canonical', 'rules']) && PRINCIPALS.includes(acl.ownerSid) &&
    acl.protected === true && acl.canonical === true && Array.isArray(acl.rules) && acl.rules.length === 2 &&
    new Set(acl.rules.map(rule => rule && rule.sid)).size === 2 && acl.rules.every(rule =>
      exactKeys(rule, ['sid', 'allow', 'inherited', 'rights', 'inheritance', 'propagation']) && PRINCIPALS.includes(rule.sid) &&
      rule.allow === true && rule.inherited === false && rule.rights === FULL_CONTROL && rule.inheritance === (directory ? 3 : 0) && rule.propagation === 0);
}
function validNamespace(value) {
  if (!exactKeys(value, ['state', 'missingPath', 'nodes', 'observation']) || value.observation !== 'point-in-time' || !Array.isArray(value.nodes)) return false;
  const count = value.state === 'present' && value.missingPath === null ? 4 : value.state === 'absent' ? NAMESPACE_PATHS.indexOf(value.missingPath) : -1;
  return count >= 2 && value.nodes.length === count && value.nodes.every((node, index) =>
    exactKeys(node, ['path', 'reparseFree', 'acl']) && node.path === NAMESPACE_PATHS[index] && node.reparseFree === true &&
    (index < 2 ? node.acl === null : validAcl(node.acl, true)));
}
function validFile(value, name, namespace) {
  if (!record(value) || value.path !== STATE_ROOT + '\\' + name || value.verified !== true) return false;
  if (value.state === 'absent') return exactKeys(value, ['state', 'path', 'verified']);
  return namespace.state === 'present' && exactKeys(value, ['state', 'path', 'verified', 'reparseFree', 'exclusiveRead', 'acl', 'document']) &&
    value.state === 'present' && value.reparseFree === true && value.exclusiveRead === true && validAcl(value.acl, false) && record(value.document);
}
function machineSid(value) {
  return typeof value === 'string' && /^S-1-5-21-(?:0|[1-9]\d*)-(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/.test(value) &&
    value.split('-').slice(4).every(part => Number(part) <= 0xffffffff);
}
function localSid(value, domain) {
  if (typeof value !== 'string' || !value.startsWith(domain + '-')) return false;
  const rid = value.slice(domain.length + 1);
  return /^(?:0|[1-9]\d*)$/.test(rid) && Number(rid) >= 1000 && Number(rid) <= 0xffffffff;
}
function validLease(value, machine, captured) {
  return exactKeys(value, LEASE_KEYS) && value.status === 'held' && value.scope === 'machine' && value.exclusive === true &&
    identifier(value.operationId) && positive(value.generation) && value.machineId === machine && machineSid(value.machineSid) &&
    value.machineVerified === true && identifier(value.nonce) && positive(value.acquiredAtMs) && value.acquiredAtMs <= captured &&
    positive(value.expiresAtMs) && value.expiresAtMs > value.acquiredAtMs && value.expiresAtMs - value.acquiredAtMs === 3600000 &&
    typeof value.unresolved === 'boolean';
}
function validJournal(value, lease, machine, captured) {
  return exactKeys(value, JOURNAL_KEYS) && value.status === 'persisted' && value.complete === true && value.schemaVersion === 1 &&
    value.operationId === lease.operationId && value.generation === lease.generation && value.machineId === machine &&
    localSid(value.accountSid, lease.machineSid) && value.leaseNonce === lease.nonce && positive(value.capturedAtMs) &&
    value.capturedAtMs >= lease.acquiredAtMs && value.capturedAtMs <= captured && value.capturedAtMs <= lease.expiresAtMs &&
    value.profilePath === 'C:\\Users\\user1' && value.phase === 'complete' && value.unresolved === false && value.storageProtected === true;
}

function parseRecoveryProbeResult(processResult, options = {}) {
  const blocked = (reason, verified = false, evidence = null) => ({ status: 'blocked', complete: verified, verified, blocked: true,
    unresolved: true, reason, ...(evidence ? { machineId: evidence.machineId, capturedAtMs: evidence.capturedAtMs } : {}) });
  try {
    if (!record(options) || !identifier(options.expectedMachineId) || !positive(options.nowMs)) return blocked('invalid_probe_context');
    const ttl = options.ttlMs === undefined ? MAX_AGE_MS : options.ttlMs;
    if (!positive(ttl) || ttl > MAX_AGE_MS) return blocked('invalid_probe_context');
    if (!record(processResult) || processResult.code !== 0 || processResult.timedOut !== false || processResult.cleanupConfirmed !== true ||
        processResult.stdinComplete !== true || processResult.stdoutTruncated !== false || processResult.stderrTruncated !== false ||
        !['ok', 'exited'].includes(processResult.outcome) || typeof processResult.stdout !== 'string' ||
        typeof processResult.stderr !== 'string' || processResult.stderr.length !== 0 || Buffer.byteLength(processResult.stdout) > MAX_RESULT_BYTES) return blocked('probe_process_unverified');
    let evidence;
    const text = processResult.stdout.trim();
    try { evidence = JSON.parse(text); if (JSON.stringify(evidence) !== text) return blocked('probe_invalid_json'); }
    catch (_) { return blocked('probe_invalid_json'); }
    if (!exactKeys(evidence, ['schemaVersion', 'kind', 'machineId', 'startedAtMs', 'capturedAtMs', 'status', 'complete', 'reason', 'namespace', 'lease', 'journal']) ||
        evidence.schemaVersion !== 1 || evidence.kind !== 'repair-recovery' || evidence.machineId !== options.expectedMachineId ||
        !positive(evidence.startedAtMs) || !positive(evidence.capturedAtMs) || evidence.startedAtMs > evidence.capturedAtMs ||
        !Number.isSafeInteger(evidence.startedAtMs + ttl) ||
        evidence.capturedAtMs > options.nowMs || options.nowMs - evidence.startedAtMs >= ttl || evidence.capturedAtMs - evidence.startedAtMs >= 4000) return blocked('probe_scope_or_freshness_invalid');
    if (evidence.status === 'blocked' && evidence.complete === false && BLOCK_REASONS.has(evidence.reason) &&
        evidence.namespace === null && evidence.lease === null && evidence.journal === null) return blocked(evidence.reason, false, evidence);
    if (evidence.status !== 'observed' || evidence.complete !== true || evidence.reason !== null || !validNamespace(evidence.namespace) ||
        !validFile(evidence.lease, 'lease.json', evidence.namespace) || !validFile(evidence.journal, 'journal.json', evidence.namespace)) return blocked('probe_evidence_invalid');
    const lease = evidence.lease.state === 'present' ? evidence.lease.document : null;
    const journal = evidence.journal.state === 'present' ? evidence.journal.document : null;
    if (lease && !validLease(lease, evidence.machineId, evidence.capturedAtMs)) return blocked('lease_state_invalid', true, evidence);
    if (lease && lease.unresolved) return blocked('recovery_required', true, evidence);
    if (journal && (!lease || !validJournal(journal, lease, evidence.machineId, evidence.capturedAtMs))) return blocked('journal_state_incomplete', true, evidence);
    return { status: 'clear', complete: true, verified: true, blocked: false, unresolved: false, reason: null,
      machineId: evidence.machineId, capturedAtMs: evidence.capturedAtMs, expiresAtMs: evidence.startedAtMs + ttl,
      namespaceState: evidence.namespace.state, journalState: journal ? 'complete' : 'absent', leaseState: lease ? 'released' : 'absent',
      observation: 'point-in-time', leaseHeld: false };
  } catch (_) { return blocked('probe_evidence_invalid'); }
}

module.exports = { RECOVERY_PROBE_SCRIPT, parseRecoveryProbeResult, STATE_ROOT, PROBE_TIMEOUT_MS, MAX_AGE_MS, MAX_DOCUMENT_BYTES, MAX_RESULT_BYTES };
