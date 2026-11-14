'use strict';

// Inert transport/credential tests only. Never start a child, inspect Windows,
// submit network traffic, or operate on an account/profile/service.
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const forbidden = [];
Module._load = function (name, parent, main) {
  if (/^(?:node:)?(?:fs|child_process|os|http|https|net|tls)$/.test(name) || name === 'electron') {
    forbidden.push(name); throw new Error('native adapter smoke attempted effects');
  }
  return originalLoad.call(this, name, parent, main);
};
let api;
try { api = require('../src/main/helper-reset-windows'); } finally { Module._load = originalLoad; }
const { createHelperResetWindows, WINDOWS_WORKER_SOURCE, WINDOWS_WORKER_SHA256, WORKFLOW_COMMANDS } = api;
const { BOOTSTRAP_ARGS } = require('../src/main/windows-repair-transport');
const { REQUIRED_ADAPTERS } = require('../src/main/helper-reset-controller');
const crypto = require('node:crypto');
const TARGET = 'C:\\Users\\user1';
const SID = 'S-1-5-21-111-222-333-1003';
const SECRET = 'synthetic-test-password-32-characters';
const CIPHERTEXT = Buffer.from('inert synthetic ciphertext bytes, not DPAPI output').toString('base64');
const CIPHERTEXT_SHA256 = crypto.createHash('sha256').update(Buffer.from(CIPHERTEXT, 'base64')).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
let passed = 0, failed = 0, finished = false;
process.once('beforeExit', () => {
  if (!finished) { console.error('FAIL helper-reset-windows: harness did not finish'); process.exitCode = 1; }
});
function context(sid = SID) {
  return { operation: { id: 'repair-a', generation: 1, machineId: 'machine-a',
    machineSid: 'S-1-5-21-111-222-333', accountName: 'user1', accountSid: sid, leaseNonce: 'lease-a' },
  lease: { nonce: 'lease-a', acquiredAtMs: 900, expiresAtMs: 20000 }, profilePath: TARGET };
}
function fixture() {
  const packets = [], starts = [], retained = [], credentialCalls = [];
  let secret = SECRET, time = 1100, closed = 0;
  const state = { retained: false };
  const proof = (c, extra = {}) => ({ status: 'verified', complete: true,
    operationId: c.operation.id, generation: c.operation.generation, machineId: c.operation.machineId,
    leaseNonce: c.operation.leaseNonce, accountSid: c.operation.accountSid,
    capturedAtMs: 1000, profilePath: TARGET, ...extra });
  const info = { protocolVersion: 1, scriptSha256: WINDOWS_WORKER_SHA256, workerNonce: 'worker-a',
    machineId: 'machine-a', shell: { major: 7, edition: 'Core', is64Bit: true }, storageProtected: true,
    capabilities: { atomicIdentityExpectation: true, exclusiveProfileCreation: true, completePurgeReadback: true } };
  const session = {
    info: () => copy(info), state: () => ({ ...state }),
    retainCustody(reason) { state.retained = true; retained.push(reason); },
    async request(packet, options) {
      // Keep a structured copy as a fake transport would serialize immediately.
      packets.push({ packet: copy(packet), options: copy(options) });
      const c = packet.context;
      let result;
      if (packet.command === 'inspectRecovery') result = { status: 'clear', complete: true, blocked: false,
        storageProtected: true, machineId: 'machine-a', operatorSid: 'S-1-5-21-111-222-333-1002',
        operatorProfilePath: 'C:\\Users\\operator', currentUserProtected: true, currentUserProfilePathVerified: true };
      else if (packet.command === 'acquireLease') result = { status: 'held', scope: 'machine', exclusive: true,
        operationId: c.operation.id, generation: c.operation.generation, machineId: c.operation.machineId,
        machineVerified: true, machineSid: c.operation.machineSid, nonce: 'lease-a', acquiredAtMs: 1000, expiresAtMs: 20000 };
      else if (packet.command === 'createDisabledAccount') result = proof(c, { accountSid: SID,
        created: true, disabled: true, isLocal: true, accountName: 'user1', currentUserProtected: true });
      else if (packet.command === 'captureResetSnapshot') result = { schemaVersion: 1, operation: copy(c.operation), probes: {} };
      else if (packet.command.startsWith('workflow-')) result = proof(c, { verified: true,
        step: packet.command.slice('workflow-'.length), registeredSid: SID, registeredPath: TARGET,
        operatorSid: 'S-1-5-21-111-222-333-1002', operatorProfilePath: 'C:\\Users\\operator', currentUserProtected: true });
      else result = proof(c);
      if (['createDisabledAccount', 'enableAccount', 'verifyProvisionedState'].includes(packet.command)) Object.assign(result, {
        usersGroupSid: 'S-1-5-32-545', usersMembershipVerified: true, administratorsExcluded: true,
        groupEnumerationComplete: true, standardAccountVerified: true, membershipProofKind: 'raw-local-sid'
      });
      if (packet.command === 'workflow-seal-credential') Object.assign(result, {
        ciphertext: CIPHERTEXT, protection: 'DPAPI-CurrentUser', binding: {
          operatorSid: result.operatorSid, operatorProfilePath: result.operatorProfilePath,
          accountSid: c.operation.accountSid, profilePath: TARGET, operationId: c.operation.id,
          generation: c.operation.generation, machineId: c.operation.machineId, machineSid: c.operation.machineSid
        }
      });
      if (packet.command === 'workflow-persist-credential') Object.assign(result, {
        stored: true, readbackVerified: true, storageProtected: true, ownerVerified: true, formatVersion: 2, protection: 'DPAPI-CurrentUser',
        path: 'C:\\Users\\operator\\AppData\\Roaming\\1132 Fixer\\helper-credentials-v2\\repair-a.json',
        credentialPath: 'C:\\Users\\operator\\AppData\\Roaming\\1132 Fixer\\helper-credentials-v2\\repair-a.json',
        ciphertextSha256: CIPHERTEXT_SHA256
      });
      if (f.mutate) result = f.mutate(result, packet);
      return f.response ? f.response(result, packet) : { ok: true, completed: true, result };
    },
    async close() { closed++; return { ok: true, completed: true, result: { status: 'closed', complete: true, leaseHeld: false } }; }
  };
  const f = { packets, starts, retained, info, session, credentialCalls,
    mutate: null, response: null,
    setSecret(value) { secret = value; }, setTime(value) { time = value; },
    get closed() { return closed; },
    options: {
      transport: { async start(config) { starts.push(copy(config)); return session; } },
      credentials: { async withPassword(c, callback) { credentialCalls.push(copy(c)); return callback(secret); } },
      expectedMachineId: 'machine-a', now: () => time,
      admission: { verified: true, kind: 'recovery-probe', machineId: 'machine-a', token: 'admit-a' }
    }
  };
  return f;
}

const EXISTING_SID = 'S-1-5-21-111-222-333-1001';
function admissionResult(c, kind = 'bound-existing') {
  const value = { status: 'verified', complete: true, operationId: c.operation.id, generation: c.operation.generation,
    machineId: c.operation.machineId, leaseNonce: c.operation.leaseNonce, accountSid: EXISTING_SID,
    capturedAtMs: 1000, profilePath: TARGET, kind, accountName: 'user1', isLocal: true,
    accountLookupComplete: true, currentUserProtected: true, currentUserSid: 'S-1-5-21-111-222-333-1002',
    currentUserProfilePath: 'C:\\Users\\operator', currentUserProfilePathVerified: true,
    profilesRoot: 'C:\\Users', profilesRootVerified: true, ancestorsReparseFree: true,
    profileNamespaceComplete: true, profileNamespaceVerified: true, profileNamespaceProofKind: 'complete-profile-metadata',
    unknownProfileCount: 0, observedUnknownProfileCount: 0, foreignProfileConflictCount: 0, targetProfileConflictCount: 0,
    namespaceBlockers: [], profileConflictEvidence: [], profileOwnershipVerified: true };
  if (kind === 'fresh-absent') return { ...value, accountSid: null, accountExists: false, profileExists: false, registeredProfileCount: 0 };
  Object.assign(value, { accountExists: true, profileExists: true, registeredProfileCount: 1,
    registeredSid: EXISTING_SID, registeredPath: TARGET, builtin: false, protected: false, special: false,
    enabled: true, leafReparseFree: true });
  if (kind === 'bound-existing') value.binding = { verified: true, storageProtected: true, ownerVerified: true,
    machineId: c.operation.machineId, machineSid: c.operation.machineSid, accountName: 'user1',
    accountSid: EXISTING_SID, profilePath: TARGET };
  return value;
}
function admissionTransport(f, kind = 'bound-existing', mutate) {
  f.response = (_result, packet) => {
    const result = admissionResult(packet.context, kind);
    if (mutate) mutate(result);
    return { ok: true, completed: true, result };
  };
}

async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS helper-reset-windows: ' + name); }
  catch (error) { failed++; console.error('FAIL helper-reset-windows: ' + name + ': ' + error.message); }
}
async function rejectsCode(promise, code) { await assert.rejects(promise, error => error && error.code === code); }
async function provision(f) {
  const native = await createHelperResetWindows(f.options);
  await native.adapters.createDisabledAccount(context(null));
  return native;
}

function powerShellNegativeTests() {
  function sourceFunction(name) {
    const escaped = name.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
    const match = WINDOWS_WORKER_SOURCE.match(new RegExp('^function ' + escaped + '\\([^\\n]*\\) \\{[\\s\\S]*?^\\}', 'm'));
    if (!match) throw new Error('Pure native guard function missing: ' + name);
    return match[0];
  }
  const functions = ['Resolve-InternalProfileLink', 'Assert-Expected', 'Assert-QuarantinedExpected',
    'Profile-Value', 'Profile-True', 'Profile-CanonicalSid', 'Normalize-ProfilePath', 'Profile-PathRelation',
    'Profile-NamespaceIssue', 'Classify-ProfileNamespace', 'Assert-ProfileNamespace', 'Set-ProfileNamespaceProof',
    'Resolve-BuiltinAlias', 'Read-StandardAccountFacts', 'Assert-StandardAccount',
    'Ensure-StandardAccountMembership', 'Set-StandardAccountProof']
    .map(sourceFunction).join('\n').replaceAll('[FixerResetNativeV1]', '[FixerResetNegativeTestOnly20261105]')
    .replaceAll('Microsoft.PowerShell.LocalAccounts\\Get-LocalGroup', 'Invoke-FakeGetLocalGroup')
    .replaceAll('Microsoft.PowerShell.LocalAccounts\\Add-LocalGroupMember', 'Invoke-FakeUsersAdd');
  // This output contains only the actual guard functions, inert mocks
  // and a fake managed metadata verifier. No worker bootstrap, P/Invoke,
  // filesystem operation, account command, service or process launch exists.
  const definition = String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -ne 7 -or !$IsWindows){throw 'PowerShell 7 on Windows required for Windows lexical path semantics'}
if(!('FixerResetNegativeTestOnly20261105' -as [type])){
  Add-Type -TypeDefinition @'
using System;
public static class FixerResetNegativeTestOnly20261105 {
  public static int Calls; public static bool Mismatch;
  public static string[] Users,Admins,Effective;public static bool GroupReadUnknown;
  public static string[] ReadLocalGroupSids(string name){
    if(GroupReadUnknown)throw new InvalidOperationException("standard_account_unverified");
    if(name=="Users")return Users;if(name=="Administrators")return Admins;throw new InvalidOperationException("unknown alias");
  }
  public static string[] ReadUserLocalGroups(string user){if(user!="user1")throw new InvalidOperationException("wrong user");return Effective;}
  public static void VerifyQuarantine(string path,string sid,uint volume,string fileId) {
    Calls++;if(Mismatch)throw new InvalidOperationException("identity_mismatch");
  }
}
'@
}
$script:Target='C:\Users\user1'
$script:StateRoot='C:\ProgramData\1132 Fixer\helper-reset'
function Deny([string]$code){throw [InvalidOperationException]::new($code)}
function Millis{return $script:Clock}
function ExactPath($value){return $value -is [string] -and $value.Equals($script:Target,[StringComparison]::OrdinalIgnoreCase)}
function Assert-Context($c){}
function Owned-Journal($c){return $script:J}
function Current-Profile{return @{sid=$script:OperatorSid;path='C:\Users\operator'}}
function Local-Account{
  $script:SamCalls++
  if($script:SamCalls -eq 2){$script:Clock+=$script:FinalSamDelay}
  if($script:SamCalls -eq 2 -and $script:SamSidChanges){$script:Account.SID.Value+='9'}
  return $script:Account
}
function Invoke-FakeGetLocalGroup {
  [CmdletBinding()]param($SID)
  $script:AliasCalls++;$name=if($SID.Value -eq 'S-1-5-32-545'){'Users'}elseif($SID.Value -eq 'S-1-5-32-544'){'Administrators'}else{throw 'unexpected alias SID'}
  if($script:AliasChanges -and $script:AliasCalls -ge 3){$name+='-changed'}
  return @{SID=$SID;Name=$name}
}
function Invoke-FakeUsersAdd {
  [CmdletBinding()]param($SID,$Member)
  if($SID.Value -cne 'S-1-5-32-545' -or $Member.SID.Value -cne $script:CreatedSid -or $Member.Enabled){throw 'unsafe fake group write'}
  $script:GroupAdds++
  [FixerResetNegativeTestOnly20261105]::Users=@([FixerResetNegativeTestOnly20261105]::Users)+@($Member.SID.Value)
  [FixerResetNegativeTestOnly20261105]::Effective=@('Users')
}
function Write-State($name,$value){if($name -cne 'journal.json'){throw 'unexpected fake write'};$script:Writes++}
function Read-Binding($sid){return @{accountSid=$sid}}
function Profile-Facts($sid){return $script:P}
function Session-Facts($sid){return $script:S}
function Process-Facts($sid){return $script:Q}
function Assert-Tree{}
` + functions + String.raw`
function Reset-Case {
  $script:Clock=1000L;$script:SamCalls=0;$script:FinalSamDelay=0L
  $script:MachineSid='S-1-5-21-111-222-333'
  $script:Lease=@{nonce='lease-a';expiresAtMs=20000L}
  $script:CreatedSid=$null;$script:EffectsStarted=$false
  $script:OperatorSid='S-1-5-21-111-222-333-1002';$script:SamSidChanges=$false
  $script:AliasCalls=0;$script:AliasChanges=$false;$script:GroupAdds=0;$script:Writes=0
  $script:Account=@{SID=@{Value='S-1-5-21-111-222-333-1003'};Enabled=$false}
  $script:J=@{phase='purging-profile';quarantineState='purge-intent';quarantinePath=$script:StateRoot+'\purge-lease-a';quarantineVolume=7;quarantineFileId='0000000100000002'}
  $script:P=@{exists=$false;owned=$true;hiveLoaded=$false;cim=@(@{SID=$script:Account.SID.Value;LocalPath=$script:Target;Loaded=$false;Special=$false});registrations=@(@{sid=$script:Account.SID.Value;path=$script:Target});namespaceComplete=$true;namespaceVerified=$true;namespaceProofKind='complete-profile-metadata';unknownProfileCount=0;foreignProfileConflictCount=0;targetProfileConflictCount=0;namespaceBlockers=@()}
  $script:S=@{active=0;unknown=0};$script:Q=@{processes=@();unknown=0}
  $script:C=@{operation=@{id='repair-a';generation=1;machineId='machine-a';machineSid=$script:MachineSid;accountSid=$script:Account.SID.Value;accountName='user1';leaseNonce='lease-a'};expected=@{accountSid=$script:Account.SID.Value;accountName='user1';profilePath=$script:Target;state='disabled-bound-account-profile-unloaded'}}
  [FixerResetNegativeTestOnly20261105]::Calls=0;[FixerResetNegativeTestOnly20261105]::Mismatch=$false
  [FixerResetNegativeTestOnly20261105]::Users=@($script:Account.SID.Value)
  [FixerResetNegativeTestOnly20261105]::Admins=@();[FixerResetNegativeTestOnly20261105]::Effective=@('Users')
  [FixerResetNegativeTestOnly20261105]::GroupReadUnknown=$false
}
$script:Passed=0
function Check([string]$name,[scriptblock]$action,[bool]$expected){
  $accepted=$false;$reason=''
  try{&$action;$accepted=$true}catch{$reason=$_.Exception.Message}
  if($accepted -ne $expected){throw ($name+': unexpected acceptance='+$accepted+' '+$reason)}
  $script:Passed++;Write-Output ('PASS helper-reset-windows-pure: '+$name)
}
$links=@(
  @{name='absolute internal';parent='C:\Users\user1\AppData';target='C:\Users\user1\AppData\Roaming';ok=$true},
  @{name='absolute dotdot escape';parent='C:\Users\user1\AppData';target='C:\Users\user1\..\operator';ok=$false},
  @{name='absolute normalized internal';parent='C:\Users\user1\AppData';target='C:\Users\user1\AppData\..\Roaming';ok=$true},
  @{name='prefix neighbor';parent='C:\Users\user1\AppData';target='C:\Users\user10\AppData';ok=$false},
  @{name='UNC';parent='C:\Users\user1\AppData';target='\\server\share\user1';ok=$false},
  @{name='extended device';parent='C:\Users\user1\AppData';target='\\?\C:\Users\user1\AppData';ok=$false},
  @{name='DOS device';parent='C:\Users\user1\AppData';target='\\.\C:\Users\user1\AppData';ok=$false},
  @{name='NT namespace';parent='C:\Users\user1\AppData';target='\??\C:\Users\user1\AppData';ok=$false},
  @{name='absolute ADS';parent='C:\Users\user1\AppData';target='C:\Users\user1\AppData:stream';ok=$false},
  @{name='relative ADS';parent='C:\Users\user1\AppData';target='file:stream';ok=$false},
  @{name='relative internal';parent='C:\Users\user1\AppData\Local';target='..\Roaming';ok=$true},
  @{name='relative outside';parent='C:\Users\user1\AppData';target='..\..\operator';ok=$false},
  @{name='relative child';parent='C:\Users\user1\AppData';target='.\Cache';ok=$true},
  @{name='drive relative';parent='C:\Users\user1\AppData';target='C:Cache';ok=$false},
  @{name='root relative';parent='C:\Users\user1\AppData';target='\Users\user1\Cache';ok=$false},
  @{name='reserved CON';parent='C:\Users\user1\AppData';target='CON';ok=$false},
  @{name='reserved COM extension';parent='C:\Users\user1\AppData';target='COM1.log';ok=$false},
  @{name='trailing dot';parent='C:\Users\user1\AppData';target='Cache.\file';ok=$false},
  @{name='trailing space';parent='C:\Users\user1\AppData';target='Cache \file';ok=$false},
  @{name='self-root cycle';parent='C:\Users\user1\AppData';target='C:\Users\user1';ok=$false}
)
foreach($case in $links){Check $case.name { [void](Resolve-InternalProfileLink $case.parent $case.target) } $case.ok}
Reset-Case
$script:J.phase='fencing-account';$script:C.expected.state='bound-existing-account'
Check 'fresh final-SAM guard positive' {Assert-Expected $script:C 'fenceAccount'} $true
Reset-Case
$script:J.phase='fencing-account';$script:C.expected.state='bound-existing-account';$script:FinalSamDelay=5000L
Check 'final SAM stall invalidates older proofs' {Assert-Expected $script:C 'fenceAccount'} $false
Reset-Case
Check 'quarantine fresh positive' {Assert-QuarantinedExpected $script:C} $true
if([FixerResetNegativeTestOnly20261105]::Calls -ne 1){throw 'fake metadata verifier was not reached'}
$mutations=@(
  @{name='missing durable purge intent';mutate={$script:J.quarantineState='quarantined'}},
  @{name='foreign quarantine path';mutate={$script:J.quarantinePath+='-other'}},
  @{name='wrong durable phase';mutate={$script:J.phase='creating-account'}},
  @{name='canonical path recreated';mutate={$script:P.exists=$true}},
  @{name='loaded profile';mutate={$script:P.cim[0].Loaded=$true}},
  @{name='hive loaded';mutate={$script:P.hiveLoaded=$true}},
  @{name='unknown process ownership';mutate={$script:Q.unknown=1}},
  @{name='active target session';mutate={$script:S.active=1}},
  @{name='unknown session ownership';mutate={$script:S.unknown=1}},
  @{name='account reenabled';mutate={$script:Account.Enabled=$true}},
  @{name='account SID changed';mutate={$script:Account.SID.Value+='9'}},
  @{name='registered SID changed';mutate={$script:P.registrations[0].sid+='9'}},
  @{name='registered path changed';mutate={$script:P.registrations[0].path+='-other'}},
  @{name='native handle identity mismatch';mutate={[FixerResetNegativeTestOnly20261105]::Mismatch=$true}},
  @{name='expired lease';mutate={$script:Lease.expiresAtMs=1000L}},
  @{name='last SAM read stalls';mutate={$script:FinalSamDelay=5000L}}
)
foreach($case in $mutations){
  Reset-Case;&$case.mutate;$script:FakePurges=0
  Check $case.name {Assert-QuarantinedExpected $script:C;$script:FakePurges++} $false
  if($script:FakePurges -ne 0){throw ($case.name+': unsafe fake purge admission')}
}
function Reset-RoleCase {
  Reset-Case;$script:CreatedSid=$script:Account.SID.Value;$script:J.phase='creating-account'
  $script:J.newAccountSid=$script:CreatedSid;$script:C.operation.accountSid=$null
}
Reset-RoleCase
Check 'existing Users member causes zero group writes' {[void](Ensure-StandardAccountMembership $script:C $script:CreatedSid)} $true
if($script:GroupAdds -ne 0 -or $script:Writes -ne 0){throw 'existing membership was rewritten'}
Reset-RoleCase
[FixerResetNegativeTestOnly20261105]::Users=@('S-1-5-21-999-888-777-4444');[FixerResetNegativeTestOnly20261105]::Effective=@()
Check 'new disabled SID add preserves orphan and unrelated members' {[void](Ensure-StandardAccountMembership $script:C $script:CreatedSid)} $true
if($script:GroupAdds -ne 1 -or [FixerResetNegativeTestOnly20261105]::Users.Count -ne 2 -or
  'S-1-5-21-999-888-777-4444' -notin [FixerResetNegativeTestOnly20261105]::Users){throw 'unrelated member lost or duplicate add'}
$roleMutations=@(
  @{name='enabled account cannot receive group mutation';mutate={$script:Account.Enabled=$true}},
  @{name='unowned created SID cannot receive group mutation';mutate={$script:CreatedSid='S-1-5-21-111-222-333-1999'}},
  @{name='foreign journal new SID cannot receive group mutation';mutate={$script:J.newAccountSid='S-1-5-21-111-222-333-1999'}},
  @{name='current user cannot receive group mutation';mutate={$script:OperatorSid=$script:CreatedSid}},
  @{name='direct Administrator SID blocks helper';mutate={[FixerResetNegativeTestOnly20261105]::Admins=@($script:CreatedSid)}},
  @{name='indirect Administrators membership blocks helper';mutate={[FixerResetNegativeTestOnly20261105]::Effective=@('Users','Administrators')}},
  @{name='unavailable raw SID enumeration blocks helper';mutate={[FixerResetNegativeTestOnly20261105]::GroupReadUnknown=$true}},
  @{name='builtin alias identity change blocks helper';mutate={$script:AliasChanges=$true}},
  @{name='final SAM SID change blocks helper';mutate={$script:SamSidChanges=$true}},
  @{name='final SAM stall invalidates role proof';mutate={$script:FinalSamDelay=5000L}}
)
foreach($case in $roleMutations){
  Reset-RoleCase;&$case.mutate
  Check $case.name {[void](Ensure-StandardAccountMembership $script:C $script:J.newAccountSid)} $false
  if($script:GroupAdds -ne 0){throw ($case.name+': unsafe fake group mutation')}
}

function Add-NamespacePair($inventory,[string]$sid,[string]$path,[int]$status=0,[bool]$special=$false,[bool]$loaded=$false) {
  $inventory.cimRecords+=@{source='cim';readComplete=$true;sid=$sid;rawPath=$path;status=$status;special=$special;loaded=$loaded}
  $inventory.registryRecords+=@{source='registry';readComplete=$true;key=$sid;rawPath=$path;valueKind='ExpandString'}
}
function New-NamespaceInventory([bool]$targetPresent=$true) {
  $inventory=@{cimComplete=$true;registryComplete=$true;configurationComplete=$true;cimRecords=@();registryRecords=@();
    environment=@{systemroot='C:\Windows';windir='C:\Windows';systemdrive='C:';programdata='C:\ProgramData'};
    configurationRecords=@(
      @{source='configuration';readComplete=$true;name='Default';rawPath='%SystemDrive%\Users\Default';valueKind='ExpandString'},
      @{source='configuration';readComplete=$true;name='Public';rawPath='C:\Users\Public';valueKind='String'},
      @{source='configuration';readComplete=$true;name='ProgramData';rawPath='C:\ProgramData';valueKind='String'},
      @{source='configuration';readComplete=$true;name='ProfilesDirectory';rawPath='C:\Users';valueKind='String'}
    )}
  Add-NamespacePair $inventory 'S-1-5-18' 'C:\Windows\System32\config\systemprofile' 0 $true $true
  $inventory.registryRecords[-1].rawPath='%SystemRoot%\System32\config\systemprofile'
  Add-NamespacePair $inventory 'S-1-5-21-111-222-333-1002' 'C:\Users\operator' 0 $false $true
  if($targetPresent){Add-NamespacePair $inventory 'S-1-5-21-111-222-333-1003' 'C:\Users\user1'}
  return $inventory
}
function Assert-NamespaceCondition([bool]$ok,[string]$reason){if(!$ok){throw $reason}}
function Attach-NamespaceFacts($classification){
  $script:P.namespaceComplete=$classification.complete;$script:P.namespaceVerified=$classification.verified;$script:P.namespaceProofKind=$classification.proofKind
  foreach($name in @('unknownProfileCount','foreignProfileConflictCount','targetProfileConflictCount')){$script:P[$name]=$classification[$name]}
  $script:P.namespaceBlockers=$classification.blockers
}
$namespaceSid='S-1-5-21-111-222-333-1003'
Reset-Case
Check 'complete metadata admits absent target and unrelated loaded special profiles' {
  $result=Classify-ProfileNamespace $namespaceSid (New-NamespaceInventory $false)
  Assert-NamespaceCondition ($result.verified -and $result.complete -and $result.cim.Count -eq 0 -and $result.unknownProfileCount -eq 0) 'known unrelated inventory blocked'
} $true
Check 'exact target pair and machine-expanded system path are admitted' {
  $result=Classify-ProfileNamespace $namespaceSid (New-NamespaceInventory)
  Assert-NamespaceCondition ($result.verified -and $result.cim.Count -eq 1 -and $result.registrations.Count -eq 1 -and $result.foreignProfileConflictCount -eq 0) 'canonical target inventory not proven'
  Assert-NamespaceCondition ($result.proofKind -ceq 'complete-profile-metadata') 'physical nonoverlap was claimed'
} $true
Check 'user10 sibling and separator/case aliases remain unrelated' {
  $inventory=New-NamespaceInventory;Add-NamespacePair $inventory 'S-1-5-21-111-222-333-1010' 'C:/Users/user10'
  $inventory.registryRecords[-1].rawPath='c:\USERS\USER10\'
  Assert-NamespaceCondition (Classify-ProfileNamespace $namespaceSid $inventory).verified 'user10 falsely overlapped'
} $true
Check 'known unrelated status flags do not become target failure' {
  $inventory=New-NamespaceInventory;Add-NamespacePair $inventory 'S-1-5-21-111-222-333-1011' 'C:\Users\foreign' 8 $false $false
  Assert-NamespaceCondition (Classify-ProfileNamespace $namespaceSid $inventory).verified 'known unrelated corrupted status blocked'
} $true
Check 'canonical target metadata plus owned quarantine scope allows known configuration containers' {
  $result=Classify-ProfileNamespace $namespaceSid (New-NamespaceInventory) ($script:StateRoot+'\purge-lease-a')
  Assert-NamespaceCondition $result.verified 'ProgramData configuration mistaken for foreign profile'
} $true
Check 'classifier is deterministic and does not mutate inventory input' {
  $inventory=New-NamespaceInventory
  $before=ConvertTo-Json -InputObject $inventory -Depth 12 -Compress
  $first=Classify-ProfileNamespace $namespaceSid $inventory;$second=Classify-ProfileNamespace $namespaceSid $inventory
  Assert-NamespaceCondition ((ConvertTo-Json -InputObject $inventory -Depth 12 -Compress) -ceq $before) 'classifier mutated input'
  Assert-NamespaceCondition ((ConvertTo-Json -InputObject $first -Depth 12 -Compress) -ceq (ConvertTo-Json -InputObject $second -Depth 12 -Compress)) 'classification nondeterministic'
} $true
$namespaceCases=@(
  @{name='foreign ancestor C Users';mutate={param($i) Add-NamespacePair $i 'S-1-5-21-111-222-333-1050' 'C:\Users'};foreign=$true},
  @{name='foreign descendant under user1';mutate={param($i) Add-NamespacePair $i 'S-1-5-21-111-222-333-1051' 'C:\Users\user1\foreign'};foreign=$true},
  @{name='foreign exact target mapping';mutate={param($i) Add-NamespacePair $i 'S-1-5-21-111-222-333-1052' 'C:\Users\user1'};foreign=$true},
  @{name='duplicate CIM target SID';mutate={param($i) $i.cimRecords+=,$i.cimRecords[-1].Clone()}},
  @{name='duplicate registry target SID';mutate={param($i) $i.registryRecords+=,$i.registryRecords[-1].Clone()}},
  @{name='target backup registration';mutate={param($i) $i.registryRecords[-1].key+='.bak'}},
  @{name='unrelated backup registration is explicitly unknown';mutate={param($i) $i.registryRecords[1].key+='.bak'}},
  @{name='same SID cross-source path conflict';mutate={param($i) $i.registryRecords[-1].rawPath='C:\Users\elsewhere'}},
  @{name='same target SID points outside canonical profile';mutate={param($i) $i.cimRecords[-1].rawPath='C:\Users\elsewhere';$i.registryRecords[-1].rawPath='C:\Users\elsewhere'}},
  @{name='missing registry profile path';mutate={param($i) $i.registryRecords[-1].rawPath=$null}},
  @{name='missing CIM profile path';mutate={param($i) $i.cimRecords[-1].rawPath=$null}},
  @{name='CIM provider whole inventory failure';mutate={param($i) $i.cimComplete=$false};unbounded=$true},
  @{name='registry whole inventory failure';mutate={param($i) $i.registryComplete=$false};unbounded=$true},
  @{name='registry record read denied';mutate={param($i) $i.registryRecords[-1].readComplete=$false}},
  @{name='unknown path variable';mutate={param($i) $i.registryRecords[-1].rawPath='%UNRESOLVED%\user1'}},
  @{name='user-scoped path variable not expanded as operator';mutate={param($i) $i.registryRecords[-1].rawPath='%USERPROFILE%'}},
  @{name='malformed profile SID';mutate={param($i) $i.cimRecords[-1].sid='unresolved-name'}},
  @{name='unsupported CIM status';mutate={param($i) $i.cimRecords[-1].status=16}},
  @{name='wrong CIM status type';mutate={param($i) $i.cimRecords[-1].status='0'}},
  @{name='wrong CIM loaded type';mutate={param($i) $i.cimRecords[-1].loaded='false'}},
  @{name='target special system profile rejected';mutate={param($i) $i.cimRecords[-1].special=$true}},
  @{name='target temporary status rejected';mutate={param($i) $i.cimRecords[-1].status=1}},
  @{name='unpaired foreign profile record';mutate={param($i) $i.registryRecords=$i.registryRecords[0..0]+$i.registryRecords[2..2]}},
  @{name='Default template overlaps helper path';mutate={param($i) $i.configurationRecords[0].rawPath='C:\Users\user1\Default'}},
  @{name='missing mandatory configuration snapshot';mutate={param($i) $i.configurationRecords=$i.configurationRecords[1..3]};unbounded=$true},
  @{name='registry path wrong value kind';mutate={param($i) $i.registryRecords[-1].valueKind='Binary'}},
  @{name='wrong provenance source';mutate={param($i) $i.cimRecords[-1].source='untrusted'}},
  @{name='string true cannot prove enumeration';mutate={param($i) $i.cimComplete='true'};unbounded=$true},
  @{name='ADS namespace ambiguity';mutate={param($i) $i.registryRecords[-1].rawPath='C:\Users\user1:stream'}},
  @{name='UNC profile ambiguity';mutate={param($i) $i.registryRecords[-1].rawPath='\\server\users\user1'}},
  @{name='extended device path ambiguity';mutate={param($i) $i.registryRecords[-1].rawPath='\\?\C:\Users\user1'}},
  @{name='trailing dot path ambiguity';mutate={param($i) $i.registryRecords[-1].rawPath='C:\Users\user1.'}},
  @{name='8 dot 3 unresolved physical alias';mutate={param($i) $i.registryRecords[-1].rawPath='C:\Users\USER1~1'}},
  @{name='foreign profile at quarantine destination';mutate={param($i) Add-NamespacePair $i 'S-1-5-21-111-222-333-1060' 'C:\ProgramData\1132 Fixer\helper-reset\purge-lease-a'};foreign=$true;quarantine=$true},
  @{name='foreign ancestor of quarantine destination';mutate={param($i) Add-NamespacePair $i 'S-1-5-21-111-222-333-1061' 'C:\ProgramData\1132 Fixer'};foreign=$true;quarantine=$true}
)
foreach($case in $namespaceCases){
  Reset-Case;$inventory=New-NamespaceInventory;&$case.mutate $inventory
  $quarantine=if($case.ContainsKey('quarantine')){$script:StateRoot+'\purge-lease-a'}else{$null}
  $classification=Classify-ProfileNamespace $namespaceSid $inventory $quarantine
  Check ($case.name+' is blocked') {Assert-NamespaceCondition (!$classification.verified) 'namespace falsely verified'} $true
  if($case.ContainsKey('foreign')){Assert-NamespaceCondition ($classification.foreignProfileConflictCount -gt 0) 'foreign overlap omitted'}
  if($case.ContainsKey('unbounded')){Assert-NamespaceCondition ($null -eq $classification.unknownProfileCount) 'unknown coverage quantity invented'}
  foreach($entry in $classification.evidence){Assert-NamespaceCondition (!$entry.ContainsKey('sid') -and !$entry.ContainsKey('path')) 'foreign personal metadata leaked in evidence'}
  Attach-NamespaceFacts $classification
  $script:J.phase='fencing-account';$script:C.expected.state='bound-existing-account';$script:UnsafeEffects=0
  Check ($case.name+' admits zero effects') {Assert-Expected $script:C 'fenceAccount';$script:UnsafeEffects++} $false
  Assert-NamespaceCondition ($script:UnsafeEffects -eq 0) 'unknown namespace admitted effect'
}

Write-Output ('helper-reset-windows pure guards: '+$script:Passed+' passed; native effects not run.')
`;
  const unit = crypto.createHash('sha256').update(definition).digest('hex').slice(0, 12);
  return definition.replaceAll('FixerResetNegativeTestOnly20261105', 'FixerResetNegativeTest' + unit);
}


const MANAGED_PRIVILEGE_FAKE = String.raw`
public static class __TEST__ {
  sealed class FakeApi : __NATIVE__.IProfilePrivilegeApi {
    public Dictionary<long,uint> State=new Dictionary<long,uint>{{11,0u},{12,1u},{99,0x80000002u}};
    public readonly List<Dictionary<long,uint>> Requests=new List<Dictionary<long,uint>>();
    public int Opens,Closes,Reads;
    public bool Partial,EnableFalse,RestoreFalse,RestoreMismatch,EnabledReadMismatch,UnknownPrevious,ThrowAfterPartial,CloseFails;
    public IntPtr OpenOwnProcessToken(){Opens++;return new IntPtr(123);}
    public long Lookup(string name){if(name=="SeBackupPrivilege")return 11;if(name=="SeRestorePrivilege")return 12;throw new Exception("unexpected privilege");}
    public Dictionary<long,uint> Read(IntPtr token){
      Reads++;var result=new Dictionary<long,uint>(State);
      if(EnabledReadMismatch && Reads==2)result[12]=1u;
      return result;
    }
    public __NATIVE__.PrivilegeAdjustment Adjust(IntPtr token,Dictionary<long,uint> requested){
      Requests.Add(new Dictionary<long,uint>(requested));
      bool enabling=Requests.Count==1;
      if(!enabling && RestoreFalse)return new __NATIVE__.PrivilegeAdjustment{Success=false,Error=5,PreviousValid=true,Previous=new Dictionary<long,uint>()};
      var previous=new Dictionary<long,uint>();int count=0;
      foreach(var item in requested){
        if(item.Key!=11 && item.Key!=12)throw new Exception("unrelated privilege was adjusted");
        if(!State.ContainsKey(item.Key))continue;
        if(enabling && (Partial || ThrowAfterPartial) && count>=1)break;
        if(State[item.Key]!=item.Value){previous[item.Key]=State[item.Key];State[item.Key]=item.Value;}
        count++;
      }
      if(enabling && ThrowAfterPartial)throw new Exception("unknown partial native outcome");
      if(!enabling && RestoreMismatch)State[11]|=2u;
      return new __NATIVE__.PrivilegeAdjustment{Success=!(enabling && EnableFalse),Error=enabling && (Partial || EnableFalse)?1300:0,PreviousValid=!UnknownPrevious,Previous=previous};
    }
    public void CloseOwnToken(IntPtr token){if(CloseFails)throw new Exception("close uncertain");Closes++;}
  }

  sealed class FakeGroups : __NATIVE__.IGroupMemberApi {
    public readonly List<__NATIVE__.GroupMemberPage> Pages=new List<__NATIVE__.GroupMemberPage>();
    public readonly List<ulong> Cursors=new List<ulong>();
    public __NATIVE__.GroupMemberPage ReadPage(string group,ulong resume){
      Cursors.Add(resume);if(Cursors.Count>Pages.Count)throw new Exception("reader exceeded supplied pages");return Pages[Cursors.Count-1];
    }
  }
  static __NATIVE__.GroupMemberPage Page(int status,ulong cursor,params string[] sids){
    return new __NATIVE__.GroupMemberPage{Status=status,Resume=cursor,Sids=sids,BufferVerified=true};
  }
  static __NATIVE__.StandardTokenSnapshot StandardToken(){
    return new __NATIVE__.StandardTokenSnapshot{UserSid="S-1-5-21-111-222-333-1003",Elevation=0,ElevationType=1,
      Groups=new Dictionary<string,uint>{{"S-1-5-32-545",7u},{"S-1-1-0",7u},{"S-1-5-11",7u}}};
  }
  static void RoleChecks(){
    const string target="S-1-5-21-111-222-333-1003",orphan="S-1-5-21-999-888-777-4444";
    Check("raw SID membership retains unresolved orphan without name lookup",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(0,0,target,orphan));
      string[] result=__NATIVE__.ReadLocalGroupSids("localized-users",api);
      Require(result.Length==2 && Array.IndexOf(result,orphan)>=0 && api.Cursors.Count==1,"orphan SID lost");
    });
    Check("ERROR_MORE_DATA continues through exact resume before complete",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(234,17,target));api.Pages.Add(Page(0,0,orphan));
      var result=__NATIVE__.ReadLocalGroupSids("localized-users",api);
      Require(result.Length==2 && api.Cursors.Count==2 && api.Cursors[1]==17,"partial page treated complete");
    });
    Check("empty successful raw membership remains known empty",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(0,0));
      Require(__NATIVE__.ReadLocalGroupSids("localized-users",api).Length==0,"empty result fabricated members");
    });
    Check("access denied is unknown and never empty-safe",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(5,0));
      Failure(delegate{__NATIVE__.ReadLocalGroupSids("localized-users",api);});
    });
    Check("unverified/truncated SID page blocks completion",delegate{
      var api=new FakeGroups();var page=Page(0,0,target);page.BufferVerified=false;api.Pages.Add(page);
      Failure(delegate{__NATIVE__.ReadLocalGroupSids("localized-users",api);});
    });
    Check("more-data without progress is blocked",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(234,0,target));
      Failure(delegate{__NATIVE__.ReadLocalGroupSids("localized-users",api);});
      Require(api.Cursors.Count==1,"stalled resume retried");
    });
    Check("empty more-data page cannot authorize absence",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(234,17));
      Failure(delegate{__NATIVE__.ReadLocalGroupSids("localized-users",api);});
    });
    Check("duplicate SID across pages indicates unstable enumeration",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(234,17,target));api.Pages.Add(Page(0,0,target));
      Failure(delegate{__NATIVE__.ReadLocalGroupSids("localized-users",api);});
    });
    Check("partial enumeration followed by error remains unknown",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(234,17,target));api.Pages.Add(Page(5,0));
      Failure(delegate{__NATIVE__.ReadLocalGroupSids("localized-users",api);});
      Require(api.Cursors.Count==2,"second-page error hidden");
    });
    Check("malformed SID is never resolved by account-name fallback",delegate{
      var api=new FakeGroups();api.Pages.Add(Page(0,0,"unknown-account-name"));
      Failure(delegate{__NATIVE__.ReadLocalGroupSids("localized-users",api);});
    });
    Check("standard non-elevated Users token admitted",delegate{
      __NATIVE__.VerifyStandardTokenSnapshot(target,StandardToken());
    });
    Check("deny-only Administrators SID is still forbidden",delegate{
      var token=StandardToken();token.Groups["S-1-5-32-544"]=16;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
    Check("enabled Administrators SID is forbidden",delegate{
      var token=StandardToken();token.Groups["S-1-5-32-544"]=7;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
    Check("full elevation type is forbidden without relying on group display",delegate{
      var token=StandardToken();token.ElevationType=2;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
    Check("limited split token is forbidden even if admin SID absent",delegate{
      var token=StandardToken();token.ElevationType=3;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
    Check("elevated flag is forbidden independently of type",delegate{
      var token=StandardToken();token.Elevation=1;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
    Check("disabled or deny-only Users cannot claim standard",delegate{
      var token=StandardToken();token.Groups["S-1-5-32-545"]=16;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
      token.Groups["S-1-5-32-545"]=0;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
    Check("missing Users or unknown token fields remain blocked",delegate{
      var token=StandardToken();token.Groups.Remove("S-1-5-32-545");
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
      token=StandardToken();token.ElevationType=0;
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
    Check("foreign token SID cannot become this operation helper",delegate{
      var token=StandardToken();token.UserSid="S-1-5-21-111-222-333-1002";
      Failure(delegate{__NATIVE__.VerifyStandardTokenSnapshot(target,token);});
    });
  }

  static int passed;
  static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
  static void Fresh(){__NATIVE__.PrivilegeCustodyUnresolved=false;}
  static void Check(string name,Action action){Fresh();action();passed++;Console.WriteLine("PASS helper-reset-privileges-managed: "+name);}
  static Exception Failure(Action action){try{action();}catch(Exception error){return error;}throw new Exception("expected failure");}
  public static void Run() {
    passed=0;
    Check("both assigned disabled: temporary enable then exact restore",delegate{
      var api=new FakeApi();var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      scope.Execute(delegate{Require(api.State[11]==2 && api.State[12]==3,"targets not enabled");Require(api.State[99]==0x80000002u,"unrelated attributes changed");});
      Require(api.State[11]==0 && api.State[12]==1 && api.State[99]==0x80000002u,"original attributes not restored");
      Require(scope.RestorationVerified && !scope.Unresolved && !scope.OwnsToken && api.Closes==1,"clean close not proven");
      Require(api.Requests.Count==2 && api.Requests[0].Count==2 && api.Requests[1][12]==1,"previous-state restore not exact");
    });
    Check("already enabled flags never toggled",delegate{
      var api=new FakeApi();api.State[11]=2;api.State[12]=3;
      var scope=new __NATIVE__.ProfilePrivilegeScope(api);int bodies=0;
      scope.Execute(delegate{bodies++;});
      Require(bodies==1 && api.Requests.Count==0 && api.State[11]==2 && api.State[12]==3 && api.Closes==1,"already-enabled state changed");
    });
    Check("one enabled target remains untouched",delegate{
      var api=new FakeApi();api.State[11]=3;
      var scope=new __NATIVE__.ProfilePrivilegeScope(api);scope.Execute(delegate{});
      Require(api.Requests.Count==2 && api.Requests[0].Count==1 && !api.Requests[0].ContainsKey(11) && !api.Requests[1].ContainsKey(11),"enabled target adjusted");
      Require(api.State[11]==3 && api.State[12]==1,"one-target restoration mismatch");
    });
    Check("missing assigned privilege blocks before any adjustment/body",delegate{
      var api=new FakeApi();api.State.Remove(12);int bodies=0;
      var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      var error=Failure(delegate{scope.Execute(delegate{bodies++;});});
      Require(error.Message=="profile_privileges_unavailable" && bodies==0 && api.Requests.Count==0 && api.Closes==1 && scope.RestorationVerified,"missing privilege was enabled or leaked");
    });
    Check("unsupported target flags block before mutation",delegate{
      var api=new FakeApi();api.State[12]=4;var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      Failure(delegate{scope.Execute(delegate{throw new Exception("body must not run");});});
      Require(api.Requests.Count==0 && scope.RestorationVerified && api.State[12]==4,"removed flag modified");
    });
    Check("TRUE ERROR_NOT_ALL_ASSIGNED restores partial previous state",delegate{
      var api=new FakeApi{Partial=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);int bodies=0;
      var error=Failure(delegate{scope.Execute(delegate{bodies++;});});
      Require(error.Message=="profile_privileges_unavailable" && bodies==0 && scope.RestorationVerified,"partial enable treated as success");
      Require(api.Requests.Count==2 && api.Requests[1].Count==1 && api.State[11]==0 && api.State[12]==1,"partial previous state not restored");
    });
    Check("FALSE partial outcome also restores returned changes",delegate{
      var api=new FakeApi{Partial=true,EnableFalse=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      Failure(delegate{scope.Execute(delegate{throw new Exception("body must not run");});});
      Require(scope.RestorationVerified && api.Requests.Count==2 && api.State[11]==0 && api.State[12]==1,"failed partial enable not restored");
    });
    Check("enabled readback mismatch refuses body and restores",delegate{
      var api=new FakeApi{EnabledReadMismatch=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);int bodies=0;
      Failure(delegate{scope.Execute(delegate{bodies++;});});
      Require(bodies==0 && scope.RestorationVerified && api.State[11]==0 && api.State[12]==1,"bad enable readback admitted");
    });
    Check("unknown previous state retains token and sticky custody",delegate{
      var api=new FakeApi{Partial=true,UnknownPrevious=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      var error=Failure(delegate{scope.Execute(delegate{throw new Exception("body must not run");});});
      Require(error.Message=="profile_privilege_restore_unverified" && scope.Unresolved && scope.OwnsToken && api.Closes==0 && __NATIVE__.PrivilegeCustodyUnresolved,"unknown prior state cleared");
      int adjustments=api.Requests.Count;Failure(delegate{scope.Dispose();});Require(api.Requests.Count==adjustments,"unknown restoration retried");
    });
    Check("thrown partial native outcome never invents changed-state authority",delegate{
      var api=new FakeApi{ThrowAfterPartial=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      Failure(delegate{scope.Execute(delegate{throw new Exception("body must not run");});});
      Require(scope.Unresolved && scope.OwnsToken && api.Requests.Count==1 && __NATIVE__.PrivilegeCustodyUnresolved,"unknown partial outcome guessed restored");
    });
    Check("restoration failure retains owned token and blocks future custody",delegate{
      var api=new FakeApi{RestoreFalse=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      var error=Failure(delegate{scope.Execute(delegate{});});
      Require(error.Message=="profile_privilege_restore_unverified" && scope.Unresolved && scope.OwnsToken && !scope.RestorationVerified && __NATIVE__.PrivilegeCustodyUnresolved,"restore failure cleared");
    });
    Check("TRUE restoration with wrong readback is never accepted",delegate{
      var api=new FakeApi{RestoreMismatch=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      Failure(delegate{scope.Execute(delegate{});});
      Require(scope.Unresolved && !scope.RestorationVerified && api.Closes==0,"mismatched restore accepted");
    });
    Check("body error with successful restoration preserves original error",delegate{
      var api=new FakeApi();var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      var error=Failure(delegate{scope.Execute(delegate{throw new Exception("synthetic body failure");});});
      Require(error.Message=="synthetic body failure" && scope.RestorationVerified && api.Closes==1,"body error erased or restore skipped");
    });
    Check("body error plus restore error remain linked under sticky failure",delegate{
      var api=new FakeApi{RestoreFalse=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      var error=Failure(delegate{scope.Execute(delegate{throw new Exception("synthetic body failure");});});
      var aggregate=error.InnerException as AggregateException;
      Require(error.Message=="profile_privilege_restore_unverified" && aggregate!=null && aggregate.InnerExceptions[0].Message=="synthetic body failure" && scope.Unresolved,"body/restore evidence lost");
    });
    Check("normal disposal is idempotent without extra native adjustments",delegate{
      var api=new FakeApi();var scope=new __NATIVE__.ProfilePrivilegeScope(api);scope.Execute(delegate{});
      int adjusts=api.Requests.Count,reads=api.Reads;scope.Dispose();scope.Dispose();
      Require(api.Requests.Count==adjusts && api.Reads==reads && api.Closes==1,"disposal replayed operations");
    });
    Check("token-close uncertainty never becomes clean custody",delegate{
      var api=new FakeApi{CloseFails=true};var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      Failure(delegate{scope.Execute(delegate{});});
      Require(scope.Unresolved && !scope.RestorationVerified && scope.OwnsToken && __NATIVE__.PrivilegeCustodyUnresolved,"close uncertainty cleared");
    });
    Check("unrelated mutation is detected without modifying unrelated rights",delegate{
      var api=new FakeApi();var scope=new __NATIVE__.ProfilePrivilegeScope(api);
      Failure(delegate{scope.Execute(delegate{api.State[99]=7;});});
      Require(scope.Unresolved && api.State[99]==7,"unrelated state was overwritten");
      foreach(var request in api.Requests)Require(!request.ContainsKey(99),"unrelated right was adjusted");
    });
    RoleChecks();
    Console.WriteLine("helper-reset privilege + standard-role model: "+passed+" passed; native APIs not called.");
  }
}
`;

function managedPrivilegeTests() {
  const native = WINDOWS_WORKER_SOURCE.match(/\$nativeSource = @'\n([\s\S]*?)\n'@/)[1];
  const unit = crypto.createHash('sha256').update(native + '\n' + MANAGED_PRIVILEGE_FAKE).digest('hex').slice(0, 12);
  const nativeName = 'FixerResetPrivilegeUnit' + unit;
  const testName = 'FixerResetPrivilegeChecks' + unit;
  const definition = native.replaceAll('FixerResetNativeV1', nativeName) + '\n' +
    MANAGED_PRIVILEGE_FAKE.replaceAll('__NATIVE__', nativeName).replaceAll('__TEST__', testName);
  // Compilation loads declarations only. The sole invoked method is our
  // managed model: every scope receives FakeApi, never NativeProfilePrivilegeApi.
  return "$ErrorActionPreference='Stop'\n" +
    "if($PSVersionTable.PSVersion.Major -ne 7){throw 'PowerShell 7 required'}\n" +
    "if(!('" + testName + "' -as [type])){\n" +
    "$definition=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
    Buffer.from(definition, 'utf8').toString('base64') + "'))\n" +
    "Add-Type -TypeDefinition $definition -ErrorAction Stop\n}\n[" + testName + "]::Run()\n";
}


if (process.argv.includes('--managed-privilege-tests') || process.argv.includes('--managed-native-tests')) {
  finished = true;
  process.stdout.write(managedPrivilegeTests());
} else if (process.argv.includes('--powershell-negative-tests')) {
  finished = true;
  process.stdout.write(powerShellNegativeTests());
} else (async () => {
  await test('import has no native effects and maintained bootstrap is exact', async () => {
    assert.deepEqual(forbidden, []);
    assert.equal(crypto.createHash('sha256').update(WINDOWS_WORKER_SOURCE).digest('hex'), WINDOWS_WORKER_SHA256);
    const f = fixture(); const native = await createHelperResetWindows(f.options);
    assert.equal(f.starts.length, 1);
    assert.equal(Buffer.from(f.starts[0].bootstrapLine, 'base64').toString('utf8'), WINDOWS_WORKER_SOURCE);
    assert.deepEqual(f.starts[0].startArgs, BOOTSTRAP_ARGS);
    assert.equal(f.starts[0].scriptSha256, WINDOWS_WORKER_SHA256);
    assert.equal(JSON.stringify(f.starts).includes(SECRET), false);
    assert.equal(BOOTSTRAP_ARGS.join(' ').includes('Bypass'), false);
    assert.deepEqual(REQUIRED_ADAPTERS.filter(name => typeof native.adapters[name] !== 'function'), []);
    assert.equal(Object.isFrozen(native.adapters.capabilities), true);
  });
  await test('no default transport, credentials, authority or capability', async () => {
    await rejectsCode(createHelperResetWindows(), 'native_configuration_invalid');
    for (const key of ['transport', 'credentials', 'admission', 'expectedMachineId']) {
      const f = fixture(); f.options[key] = null;
      await rejectsCode(createHelperResetWindows(f.options), 'native_configuration_invalid');
      assert.equal(f.starts.length, 0);
    }
    for (const key of ['atomicIdentityExpectation', 'exclusiveProfileCreation', 'completePurgeReadback']) {
      const f = fixture(); f.info.capabilities[key] = false;
      await rejectsCode(createHelperResetWindows(f.options), 'native_handshake_unverified');
      assert.equal(f.packets.length, 0); assert.equal(f.retained.length, 1);
    }
  });
  await test('foreign machine/source/shell/storage handshakes retain owned custody', async () => {
    for (const edit of [
      info => { info.machineId = 'another-machine'; }, info => { info.scriptSha256 = '0'.repeat(64); },
      info => { info.shell.major = 5; }, info => { info.shell.edition = 'Desktop'; },
      info => { info.shell.is64Bit = false; }, info => { info.storageProtected = false; }
    ]) {
      const f = fixture(); edit(f.info);
      await rejectsCode(createHelperResetWindows(f.options), 'native_handshake_unverified');
      assert.equal(f.packets.length, 0); assert.equal(f.retained.length, 1);
    }
  });
  await test('recovery inspection is read-only, scoped and does not request a secret', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    const result = await native.inspectRecovery();
    assert.equal(result.blocked, false);
    assert.equal(result.currentUserProtected, true);
    assert.equal(f.packets[0].packet.command, 'inspectRecovery');
    assert.equal(Object.hasOwn(f.packets[0].packet, 'secret'), false);
    assert.equal(f.credentialCalls.length, 0);
  });
  await test('actual JS adapter admits verified existing local SID from initial null Admission', async () => {
    for (const command of ['inspectAdmission', 'revalidateAdmission']) {
      for (const kind of ['bound-existing', 'operator-target']) {
        const f = fixture(), native = await createHelperResetWindows(f.options); admissionTransport(f, kind);
        const result = await native.adapters[command](context(null));
        assert.equal(result.accountSid, EXISTING_SID); assert.equal(result.kind, kind);
        assert.equal(f.packets.length, 1); assert.equal(f.credentialCalls.length, 0);
      }
    }
  });
  await test('existing Admission cannot adopt foreign, stale, unprotected or incomplete scope', async () => {
    for (const edit of [r => { r.accountSid = 'S-1-5-21-9-8-7-1001'; }, r => { r.accountSid = 'S-1-5-21-111-222-333-999'; },
      r => { r.accountSid = 'S-1-5-21-111-222-333-4294967296'; }, r => { r.accountSid = 'S-1-5-21-111-222-333-01001'; },
      r => { r.accountName = 'operator'; }, r => { r.isLocal = false; }, r => { r.profilePath += '.TEMP'; },
      r => { r.registeredSid += '9'; }, r => { r.registeredPath += '-other'; }, r => { r.registeredProfileCount = 0; },
      r => { r.currentUserSid = EXISTING_SID; }, r => { r.currentUserProtected = false; },
      r => { r.currentUserProfilePath = TARGET; }, r => { r.currentUserProfilePath = TARGET + '.'; },
      r => { r.currentUserProfilePath = 'C:\\Users'; }, r => { r.currentUserProfilePathVerified = false; },
      r => { r.profileNamespaceComplete = false; }, r => { r.profileNamespaceComplete = 'true'; },
      r => { r.profileNamespaceVerified = false; }, r => { r.unknownProfileCount = 1; },
      r => { r.foreignProfileConflictCount = 1; }, r => { r.targetProfileConflictCount = 1; },
      r => { r.profileNamespaceProofKind = 'filtered-exact-only'; }, r => { r.binding.accountSid += '9'; },
      r => { r.leaseNonce = 'other-lease'; }, r => { r.generation++; }, r => { r.capturedAtMs = 1101; }, r => { r.capturedAtMs = 800; },
      r => { r.accountLookupComplete = false; }, r => { r.leafReparseFree = false; }]) {
      const f = fixture(), native = await createHelperResetWindows(f.options); admissionTransport(f, 'bound-existing', edit);
      await rejectsCode(native.adapters.inspectAdmission(context(null)), 'native_scope_unverified');
      assert.equal(native.hasUnresolvedCustody(), true); assert.equal(f.packets.length, 1);
    }
  });
  await test('fresh absence clears old SID only for explicit revalidate transition', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options); admissionTransport(f, 'fresh-absent');
    const result = await native.adapters.revalidateAdmission({ ...context(EXISTING_SID), expectedKind: 'fresh-absent' });
    assert.equal(result.accountSid, null); assert.equal(result.profileExists, false);
    const g = fixture(), other = await createHelperResetWindows(g.options); admissionTransport(g, 'fresh-absent');
    await rejectsCode(other.adapters.inspectAdmission(context(EXISTING_SID)), 'native_scope_unverified');
    const h = fixture(), strict = await createHelperResetWindows(h.options);
    h.mutate = r => { r.accountSid = EXISTING_SID; return r; };
    await rejectsCode(strict.adapters.readJournal(context(null)), 'native_scope_unverified');
  });
  await test('blocked namespace preserves unknown quantity instead of fabricating zero', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    admissionTransport(f, 'fresh-absent', r => Object.assign(r, { status: 'blocked', kind: 'blocked',
      profileNamespaceComplete: false, profileNamespaceVerified: false, unknownProfileCount: null,
      namespaceBlockers: ['cim-inventory-incomplete'] }));
    const result = await native.adapters.inspectAdmission(context(null));
    assert.equal(result.status, 'blocked'); assert.equal(result.unknownProfileCount, null);
    assert.equal(f.credentialCalls.length, 0);
  });
  await test('busy lease is not fabricated into held lease', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    f.mutate = () => ({ status: 'busy', complete: true, acquired: false });
    assert.deepEqual(await native.adapters.acquireLease(context(null)), { status: 'busy', complete: true, acquired: false });
  });
  await test('lease freshness/exclusivity/machine errors retain custody', async () => {
    for (const edit of [r => { r.exclusive = false; }, r => { r.machineId = 'elsewhere'; },
      r => { r.acquiredAtMs = 1101; }, r => { r.expiresAtMs = 1100; }, r => { delete r.nonce; }]) {
      const f = fixture(), native = await createHelperResetWindows(f.options);
      f.mutate = r => { edit(r); return r; };
      await rejectsCode(native.adapters.acquireLease(context(null)), 'native_lease_unverified');
      assert.equal(native.hasUnresolvedCustody(), true);
    }
  });
  await test('credentials only travel in fixed secret packets and caller context stays unchanged', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options), c = context(null), saved = copy(c);
    await native.adapters.createDisabledAccount(c);
    await native.runWorkflowStep('launch-zoom', context(), { zoomPath: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe' });
    await native.runWorkflowStep('verify-profile', context());
    await native.runWorkflowStep('configure-helper', context());
    await native.runWorkflowStep('seal-credential', context());
    await native.runWorkflowStep('persist-credential', context());
    await native.runWorkflowStep('verify-zoom', context());
    assert.deepEqual(c, saved);
    assert.deepEqual(f.packets.filter(x => Object.hasOwn(x.packet, 'secret')).map(x => x.packet.command),
      ['createDisabledAccount', 'workflow-launch-zoom', 'workflow-seal-credential']);
    for (const item of f.packets) {
      assert.equal(JSON.stringify(item.packet.context).includes(SECRET), false);
      assert.equal(item.options.timeoutMs, 30000);
      if (Object.hasOwn(item.packet, 'secret')) assert.equal(item.packet.secret, SECRET);
    }
    assert.equal(JSON.stringify(native.info()).includes(SECRET), false);
  });
  await test('missing/short/control-character credentials dispatch zero native effects', async () => {
    for (const value of [null, '', 'short', 'a'.repeat(129), 'valid-long-password-but\0unsafe']) {
      const f = fixture(), native = await createHelperResetWindows(f.options); f.setSecret(value);
      await rejectsCode(native.adapters.createDisabledAccount(context(null)), 'credentials_invalid');
      assert.equal(f.packets.length, 0);
    }
  });
  await test('changed operation secret fails before launch and retains custody', async () => {
    const f = fixture(), native = await provision(f); f.setSecret(SECRET + '-changed');
    await rejectsCode(native.runWorkflowStep('launch-zoom', context(), { zoomPath: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe' }), 'credentials_invalid');
    assert.equal(f.packets.length, 1); assert.equal(native.hasUnresolvedCustody(), true);
  });
  await test('credential persistence uses native seal, decoded hash and no caller payload or secret', async () => {
    const f = fixture(), native = await provision(f);
    await rejectsCode(native.runWorkflowStep('persist-credential', context()), 'native_credential_unverified');
    assert.equal(f.packets.length, 1);
    await native.runWorkflowStep('seal-credential', context());
    const result = await native.runWorkflowStep('persist-credential', context());
    assert.equal(result.ciphertextSha256, CIPHERTEXT_SHA256);
    assert.equal(result.ownerVerified, true); assert.equal(result.storageProtected, true);
    const packet = f.packets.at(-1).packet;
    assert.equal(packet.command, 'workflow-persist-credential');
    assert.equal(Object.hasOwn(packet, 'secret'), false);
    assert.equal(Object.hasOwn(packet.context, 'ciphertext'), false);
    const count = f.packets.length;
    await rejectsCode(native.runWorkflowStep('persist-credential', context(), { ciphertext: CIPHERTEXT }), 'context_invalid');
    assert.equal(f.packets.length, count);
  });
  await test('credential storage proof rejects wrong ACL, owner, path, format or ciphertext hash', async () => {
    for (const edit of [r => { r.storageProtected = false; }, r => { r.ownerVerified = false; },
      r => { r.stored = false; }, r => { r.readbackVerified = false; }, r => { r.formatVersion = 1; },
      r => { r.protection = 'DPAPI-LocalMachine'; }, r => { r.currentUserProtected = false; },
      r => { r.path = r.credentialPath = 'C:\\Users\\operator\\untrusted.json'; },
      r => { r.operatorSid += '9'; }, r => { r.ciphertextSha256 = '0'.repeat(64); }]) {
      const f = fixture(), native = await provision(f);
      await native.runWorkflowStep('seal-credential', context());
      f.mutate = r => { edit(r); return r; };
      await rejectsCode(native.runWorkflowStep('persist-credential', context()), 'native_storage_unverified');
      assert.equal(native.hasUnresolvedCustody(), true);
    }
  });
  await test('provider callback replay is rejected', async () => {
    const f = fixture();
    f.options.credentials.withPassword = async (_c, callback) => { await callback(SECRET); return callback(SECRET); };
    const native = await createHelperResetWindows(f.options);
    await rejectsCode(native.adapters.createDisabledAccount(context(null)), 'credentials_invalid');
    assert.equal(f.packets.length, 1); assert.equal(native.hasUnresolvedCustody(), true);
  });
  await test('workflow requires this worker created SID and exact operation identity', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    await rejectsCode(native.runWorkflowStep('verify-profile', context()), 'context_invalid');
    await native.adapters.createDisabledAccount(context(null));
    for (const edit of [c => { c.operation.accountSid += '9'; }, c => { c.operation.generation++; },
      c => { c.operation.leaseNonce = 'foreign'; }, c => { c.operation.id = 'other'; },
      c => { c.operation.machineId = 'elsewhere'; }, c => { c.profilePath = 'C:\\Users\\operator'; }]) {
      const c = context(); edit(c);
      await rejectsCode(native.runWorkflowStep('verify-profile', c), 'context_invalid');
    }
    assert.equal(f.packets.length, 1);
  });
  await test('no arbitrary workflow command, script or path injection', async () => {
    const f = fixture(), native = await provision(f);
    await rejectsCode(native.runWorkflowStep('run-script', context(), { script: 'ignored' }), 'context_invalid');
    await rejectsCode(native.runWorkflowStep('configure-helper', context(), { script: 'ignored' }), 'context_invalid');
    for (const zoomPath of ['\\\\server\\Zoom.exe', 'C:\\Zoom.exe" -bad', 'C:\\Zoom.exe:stream']) {
      await rejectsCode(native.runWorkflowStep('launch-zoom', context(), { zoomPath }), 'zoom_untrusted');
    }
    assert.equal(f.packets.length, 1);
    assert.deepEqual(Object.keys(WORKFLOW_COMMANDS), ['launch-zoom', 'verify-profile', 'configure-helper', 'seal-credential', 'persist-credential', 'verify-zoom']);
  });
  await test('host abort signal never crosses transport and stops late workflow authority', async () => {
    const f = fixture(), native = await provision(f);
    const signal = { aborted: true, hostOnly: 'must-not-serialize' };
    await rejectsCode(native.runWorkflowStep('verify-profile', { ...context(), signal }), 'operation_cancelled');
    assert.equal(f.packets.length, 1);
    signal.aborted = false;
    f.mutate = (result, packet) => {
      assert.equal(Object.hasOwn(packet.context, 'signal'), false);
      signal.aborted = true;
      return result;
    };
    await rejectsCode(native.runWorkflowStep('verify-profile', { ...context(), signal }), 'recovery_required');
    assert.equal(native.hasUnresolvedCustody(), true);
  });
  await test('controller authority loss blocks every later native dispatch', async () => {
    const f = fixture(), native = await provision(f);
    native.adapters.onAuthorityLost();
    await rejectsCode(native.runWorkflowStep('verify-profile', context()), 'recovery_required');
    assert.equal(f.packets.length, 1);
  });
  await test('stale/future/foreign/partial native effect proofs never become verified', async () => {
    for (const edit of [r => { r.capturedAtMs = 1101; }, r => { r.capturedAtMs = 0; },
      r => { r.leaseNonce = 'other'; }, r => { r.generation++; }, r => { r.accountSid += '9'; },
      r => { r.machineId = 'foreign'; }, r => { r.profilePath = 'C:\\Users\\operator'; },
      r => { r.complete = false; }]) {
      const f = fixture(), native = await createHelperResetWindows(f.options);
      f.mutate = r => { edit(r); return r; };
      await rejectsCode(native.adapters.fenceAccount(context()), 'native_scope_unverified');
      assert.equal(native.hasUnresolvedCustody(), true);
      const count = f.packets.length;
      await rejectsCode(native.adapters.deleteAccount(context()), 'recovery_required');
      assert.equal(f.packets.length, count);
    }
  });
  await test('receipt freshness TTL boundary is exclusive', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    f.setTime(6000);
    await rejectsCode(native.adapters.fenceAccount(context()), 'native_scope_unverified');
    assert.equal(native.hasUnresolvedCustody(), true);
  });
  await test('workflow status/registration/step replay cannot authorize next step', async () => {
    for (const edit of [r => { r.verified = false; }, r => { r.status = 'success'; },
      r => { r.registeredSid += '9'; }, r => { r.registeredPath = 'C:\\Users\\user1.TEMP'; },
      r => { r.step = 'verify-zoom'; }]) {
      const f = fixture(), native = await provision(f); f.mutate = r => { edit(r); return r; };
      await rejectsCode(native.runWorkflowStep('verify-profile', context()), 'native_workflow_unverified');
      assert.equal(native.hasUnresolvedCustody(), true);
    }
  });
  await test('explicit native failure and unknown transport outcome retain effects without replay', async () => {
    for (const reply of [{ ok: false, completed: true, error: { code: 'target_in_use' } },
      { ok: false, completed: false, error: { code: 'command_timeout' } }, null]) {
      const f = fixture(), native = await createHelperResetWindows(f.options); f.response = () => reply;
      await assert.rejects(native.adapters.purgeProfile(context()));
      assert.equal(native.hasUnresolvedCustody(), true);
      await rejectsCode(native.close(), 'recovery_required');
      assert.equal(f.closed, 0); assert.equal(f.packets.length, 1);
    }
  });
  await test('late native response cannot clear retained custody', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    f.session.request = async packet => { f.packets.push({ packet: copy(packet) }); throw new Error('uncertain'); };
    await rejectsCode(native.adapters.createProfile(context()), 'native_request_uncertain');
    f.session.request = async () => ({ ok: true, completed: true, result: {} });
    await rejectsCode(native.adapters.createProfile(context()), 'recovery_required');
    assert.equal(f.packets.length, 1); assert.equal(native.hasUnresolvedCustody(), true);
  });
  await test('snapshot replay is rejected before controller policy evaluation', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    f.mutate = r => { r.operation.generation++; return r; };
    await rejectsCode(native.adapters.captureResetSnapshot(context()), 'native_snapshot_unverified');
    assert.equal(native.hasUnresolvedCustody(), true);
  });
  await test('verified close requires same transport close proof', async () => {
    const f = fixture(), native = await createHelperResetWindows(f.options);
    assert.equal((await native.close()).result.status, 'closed'); assert.equal(f.closed, 1);
    const g = fixture(), other = await createHelperResetWindows(g.options);
    g.session.close = async () => ({ ok: true, completed: true, closed: true });
    await rejectsCode(other.close(), 'native_close_unverified'); assert.equal(other.hasUnresolvedCustody(), true);
  });
  await test('worker source uses SID-bound native APIs, unique quarantine and sticky private journal', async () => {
    assert.match(WINDOWS_WORKER_SOURCE, /Remove-LocalUser -SID/);
    assert.match(WINDOWS_WORKER_SOURCE, /Disable-LocalUser -SID/);
    assert.match(WINDOWS_WORKER_SOURCE, /SetFileInformationByHandle/);
    assert.match(WINDOWS_WORKER_SOURCE, /Purge\(\$c\.operation\.accountSid,\$quarantine\)/);
    assert.match(WINDOWS_WORKER_SOURCE, /FileShare\]::None/);
    assert.match(WINDOWS_WORKER_SOURCE, /Flush\(\$true\)/);
    assert.match(WINDOWS_WORKER_SOURCE, /LogonUserW/);
    assert.match(WINDOWS_WORKER_SOURCE, /CreateProcessWithTokenW\(owned\.Token,1,/);
    assert.match(WINDOWS_WORKER_SOURCE, /DataProtectionScope\]::CurrentUser/);
    assert.doesNotMatch(WINDOWS_WORKER_SOURCE, /taskkill|Remove-Item|Restart-Service|reg\.exe|powershell\.exe|-ExecutionPolicy|WTSQueryUserToken|LocalMachine\)/i);
    assert.equal(WINDOWS_WORKER_SOURCE.includes('Unknown purge never permits recreation'), true);
  });
  await test('final SAM freshness and post-intent quarantine admission remain ordered before effects', async () => {
    const guard = WINDOWS_WORKER_SOURCE.match(/^function Assert-Expected\([^\n]*\) \{[\s\S]*?^\}/m)[0];
    assert.ok(guard.lastIndexOf('if((Millis)-$validationStarted') > guard.indexOf('$finalAccount=Local-Account'));
    const purge = WINDOWS_WORKER_SOURCE.slice(WINDOWS_WORKER_SOURCE.indexOf("    'purgeProfile' {"),
      WINDOWS_WORKER_SOURCE.indexOf("    'deleteAccount' {"));
    const intent = purge.indexOf("$j.quarantineState='purge-intent';Write-State 'journal.json' $j");
    const validation = purge.indexOf('Assert-QuarantinedExpected $c');
    const effect = purge.indexOf('[FixerResetNativeV1]::Purge(');
    assert.ok(intent > 0 && validation > intent && effect > validation);
    const script = powerShellNegativeTests();
    assert.equal(script.includes('[FixerResetNativeV1]'), false);
    assert.doesNotMatch(script, /DllImport|::Purge\(|Get-CimInstance|Get-LocalUser|CreateProcessWithTokenW/);
    assert.match(script, /absolute dotdot escape/);
    assert.match(script, /final SAM stall invalidates older proofs/);
  });
  await test('C# imports use System32 and have no module/type constructor initializer', async () => {
    const csharp = WINDOWS_WORKER_SOURCE.match(/\$nativeSource = @'\n([\s\S]*?)\n'@/)[1];
    assert.match(csharp, /\[assembly:DefaultDllImportSearchPaths\(DllImportSearchPath\.System32\)\]/);
    assert.doesNotMatch(csharp, /ModuleInitializer|static\s+FixerResetNativeV1\s*\(/);
    const names = [...csharp.matchAll(/\[DllImport\("([^"]+)"/g)].map(match => match[1]);
    assert.ok(names.length > 0);
    assert.deepEqual([...new Set(names)].sort(), ['advapi32.dll', 'kernel32.dll', 'netapi32.dll', 'user32.dll', 'userenv.dll', 'wtsapi32.dll']);
  });
  await test('credential store admits only its cached seal and uses private unique durable storage', async () => {
    const store = WINDOWS_WORKER_SOURCE.match(/^function Persist-OwnedCredential\([^\n]*\) \{[\s\S]*?^\}/m)[0];
    assert.match(store, /\$cached=Current-SealedCredential \$c/);
    assert.doesNotMatch(store, /\$c\.(?:ciphertext|binding|path|credentialPath)/);
    assert.match(store, /\[IO\.FileMode\]::CreateNew/);
    assert.doesNotMatch(store, /OpenOrCreate|WriteAllText|Remove-Item|Set-Acl/);
    assert.match(store, /Credential-FileSecurity \$current\.sid/);
    assert.match(store, /Write-StreamJson \$stream \$envelope/);
    assert.match(store, /Assert-CredentialPrivate \$path \$current\.sid/);
    assert.match(store, /FromBase64String\(\$readback\.ciphertext\)/);
    assert.match(store, /FileIdentity\(\$read\.SafeFileHandle\)/);
    assert.match(store, /schemaVersion=2;protection='DPAPI-CurrentUser'/);
    assert.match(store, /\$proofStarted=Millis/);
    assert.match(store, /\$r\.stored=\$true;\$r\.readbackVerified=\$true;\$r\.storageProtected=\$true;\$r\.ownerVerified=\$true/);
  });
  await test('profile privilege interop is current-process-only and restoration is mandatory', async () => {
    const csharp = WINDOWS_WORKER_SOURCE.match(/\$nativeSource = @'\n([\s\S]*?)\n'@/)[1];
    assert.match(csharp, /OpenProcessToken\(GetCurrentProcess\(\),0x28,out token\)/);
    assert.match(csharp, /ExactSpelling=true,SetLastError=true\)\] static extern bool AdjustTokenPrivileges\(IntPtr token,bool disableAll,IntPtr newState,int previousBytes,IntPtr previous,out int returnedBytes\)/);
    assert.match(csharp, /AdjustTokenPrivileges\(token,false,next,bytes,prior,out returned\)/);
    assert.match(csharp, /int error=Marshal\.GetLastPInvokeError\(\)/);
    assert.match(csharp, /result\.Error!=0/);
    assert.match(csharp, /api\.Adjust\(token,new Dictionary<long,uint>\(previous\)\)/);
    assert.match(csharp, /!Same\(original,Copy\(api\.Read\(token\)\)\)/);
    assert.match(csharp, /privileges\.Execute\(delegate \{/);
    assert.match(csharp, /PrivilegeCustodyUnresolved=true/);
    assert.doesNotMatch(csharp, /LsaAddAccountRights|LsaSetInformationPolicy|SetTokenInformation|AdjustTokenGroups/);
    const preflight = csharp.slice(csharp.indexOf('public static bool ProfilePrivilegesAssigned()'), csharp.indexOf('public static bool VerifyExports()'));
    assert.match(preflight, /privileges\.ContainsKey\(backup\) && privileges\.ContainsKey\(restore\)/);
    assert.doesNotMatch(preflight, /\.Adjust\(|\.Enter\(|\.Execute\(/);
    assert.match(WINDOWS_WORKER_SOURCE, /if\(\[FixerResetNativeV1\]::PrivilegeCustodyUnresolved\)\{Deny 'profile_privilege_restore_unverified'\}/);
    const managedScript = managedPrivilegeTests();
    assert.match(managedScript, /FixerResetPrivilegeChecks[0-9a-f]{12}\]::Run\(\)/);
    assert.doesNotMatch(managedScript, /\]::(?:ProfilePrivilegesAssigned|LoadProfile|VerifyExports)\(/);
  });
  await test('every standard-account carrier requires exact complete SID role evidence', async () => {
    const fields = ['usersGroupSid', 'usersMembershipVerified', 'administratorsExcluded',
      'groupEnumerationComplete', 'standardAccountVerified', 'membershipProofKind'];
    for (const command of ['createDisabledAccount', 'enableAccount', 'verifyProvisionedState']) {
      for (const field of fields) {
        const f = fixture(), native = await createHelperResetWindows(f.options);
        f.mutate = result => { delete result[field]; return result; };
        await rejectsCode(native.adapters[command](context(command === 'createDisabledAccount' ? null : SID)), 'native_standard_account_unverified');
        assert.equal(native.hasUnresolvedCustody(), true);
      }
    }
    for (const edit of [r => { r.usersGroupSid = 'S-1-5-32-544'; },
      r => { r.usersMembershipVerified = false; }, r => { r.administratorsExcluded = false; },
      r => { r.groupEnumerationComplete = false; }, r => { r.standardAccountVerified = false; },
      r => { r.membershipProofKind = 'name-only'; }]) {
      const f = fixture(), native = await createHelperResetWindows(f.options);
      f.mutate = result => { edit(result); return result; };
      await rejectsCode(native.adapters.createDisabledAccount(context(null)), 'native_standard_account_unverified');
      assert.equal(native.hasUnresolvedCustody(), true);
    }
  });
  await test('new helper membership and actual token checks precede enable/profile effects', async () => {
    const ensure = WINDOWS_WORKER_SOURCE.match(/^function Ensure-StandardAccountMembership\([^\n]*\) \{[\s\S]*?^\}/m)[0];
    assert.match(ensure, /if\(!\$facts\.usersMembershipVerified\)/);
    assert.match(ensure, /\$j\.phase -cne 'creating-account'/);
    assert.match(ensure, /\$j\.newAccountSid -cne \$sid/);
    assert.match(ensure, /if\(\$facts\.account\.Enabled\)/);
    assert.match(ensure, /Add-LocalGroupMember -SID \(\[Security\.Principal\.SecurityIdentifier\]::new\('S-1-5-32-545'\)\) -Member \$fresh\.account/);
    assert.doesNotMatch(ensure, /Remove-LocalGroupMember|Set-LocalGroup|Member 'user1'/);
    assert.match(WINDOWS_WORKER_SOURCE, /NetLocalGroupGetMembers\(null,group,0,/);
    assert.match(WINDOWS_WORKER_SOURCE, /NetUserGetLocalGroups\(null,user,0,1,/);
    assert.doesNotMatch(WINDOWS_WORKER_SOURCE, /Get-LocalGroupMember/);
    const load = WINDOWS_WORKER_SOURCE.slice(WINDOWS_WORKER_SOURCE.indexOf('public static WorkflowHandles LoadOwnedProfile('),
      WINDOWS_WORKER_SOURCE.indexOf('public static void LoadProfile('));
    assert.match(load, /RequireStandardToken\(token,expectedSid\)/);
    assert.match(WINDOWS_WORKER_SOURCE, /snapshot\.Groups\.ContainsKey\("S-1-5-32-544"\)/);
    const enable = WINDOWS_WORKER_SOURCE.slice(WINDOWS_WORKER_SOURCE.indexOf("    'enableAccount' {"),
      WINDOWS_WORKER_SOURCE.indexOf("    'verifyProvisionedState' {"));
    assert.ok(enable.indexOf('Assert-StandardAccount') < enable.indexOf('Enable-LocalUser -SID'));
  });
  await test('namespace inventory is whole, metadata-only and rechecked at destructive boundaries', async () => {
    const inventory = WINDOWS_WORKER_SOURCE.match(/^function Read-ProfileInventory\([^\n]*\) \{[\s\S]*?^\}/m)?.[0] ||
      WINDOWS_WORKER_SOURCE.match(/^function Read-ProfileInventory \{[\s\S]*?^\}/m)[0];
    assert.match(inventory, /Get-CimInstance -ClassName Win32_UserProfile -OperationTimeoutSec 10/);
    assert.doesNotMatch(inventory, /-Filter|Where-Object|ExpandEnvironmentVariables|Remove-|Set-Acl/);
    assert.match(inventory, /foreach\(\$name in \$names\)/);
    assert.match(WINDOWS_WORKER_SOURCE, /proofKind='complete-profile-metadata'/);
    assert.doesNotMatch(WINDOWS_WORKER_SOURCE, /\$r\.unknownProfileCount=0/);
    const expected = WINDOWS_WORKER_SOURCE.match(/^function Assert-Expected\([^\n]*\) \{[\s\S]*?^\}/m)[0];
    const quarantined = WINDOWS_WORKER_SOURCE.match(/^function Assert-QuarantinedExpected\([^\n]*\) \{[\s\S]*?^\}/m)[0];
    assert.match(expected, /Assert-ProfileNamespace \$p/); assert.match(quarantined, /Assert-ProfileNamespace \$p/);
    assert.match(expected, /Profile-Facts \$c\.operation\.accountSid \$quarantineScope/);
    assert.match(quarantined, /Profile-Facts \$c\.operation\.accountSid \$expectedPath/);
  });
  console.log('helper-reset-windows: ' + passed + ' passed; ' + failed + ' failed. Native Windows acceptance not run.');
  finished = true; process.exitCode = failed ? 1 : 0;
})().catch(error => { finished = true; console.error(error.message); process.exitCode = 1; });
