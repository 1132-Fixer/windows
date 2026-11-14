'use strict';

// Maintained Windows implementation. Importing this module performs no native
// operation. Only its injected transport may start the fixed PowerShell 7
// worker. A JavaScript receipt never authorizes a profile/account operation:
// the worker rechecks the expected SID, namespace and durable phase at effect.
const crypto = require('node:crypto');
const windowsPath = require('node:path').win32;
const { REQUIRED_ADAPTERS, TARGET_PROFILE } = require('./helper-reset-controller');
const { BOOTSTRAP_ARGS } = require('./windows-repair-transport');
const WORKFLOW_COMMANDS = Object.freeze({
  'launch-zoom': 'workflow-launch-zoom',
  'verify-profile': 'workflow-verify-profile',
  'configure-helper': 'workflow-configure-helper',
  'seal-credential': 'workflow-seal-credential',
  'persist-credential': 'workflow-persist-credential',
  'verify-zoom': 'workflow-verify-zoom'
});
const SECRET_COMMANDS = new Set(['createDisabledAccount', 'workflow-launch-zoom', 'workflow-seal-credential']);
const EFFECT_COMMANDS = new Set(['writeJournal', 'persistBinding', 'fenceAccount', 'shutdownAccount',
  'purgeProfile', 'deleteAccount', 'createDisabledAccount', 'createProfile', 'enableAccount',
  ...Object.values(WORKFLOW_COMMANDS)]);
const ROLE_COMMANDS = new Set(['createDisabledAccount', 'enableAccount', 'verifyProvisionedState']);
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_AGE_MS = 5000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const sameProfile = value => typeof value === 'string' && value.toLowerCase() === TARGET_PROFILE.toLowerCase();
function fail(code) { const e = new Error(code); e.code = code; return e; }
function operationKey(context) {
  const op = context && context.operation;
  if (!record(op) || !identifier(op.id) || !positive(op.generation) ||
      !identifier(op.machineId) || !identifier(op.leaseNonce)) throw fail('context_invalid');
  return [op.id, op.generation, op.machineId, op.leaseNonce].join('|');
}
function assertScope(context, machineId) {
  const op = context && context.operation;
  if (!record(context) || !record(op) || op.machineId !== machineId ||
      op.accountName !== 'user1' || !sameProfile(context.profilePath) ||
      !identifier(op.id) || !positive(op.generation)) throw fail('context_invalid');
}
function copyContext(context) {
  // Context is internal structured data. No executable string is admitted.
  const { signal, ...data } = context;
  const copied = JSON.parse(JSON.stringify(data));
  if (JSON.stringify(copied).length > 16384) throw fail('context_invalid');
  return copied;
}

function canonicalLocalAccountSid(value, machineSid) {
  if (typeof machineSid !== 'string' || !/^S-1-5-21-(?:0|[1-9]\d*)-(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/.test(machineSid) ||
      machineSid.split('-').slice(4).some(part => Number(part) > 0xffffffff) ||
      typeof value !== 'string' || !value.startsWith(machineSid + '-')) return false;
  const rid = value.slice(machineSid.length + 1);
  return /^(?:0|[1-9]\d*)$/.test(rid) && Number(rid) >= 1000 && Number(rid) <= 0xffffffff;
}
function admissionCurrentUserProtected(value, accountSid) {
  if (value.currentUserProtected !== true || value.currentUserProfilePathVerified !== true ||
      typeof value.currentUserSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(value.currentUserSid) ||
      value.currentUserSid === accountSid || typeof value.currentUserProfilePath !== 'string' ||
      !/^[A-Za-z]:\\/.test(value.currentUserProfilePath) || /[\x00-\x1f<>|?*":]/.test(value.currentUserProfilePath.slice(2)) ||
      /~[0-9]/.test(value.currentUserProfilePath)) return false;
  if (value.currentUserProfilePath.slice(3).split('\\').some(part => part !== '.' && part !== '..' &&
      (/[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)))) return false;
  const current = windowsPath.normalize(value.currentUserProfilePath).replace(/\\+$/, '').toLowerCase();
  const target = TARGET_PROFILE.toLowerCase();
  return current !== target && !current.startsWith(target + '\\') && !target.startsWith(current + '\\');
}
function admissionNamespaceReceipt(value, context, command, nowMs) {
  if (!record(context.lease) || context.lease.nonce !== context.operation.leaseNonce ||
      !positive(context.lease.acquiredAtMs) || value.capturedAtMs < context.lease.acquiredAtMs ||
      !positive(context.lease.expiresAtMs) || context.lease.expiresAtMs <= nowMs ||
      typeof value.profileNamespaceComplete !== 'boolean' || typeof value.profileNamespaceVerified !== 'boolean' ||
      value.profileNamespaceProofKind !== 'complete-profile-metadata' ||
      !Array.isArray(value.namespaceBlockers) || !Array.isArray(value.profileConflictEvidence) ||
      !Number.isSafeInteger(value.observedUnknownProfileCount) || value.observedUnknownProfileCount < 0 ||
      !Number.isSafeInteger(value.foreignProfileConflictCount) || value.foreignProfileConflictCount < 0 ||
      !Number.isSafeInteger(value.targetProfileConflictCount) || value.targetProfileConflictCount < 0) return false;
  if (value.status === 'blocked' && value.kind === 'blocked') {
    return value.accountSid === context.operation.accountSid && value.profileNamespaceVerified === false &&
      (value.unknownProfileCount === null && !value.profileNamespaceComplete ||
        Number.isSafeInteger(value.unknownProfileCount) && value.unknownProfileCount >= 0) &&
      (!value.profileNamespaceComplete || value.unknownProfileCount !== 0 ||
        value.foreignProfileConflictCount !== 0 || value.targetProfileConflictCount !== 0 || value.namespaceBlockers.length > 0);
  }
  if (value.status !== 'verified' || value.profileNamespaceComplete !== true || value.profileNamespaceVerified !== true ||
      value.unknownProfileCount !== 0 || value.observedUnknownProfileCount !== 0 ||
      value.foreignProfileConflictCount !== 0 || value.targetProfileConflictCount !== 0 ||
      value.namespaceBlockers.length !== 0 || value.profileConflictEvidence.length !== 0 ||
      value.accountName !== 'user1' || value.isLocal !== true || value.accountLookupComplete !== true ||
      value.profileOwnershipVerified !== true || value.profilesRootVerified !== true ||
      typeof value.profilesRoot !== 'string' || value.profilesRoot.toLowerCase() !== 'c:\\users' ||
      !admissionCurrentUserProtected(value, value.accountSid)) return false;
  if (value.kind === 'fresh-absent') {
    return value.accountSid === null && value.accountExists === false && value.profileExists === false &&
      value.registeredProfileCount === 0 && (context.operation.accountSid === null ||
        command === 'revalidateAdmission' && context.expectedKind === 'fresh-absent');
  }
  if (!['bound-existing', 'operator-target'].includes(value.kind) ||
      !canonicalLocalAccountSid(value.accountSid, context.operation.machineSid) ||
      context.operation.accountSid !== null && value.accountSid !== context.operation.accountSid ||
      value.accountExists !== true || value.profileExists !== true || value.builtin !== false ||
      value.protected !== false || value.special !== false || typeof value.enabled !== 'boolean' ||
      value.leafReparseFree !== true || value.ancestorsReparseFree !== true ||
      value.registeredProfileCount !== 1 || value.registeredSid !== value.accountSid || !sameProfile(value.registeredPath)) return false;
  if (value.kind === 'bound-existing') {
    const b = value.binding;
    return record(b) && b.verified === true && b.storageProtected === true && b.ownerVerified === true &&
      b.machineId === context.operation.machineId && b.machineSid === context.operation.machineSid &&
      b.accountName === 'user1' && b.accountSid === value.accountSid && sameProfile(b.profilePath);
  }
  return true;
}


const WINDOWS_WORKER_SOURCE = String.raw`Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:Target = 'C:\Users\user1'
$script:StateRoot = 'C:\ProgramData\1132 Fixer\helper-reset'
$script:WorkerNonce = [Guid]::NewGuid().ToString('N')
$script:Lease = $null
$script:LeaseStream = $null
$script:LastShutdown = $null
$script:CreatedSid = $null
$script:JournalOwned = $false
$script:Workflow = $null
$script:EffectsStarted = $false
$script:ZoomVerified = $false
$script:Guards = [Collections.Generic.List[IDisposable]]::new()
function Deny([string]$code) { throw [InvalidOperationException]::new($code) }
function Safe-ErrorCode($exception,$allowed) {
  for($depth=0;$null -ne $exception -and $depth -lt 8;$depth++){
    if($exception.Message -in $allowed){return $exception.Message}
    $exception=$exception.InnerException
  }
  return 'native_failure'
}
function Millis { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function ExactPath($value) { return $value -is [string] -and $value.Equals($script:Target,[StringComparison]::OrdinalIgnoreCase) }
function Read-ItemExact([string]$path) {
  try { return Get-Item -LiteralPath $path -Force -ErrorAction Stop }
  catch [Management.Automation.ItemNotFoundException] { return $null }
}
function Directory-Security {
  $a = [Security.AccessControl.DirectorySecurity]::new()
  $a.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $a.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    [void]$a.AddAccessRule($rule)
  }
  return $a
}
function File-Security {
  $a = [Security.AccessControl.FileSecurity]::new()
  $a.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $a.SetAccessRuleProtection($true,$false)
  foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
    [void]$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))
  }
  return $a
}
function Assert-Private([string]$path) {
  $item = Read-ItemExact $path
  if($null -eq $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Deny 'storage_unverified' }
  $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -notin @('S-1-5-18','S-1-5-32-544') -or !$acl.AreAccessRulesProtected) { Deny 'storage_unverified' }
  $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if($rules.Count -lt 2) { Deny 'storage_unverified' }
  foreach($rule in $rules) {
    if($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { Deny 'storage_unverified' }
  }
}
function Open-Private([string]$name,[switch]$AllowNew) {
  $path = [IO.Path]::Combine($script:StateRoot,$name)
  if($null -ne (Read-ItemExact $path)) { Assert-Private $path }
  $exists=$null -ne (Read-ItemExact $path)
  if(!$exists -and !$AllowNew) { Deny 'journal_unverified' }
  $mode=if($exists){[IO.FileMode]::Open}else{[IO.FileMode]::CreateNew}
  $stream = [IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($path),$mode,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(File-Security))
  if($exists -and $stream.Length -eq 0){$stream.Dispose();Deny 'journal_unverified'}
  Assert-Private $path
  return $stream
}
function Read-StreamJson($stream) {
  if($stream.Length -eq 0) { return $null }
  if($stream.Length -gt 65536) { Deny 'journal_unverified' }
  $stream.Position = 0
  $bytes = [byte[]]::new([int]$stream.Length)
  if($stream.Read($bytes,0,$bytes.Length) -ne $bytes.Length) { Deny 'journal_unverified' }
  return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -AsHashtable -ErrorAction Stop
}
function Write-StreamJson($stream,$value) {
  $text = ConvertTo-Json -InputObject $value -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  if($bytes.Length -gt 65536) { Deny 'journal_unverified' }
  $stream.Position = 0; $stream.SetLength(0)
  $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true)
  $readback = Read-StreamJson $stream
  if((ConvertTo-Json -InputObject $readback -Depth 12 -Compress) -cne $text) { Deny 'journal_unverified' }
}
function Read-State([string]$name) {
  $path = [IO.Path]::Combine($script:StateRoot,$name)
  if($null -eq (Read-ItemExact $path)) { return $null }
  $s = Open-Private $name
  try { return Read-StreamJson $s } finally { $s.Dispose() }
}
function Write-State([string]$name,$value) {
  $s = Open-Private $name -AllowNew
  try { Write-StreamJson $s $value } finally { $s.Dispose() }
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;
using Microsoft.Win32.SafeHandles;
[assembly:DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class FixerResetNativeV1 {
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {
    public uint Attributes; public long Creation,Access,Write; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Session { public int Id; public IntPtr Name; public int State; }
  public sealed class Proc { public int Id; public string Sid; public long Created; }
  public sealed class UserSession { public int Id; public string Sid; public bool Known; public bool Occupied; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint share,IntPtr sec,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long created,out long exited,out long kernel,out long user);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetProfilesDirectoryW(StringBuilder path,ref uint length);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteProfileW(string sid,string path,string computer);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateProfile(string sid,string name,StringBuilder path,uint count);
  [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSEnumerateSessionsW(IntPtr server,int reserved,int version,out IntPtr data,out int count);
  [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WTSQuerySessionInformationW(IntPtr server,int id,int kind,out IntPtr data,out int size);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryExW(string name,IntPtr file,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);

  [DllImport("kernel32.dll",ExactSpelling=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool LookupPrivilegeValueW(string system,string name,out long luid);
  [DllImport("advapi32.dll",ExactSpelling=true,SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disableAll,IntPtr newState,int previousBytes,IntPtr previous,out int returnedBytes);

  // The guard contains no native calls. Its production adapter can open ONLY
  // this process token; managed negative tests inject an entirely inert API.
  public sealed class PrivilegeAdjustment {
    public bool Success,PreviousValid;public int Error;
    public Dictionary<long,uint> Previous;
  }
  public interface IProfilePrivilegeApi {
    IntPtr OpenOwnProcessToken();
    long Lookup(string name);
    Dictionary<long,uint> Read(IntPtr token);
    PrivilegeAdjustment Adjust(IntPtr token,Dictionary<long,uint> state);
    void CloseOwnToken(IntPtr token);
  }
  public static bool PrivilegeCustodyUnresolved;
  public sealed class ProfilePrivilegeScope : IDisposable {
    readonly IProfilePrivilegeApi api;
    IntPtr token;
    Dictionary<long,uint> original,requested,previous;
    bool entered,disposed,adjustAttempted,previousValid;
    public bool RestorationVerified {get;private set;}
    public bool Unresolved {get;private set;}
    public bool OwnsToken {get{return token!=IntPtr.Zero;}}
    public ProfilePrivilegeScope(IProfilePrivilegeApi api) {this.api=api??throw new ArgumentNullException("api");}
    public void Execute(Action body) {
      if(body==null)throw new ArgumentNullException("body");
      Exception bodyError=null;
      try{Enter();body();}catch(Exception error){bodyError=error;}
      try{Dispose();}
      catch(Exception restoreError){throw new InvalidOperationException("profile_privilege_restore_unverified",bodyError==null?restoreError:new AggregateException(bodyError,restoreError));}
      if(bodyError!=null)throw bodyError;
    }
    static Dictionary<long,uint> Copy(Dictionary<long,uint> value) {
      if(value==null || value.Count>4096)throw new InvalidOperationException("profile_privileges_unavailable");
      return new Dictionary<long,uint>(value);
    }
    static bool Same(Dictionary<long,uint> a,Dictionary<long,uint> b) {
      if(a==null || b==null || a.Count!=b.Count)return false;
      foreach(var item in a){uint found;if(!b.TryGetValue(item.Key,out found) || found!=item.Value)return false;}
      return true;
    }
    bool ValidPrevious(PrivilegeAdjustment result) {
      if(result==null || !result.PreviousValid || result.Previous==null || result.Previous.Count>requested.Count)return false;
      foreach(var item in result.Previous){
        uint prior;
        if(!requested.ContainsKey(item.Key) || !original.TryGetValue(item.Key,out prior) || item.Value!=prior)return false;
      }
      return true;
    }
    void Unverified(Exception cause) {
      Unresolved=true;PrivilegeCustodyUnresolved=true;
      throw new InvalidOperationException("profile_privilege_restore_unverified",cause);
    }
    public void Enter() {
      if(entered || disposed || token!=IntPtr.Zero)throw new InvalidOperationException("profile_privileges_unavailable");
      try {
        token=api.OpenOwnProcessToken();if(token==IntPtr.Zero)throw new InvalidOperationException("profile_privileges_unavailable");
        long backup=api.Lookup("SeBackupPrivilege"),restore=api.Lookup("SeRestorePrivilege");
        if(backup==restore)throw new InvalidOperationException("profile_privileges_unavailable");
        original=Copy(api.Read(token));requested=new Dictionary<long,uint>();
        foreach(long luid in new[]{backup,restore}){
          uint attributes;
          // Removed, used-for-access or unknown flags cannot be safely invented
          // or erased. Only exact default/enabled attributes are supported here.
          if(!original.TryGetValue(luid,out attributes) || (attributes&~3u)!=0)throw new InvalidOperationException("profile_privileges_unavailable");
          if((attributes&2u)==0)requested.Add(luid,attributes|2u);
        }
        var enabled=Copy(original);foreach(var item in requested)enabled[item.Key]=item.Value;
        if(requested.Count>0){
          adjustAttempted=true;
          PrivilegeAdjustment result=api.Adjust(token,new Dictionary<long,uint>(requested));
          previousValid=ValidPrevious(result);
          if(previousValid)previous=new Dictionary<long,uint>(result.Previous);
          // TRUE plus 1300 is a partial failure. A changed-state list is kept
          // before refusing so Dispose restores every proven changed target.
          if(result==null || !result.Success || result.Error!=0 || !previousValid || previous.Count!=requested.Count)
            throw new InvalidOperationException("profile_privileges_unavailable");
        }
        if(!Same(enabled,Copy(api.Read(token))))throw new InvalidOperationException("profile_privileges_unavailable");
        entered=true;
      }catch(Exception enterError){
        try{Dispose();}catch(Exception restoreError){throw new InvalidOperationException("profile_privilege_restore_unverified",new AggregateException(enterError,restoreError));}
        throw new InvalidOperationException("profile_privileges_unavailable",enterError);
      }
    }
    public void Dispose() {
      if(disposed){
        if(Unresolved)throw new InvalidOperationException("profile_privilege_restore_unverified");
        return;
      }
      disposed=true;
      try {
        if(token==IntPtr.Zero){RestorationVerified=true;return;}
        if(adjustAttempted){
          if(!previousValid || previous==null)throw new InvalidOperationException("previous_state_unverified");
          if(previous.Count>0){
            var result=api.Adjust(token,new Dictionary<long,uint>(previous));
            if(result==null || !result.Success || result.Error!=0)throw new InvalidOperationException("restore_failed");
          }
        }
        if(original!=null && !Same(original,Copy(api.Read(token))))throw new InvalidOperationException("restore_readback_mismatch");
        api.CloseOwnToken(token);token=IntPtr.Zero;RestorationVerified=true;
      }catch(Exception error){Unverified(error);}
    }
  }
  sealed class NativeProfilePrivilegeApi : IProfilePrivilegeApi {
    static Dictionary<long,uint> Parse(IntPtr buffer,int bytes) {
      if(buffer==IntPtr.Zero || bytes<4 || bytes>65536)throw new InvalidOperationException("profile_privileges_unavailable");
      int count=Marshal.ReadInt32(buffer);
      if(count<0 || count>4096 || 4L+12L*count>bytes)throw new InvalidOperationException("profile_privileges_unavailable");
      var result=new Dictionary<long,uint>();
      for(int i=0;i<count;i++){
        long luid=Marshal.ReadInt64(buffer,4+12*i);uint attributes=unchecked((uint)Marshal.ReadInt32(buffer,12+12*i));
        if(result.ContainsKey(luid))throw new InvalidOperationException("profile_privileges_unavailable");
        result.Add(luid,attributes);
      }
      return result;
    }
    public IntPtr OpenOwnProcessToken(){IntPtr token;Check(OpenProcessToken(GetCurrentProcess(),0x28,out token));return token;}
    public long Lookup(string name){long luid;Check(LookupPrivilegeValueW(null,name,out luid));return luid;}
    public Dictionary<long,uint> Read(IntPtr token){
      int needed;bool first=GetTokenInformation(token,3,IntPtr.Zero,0,out needed);int error=Marshal.GetLastPInvokeError();
      if(first || error!=122 || needed<4 || needed>65536)throw new InvalidOperationException("profile_privileges_unavailable");
      IntPtr buffer=Marshal.AllocHGlobal(needed);
      try{int actual;Check(GetTokenInformation(token,3,buffer,needed,out actual));if(actual>needed)throw new InvalidOperationException("profile_privileges_unavailable");return Parse(buffer,actual);}
      finally{Marshal.FreeHGlobal(buffer);}
    }
    public PrivilegeAdjustment Adjust(IntPtr token,Dictionary<long,uint> state){
      if(state==null || state.Count<1 || state.Count>2)throw new InvalidOperationException("profile_privileges_unavailable");
      int bytes=4+12*state.Count;
      IntPtr next=Marshal.AllocHGlobal(bytes),prior=Marshal.AllocHGlobal(bytes);
      try{
        for(int i=0;i<bytes;i++){Marshal.WriteByte(next,i,0);Marshal.WriteByte(prior,i,0);}
        Marshal.WriteInt32(next,state.Count);int index=0;
        foreach(var item in state){if((item.Value&~3u)!=0)throw new InvalidOperationException("profile_privileges_unavailable");Marshal.WriteInt64(next,4+12*index,item.Key);Marshal.WriteInt32(next,12+12*index,unchecked((int)item.Value));index++;}
        int returned;
        // .NET (Core), unlike .NET Framework, clears last-error before a
        // SetLastError=true P/Invoke. Capture it before ANY other native call.
        bool success=AdjustTokenPrivileges(token,false,next,bytes,prior,out returned);
        int error=Marshal.GetLastPInvokeError();
        var result=new PrivilegeAdjustment{Success=success,Error=error,PreviousValid=false,Previous=null};
        if(returned>=4 && returned<=bytes){
          try{result.Previous=Parse(prior,returned);result.PreviousValid=true;}catch{result.PreviousValid=false;}
        }
        return result;
      }finally{Marshal.FreeHGlobal(next);Marshal.FreeHGlobal(prior);}
    }
    public void CloseOwnToken(IntPtr token){Check(CloseHandle(token));}
  }
  public static bool ProfilePrivilegesAssigned() {
    var api=new NativeProfilePrivilegeApi();IntPtr token=api.OpenOwnProcessToken();
    try{
      long backup=api.Lookup("SeBackupPrivilege"),restore=api.Lookup("SeRestorePrivilege");
      var privileges=api.Read(token);return backup!=restore && privileges.ContainsKey(backup) && privileges.ContainsKey(restore);
    }finally{api.CloseOwnToken(token);}
  }

  public static bool VerifyExports() {
    var groups=new Dictionary<string,string[]> {
      {"kernel32.dll",new[]{"CreateFileW","GetFileInformationByHandle","OpenProcess","GetProcessTimes","CloseHandle","TerminateProcess","WaitForSingleObject","QueryFullProcessImageNameW","GetExitCodeProcess","SetFileInformationByHandle","GetCurrentProcess"}},
      {"advapi32.dll",new[]{"OpenProcessToken","GetTokenInformation","LogonUserW","CreateProcessWithTokenW","GetSecurityInfo","GetSecurityDescriptorLength","LookupPrivilegeValueW","AdjustTokenPrivileges"}},
      {"userenv.dll",new[]{"CreateProfile","DeleteProfileW","GetProfilesDirectoryW","LoadUserProfileW","UnloadUserProfile","CreateEnvironmentBlock","DestroyEnvironmentBlock"}},
      {"wtsapi32.dll",new[]{"WTSEnumerateSessionsW","WTSQuerySessionInformationW","WTSFreeMemory"}},
      {"user32.dll",new[]{"WaitForInputIdle","EnumWindows","IsWindowVisible","GetWindowThreadProcessId"}},
      {"netapi32.dll",new[]{"NetLocalGroupGetMembers","NetUserGetLocalGroups","NetApiBufferSize","NetApiBufferFree"}}
    };
    foreach(var group in groups) {
      IntPtr module=LoadLibraryExW(group.Key,IntPtr.Zero,0x800);if(module==IntPtr.Zero)return false;
      try { foreach(var name in group.Value)if(GetProcAddress(module,name)==IntPtr.Zero)return false; }
      finally { FreeLibrary(module); }
    } return true;
  }

  [DllImport("netapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int NetLocalGroupGetMembers(string server,string group,int level,out IntPtr buffer,uint preferred,out uint read,out uint total,ref UIntPtr resume);
  [DllImport("netapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int NetUserGetLocalGroups(string server,string user,int level,uint flags,out IntPtr buffer,uint preferred,out uint read,out uint total);
  [DllImport("netapi32.dll",ExactSpelling=true)] static extern int NetApiBufferSize(IntPtr buffer,out uint bytes);
  [DllImport("netapi32.dll",ExactSpelling=true)] static extern int NetApiBufferFree(IntPtr buffer);
  public sealed class GroupMemberPage {public int Status;public ulong Resume;public bool BufferVerified;public string[] Sids;}
  public interface IGroupMemberApi {GroupMemberPage ReadPage(string group,ulong resume);}
  static int GroupBufferSize(IntPtr buffer) {
    uint bytes;if(buffer==IntPtr.Zero || NetApiBufferSize(buffer,out bytes)!=0 || bytes>16777216)throw new InvalidOperationException("standard_account_unverified");
    return checked((int)bytes);
  }
  static string SidWithinBuffer(IntPtr sid,IntPtr buffer,int bytes) {
    long offset=sid.ToInt64()-buffer.ToInt64();
    if(sid==IntPtr.Zero || offset<0 || offset+8>bytes || Marshal.ReadByte(sid)!=1)throw new InvalidOperationException("standard_account_unverified");
    int count=Marshal.ReadByte(sid,1),length=8+4*count;
    if(count>15 || offset+length>bytes)throw new InvalidOperationException("standard_account_unverified");
    byte[] data=new byte[length];Marshal.Copy(sid,data,0,length);return new SecurityIdentifier(data,0).Value;
  }
  sealed class NativeGroupMemberApi : IGroupMemberApi {
    public GroupMemberPage ReadPage(string group,ulong cursor) {
      IntPtr buffer=IntPtr.Zero;UIntPtr resume=new UIntPtr(cursor);uint read,total;
      int status=NetLocalGroupGetMembers(null,group,0,out buffer,32768,out read,out total,ref resume);
      try {
        if(status!=0 && status!=234)return new GroupMemberPage{Status=status,Resume=resume.ToUInt64(),BufferVerified=true,Sids=new string[0]};
        if(read>16384 || read>0 && buffer==IntPtr.Zero)throw new InvalidOperationException("standard_account_unverified");
        int bytes=buffer==IntPtr.Zero?0:GroupBufferSize(buffer);
        if((long)read*IntPtr.Size>bytes)throw new InvalidOperationException("standard_account_unverified");
        var sids=new string[read];
        for(int i=0;i<read;i++)sids[i]=SidWithinBuffer(Marshal.ReadIntPtr(buffer,i*IntPtr.Size),buffer,bytes);
        return new GroupMemberPage{Status=status,Resume=resume.ToUInt64(),BufferVerified=true,Sids=sids};
      }finally{if(buffer!=IntPtr.Zero && NetApiBufferFree(buffer)!=0)throw new InvalidOperationException("standard_account_unverified");}
    }
  }
  public static string[] ReadLocalGroupSids(string group) {return ReadLocalGroupSids(group,new NativeGroupMemberApi());}
  public static string[] ReadLocalGroupSids(string group,IGroupMemberApi api) {
    if(String.IsNullOrEmpty(group) || group.Length>256 || api==null)throw new InvalidOperationException("standard_account_unverified");
    var all=new HashSet<string>(StringComparer.Ordinal);var cursors=new HashSet<ulong>();ulong cursor=0;
    for(int pageNumber=0;pageNumber<256;pageNumber++){
      GroupMemberPage page=api.ReadPage(group,cursor);
      if(page==null || !page.BufferVerified || page.Sids==null || page.Sids.Length>16384 || (page.Status!=0 && page.Status!=234))throw new InvalidOperationException("standard_account_unverified");
      foreach(string sid in page.Sids){
        if(String.IsNullOrEmpty(sid) || new SecurityIdentifier(sid).Value!=sid || !all.Add(sid) || all.Count>16384)throw new InvalidOperationException("standard_account_unverified");
      }
      if(page.Status==0){var result=new string[all.Count];all.CopyTo(result);return result;}
      if(page.Sids.Length==0 || page.Resume==0 || page.Resume==cursor || !cursors.Add(page.Resume))throw new InvalidOperationException("standard_account_unverified");
      cursor=page.Resume;
    }
    throw new InvalidOperationException("standard_account_unverified");
  }
  public static string[] ReadUserLocalGroups(string user) {
    IntPtr buffer=IntPtr.Zero;uint read,total;
    int status=NetUserGetLocalGroups(null,user,0,1,out buffer,65536,out read,out total);
    try {
      if(status!=0 || read!=total || read>4096 || read>0 && buffer==IntPtr.Zero)throw new InvalidOperationException("standard_account_unverified");
      int bytes=buffer==IntPtr.Zero?0:GroupBufferSize(buffer);
      if((long)read*IntPtr.Size>bytes)throw new InvalidOperationException("standard_account_unverified");
      var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      for(int i=0;i<read;i++){
        IntPtr text=Marshal.ReadIntPtr(buffer,i*IntPtr.Size);long offset=text.ToInt64()-buffer.ToInt64();
        if(text==IntPtr.Zero || offset<0 || offset>=bytes)throw new InvalidOperationException("standard_account_unverified");
        var name=new StringBuilder();bool ended=false;
        for(int n=0;n<=256 && offset+2*n+2<=bytes;n++){char c=(char)Marshal.ReadInt16(text,2*n);if(c=='\0'){ended=true;break;}name.Append(c);}
        if(!ended || name.Length==0 || name.Length>256 || !names.Add(name.ToString()))throw new InvalidOperationException("standard_account_unverified");
      }
      var result=new string[names.Count];names.CopyTo(result);return result;
    }finally{if(buffer!=IntPtr.Zero && NetApiBufferFree(buffer)!=0)throw new InvalidOperationException("standard_account_unverified");}
  }
  public sealed class StandardTokenSnapshot {public string UserSid;public Dictionary<string,uint> Groups;public int Elevation,ElevationType;}
  public static void VerifyStandardTokenSnapshot(string sid,StandardTokenSnapshot snapshot) {
    if(String.IsNullOrEmpty(sid) || new SecurityIdentifier(sid).Value!=sid || snapshot==null || snapshot.UserSid!=sid ||
      snapshot.Groups==null || snapshot.Groups.Count>4096 || snapshot.Elevation<0 || snapshot.Elevation>1 ||
      snapshot.ElevationType<1 || snapshot.ElevationType>3)throw new InvalidOperationException("standard_account_unverified");
    if(snapshot.Elevation!=0 || snapshot.ElevationType!=1)throw new InvalidOperationException("standard_account_privileged");
    uint users;
    // An Administrators SID is forbidden even when UAC marks it deny-only.
    if(snapshot.Groups.ContainsKey("S-1-5-32-544"))throw new InvalidOperationException("standard_account_privileged");
    if(!snapshot.Groups.TryGetValue("S-1-5-32-545",out users) || (users&4u)==0 || (users&16u)!=0)throw new InvalidOperationException("standard_account_unverified");
  }
  static IntPtr ReadTokenBuffer(IntPtr token,int kind,out int bytes) {
    bool first=GetTokenInformation(token,kind,IntPtr.Zero,0,out bytes);int error=Marshal.GetLastPInvokeError();
    if(first || error!=122 || bytes<4 || bytes>65536)throw new InvalidOperationException("standard_account_unverified");
    IntPtr buffer=Marshal.AllocHGlobal(bytes);
    try{int actual;Check(GetTokenInformation(token,kind,buffer,bytes,out actual));if(actual<4 || actual>bytes)throw new InvalidOperationException("standard_account_unverified");bytes=actual;return buffer;}
    catch{Marshal.FreeHGlobal(buffer);throw;}
  }
  static int TokenScalar(IntPtr token,int kind) {
    IntPtr buffer=Marshal.AllocHGlobal(4);
    try{int bytes;Check(GetTokenInformation(token,kind,buffer,4,out bytes));if(bytes!=4)throw new InvalidOperationException("standard_account_unverified");return Marshal.ReadInt32(buffer);}
    finally{Marshal.FreeHGlobal(buffer);}
  }
  public static void RequireStandardToken(IntPtr token,string sid) {
    int bytes;IntPtr buffer=ReadTokenBuffer(token,2,out bytes);
    try {
      int count=Marshal.ReadInt32(buffer),start=IntPtr.Size==8?8:4,stride=IntPtr.Size==8?16:8;
      if(count<1 || count>4096 || start+(long)count*stride>bytes)throw new InvalidOperationException("standard_account_unverified");
      var groups=new Dictionary<string,uint>(StringComparer.Ordinal);
      for(int i=0;i<count;i++){
        int offset=start+i*stride;string group=SidWithinBuffer(Marshal.ReadIntPtr(buffer,offset),buffer,bytes);
        if(groups.ContainsKey(group))throw new InvalidOperationException("standard_account_unverified");
        groups.Add(group,unchecked((uint)Marshal.ReadInt32(buffer,offset+IntPtr.Size)));
      }
      VerifyStandardTokenSnapshot(sid,new StandardTokenSnapshot{UserSid=SidOfToken(token),Groups=groups,Elevation=TokenScalar(token,20),ElevationType=TokenScalar(token,18)});
    }finally{Marshal.FreeHGlobal(buffer);}
  }
  static void RequireStandardProcess(IntPtr process,string sid) {
    IntPtr token;Check(OpenProcessToken(process,8,out token));
    try{RequireStandardToken(token,sid);}finally{CloseHandle(token);}
  }

  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static SafeFileHandle GuardDirectory(string path) {
    var h=CreateFileW(path,0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(h.IsInvalid) { h.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
    Info i; if(!GetFileInformationByHandle(h,out i) || (i.Attributes&0x400)!=0 || (i.Attributes&0x10)==0) { h.Dispose(); throw new InvalidOperationException("path_unverified"); }
    return h;
  }
  public static string ProfilesRoot() { uint n=32768;var b=new StringBuilder((int)n);Check(GetProfilesDirectoryW(b,ref n));return b.ToString(); }
  static string SidOfToken(IntPtr token) {
    int n;GetTokenInformation(token,1,IntPtr.Zero,0,out n);
    if(n<1 || n>65536) throw new InvalidOperationException("token_unverified");
    IntPtr p=Marshal.AllocHGlobal(n);
    try { Check(GetTokenInformation(token,1,p,n,out n));return new SecurityIdentifier(Marshal.ReadIntPtr(p)).Value; }
    finally { Marshal.FreeHGlobal(p); }
  }
  static Proc FromHandle(IntPtr h,int id) {
    IntPtr token;Check(OpenProcessToken(h,8,out token));
    try { long c,e,k,u;Check(GetProcessTimes(h,out c,out e,out k,out u));return new Proc { Id=id,Sid=SidOfToken(token),Created=c }; }
    finally { CloseHandle(token); }
  }
  public static Proc ReadProcess(int id) {
    IntPtr h=OpenProcess(0x00101000,false,id);if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return FromHandle(h,id); } finally { CloseHandle(h); }
  }
  public static void StopOwnedProcess(int id,long creation,string sid) {
    IntPtr h=OpenProcess(0x00101001,false,id);if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { var p=FromHandle(h,id);if(p.Created!=creation || p.Sid!=sid) throw new InvalidOperationException("process_identity_changed");
      Check(TerminateProcess(h,1));if(WaitForSingleObject(h,3000)!=0) throw new InvalidOperationException("process_exit_unverified"); }
    finally { CloseHandle(h); }
  }
  static string SessionText(int id,int kind) {
    IntPtr p;int n;Check(WTSQuerySessionInformationW(IntPtr.Zero,id,kind,out p,out n));
    try { if(n<2 || n>65536) throw new InvalidOperationException("session_unverified");return Marshal.PtrToStringUni(p)??""; }
    finally { WTSFreeMemory(p); }
  }
  public static UserSession[] Sessions() {
    IntPtr p;int n;Check(WTSEnumerateSessionsW(IntPtr.Zero,0,1,out p,out n));
    try {
      if(n<0 || n>4096) throw new InvalidOperationException("session_unverified");
      var result=new List<UserSession>();int size=Marshal.SizeOf(typeof(Session));
      int current=Process.GetCurrentProcess().SessionId;string own=WindowsIdentity.GetCurrent().User.Value;
      for(int i=0;i<n;i++) { var s=(Session)Marshal.PtrToStructure(IntPtr.Add(p,i*size),typeof(Session));var r=new UserSession { Id=s.Id,Known=false,Occupied=true };
        try { string name=SessionText(s.Id,5),domain=SessionText(s.Id,7);
          if(name.Length==0 && domain.Length==0) { r.Occupied=false;r.Known=true; }
          else if(s.Id==current) { r.Sid=own;r.Known=true; }
          // Other occupied sessions stay unknown; never infer their token SID from a name.
          else { r.Known=false; }
        } catch { r.Known=false; }
        result.Add(r);
      } return result.ToArray();
    } finally { WTSFreeMemory(p); }
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProfileInfo {
    public int Size,Flags; [MarshalAs(UnmanagedType.LPWStr)] public string UserName,ProfilePath,DefaultPath,ServerName,PolicyPath; public IntPtr Profile;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo {
    public int Size;public string Reserved,Desktop,Title;public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;public ushort Show,Reserved2Size;public IntPtr Reserved2,StdIn,StdOut,StdErr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Process,Thread;public uint Id,ThreadId;}
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUserW(string user,string domain,string secret,int kind,int provider,out IntPtr token);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LoadUserProfileW(IntPtr token,ref ProfileInfo profile);
  [DllImport("userenv.dll",SetLastError=true)] static extern bool UnloadUserProfile(IntPtr token,IntPtr profile);
  [DllImport("userenv.dll",SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr env,IntPtr token,bool inherit);
  [DllImport("userenv.dll",SetLastError=true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint flags,string application,StringBuilder command,uint creationFlags,IntPtr env,string currentDirectory,ref StartupInfo startup,out ProcessInfo process);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool RevertToSelf();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,int flags,StringBuilder path,ref int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("user32.dll",SetLastError=true)] static extern uint WaitForInputIdle(IntPtr process,uint ms);
  delegate bool WindowCallback(IntPtr window,IntPtr data);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(WindowCallback callback,IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  public sealed class WorkflowHandles {
    public IntPtr Token,Profile,Process; public int ProcessId;public long Created; public string Sid,Exe,ProfilePath;public bool Launched,ResourcesReleased;
    public ProfilePrivilegeScope ProfilePrivileges;
  }
  public static WorkflowHandles LoadOwnedProfile(string secret,string expectedSid,string exactProfile) {
    IntPtr token;Check(LogonUserW("user1",".",secret,2,0,out token));
    // Return custody before LoadUserProfile: callers retain this object even if load throws.
    try {
      var result=new WorkflowHandles {Token=token,Sid=SidOfToken(token),ProfilePath=exactProfile};
      if(result.Sid!=expectedSid)throw new InvalidOperationException("identity_mismatch");
      RequireStandardToken(token,expectedSid);
      return result;
    }catch{CloseHandle(token);throw;}
  }
  public static void LoadProfile(WorkflowHandles owned) {
    if(owned.Token==IntPtr.Zero || owned.Profile!=IntPtr.Zero || owned.ResourcesReleased)throw new InvalidOperationException("workflow_invalid");
    var privileges=new ProfilePrivilegeScope(new NativeProfilePrivilegeApi());owned.ProfilePrivileges=privileges;
    privileges.Execute(delegate {
      var pi=new ProfileInfo {Size=Marshal.SizeOf(typeof(ProfileInfo)),Flags=1,UserName="user1"};
      bool loaded=LoadUserProfileW(owned.Token,ref pi);int error=Marshal.GetLastPInvokeError();
      // Preserve any returned owned profile reference even when the API fails.
      if(pi.Profile!=IntPtr.Zero)owned.Profile=pi.Profile;
      if(!loaded)throw new Win32Exception(error);
      if(pi.Profile==IntPtr.Zero)throw new InvalidOperationException("profile_unverified");
    });
  }
  static Dictionary<string,string> EnvironmentOf(IntPtr block) {
    var result=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);int offset=0;
    while(offset<65536){
      string value=Marshal.PtrToStringUni(IntPtr.Add(block,offset));if(value==null)throw new InvalidOperationException("environment_unverified");
      if(value.Length==0)return result;int split=value.IndexOf('=',1);if(split>0)result[value.Substring(0,split)]=value.Substring(split+1);
      offset+=(value.Length+1)*2;
    }throw new InvalidOperationException("environment_unverified");
  }
  public static void Launch(WorkflowHandles owned,string exe) {
    if(owned.Token==IntPtr.Zero || owned.Profile==IntPtr.Zero || owned.Process!=IntPtr.Zero || owned.ResourcesReleased)throw new InvalidOperationException("workflow_invalid");
    if(SidOfToken(owned.Token)!=owned.Sid)throw new InvalidOperationException("identity_mismatch");
    RequireStandardToken(owned.Token,owned.Sid);
    IntPtr env;Check(CreateEnvironmentBlock(out env,owned.Token,false));
    try {
      var values=EnvironmentOf(env);string profile;
      if(!values.TryGetValue("USERPROFILE",out profile) || !String.Equals(profile,owned.ProfilePath,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("profile_unverified");
      var startup=new StartupInfo {Size=Marshal.SizeOf(typeof(StartupInfo)),Desktop=@"winsta0\default"};ProcessInfo p;
      Check(CreateProcessWithTokenW(owned.Token,1,exe,new StringBuilder("\""+exe+"\""),0x400,env,System.IO.Path.GetDirectoryName(exe),ref startup,out p));
      owned.Process=p.Process;owned.ProcessId=(int)p.Id;owned.Exe=exe;owned.Launched=true;CloseHandle(p.Thread);
      var actual=FromHandle(owned.Process,owned.ProcessId);owned.Created=actual.Created;
      if(actual.Sid!=owned.Sid)throw new InvalidOperationException("identity_mismatch");
    }finally{Check(DestroyEnvironmentBlock(env));}
  }
  public static bool VerifyLive(WorkflowHandles owned,bool requireReady) {
    if(owned.Process==IntPtr.Zero || owned.ResourcesReleased)throw new InvalidOperationException("workflow_invalid");
    var actual=FromHandle(owned.Process,owned.ProcessId);
    if(actual.Sid!=owned.Sid || actual.Created!=owned.Created)throw new InvalidOperationException("identity_mismatch");
    RequireStandardProcess(owned.Process,owned.Sid);
    uint exit;Check(GetExitCodeProcess(owned.Process,out exit));if(exit!=259)throw new InvalidOperationException("zoom_exited");
    int length=32768;var path=new StringBuilder(length);Check(QueryFullProcessImageNameW(owned.Process,0,path,ref length));
    if(!String.Equals(path.ToString(),owned.Exe,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("identity_mismatch");
    if(!requireReady)return true;
    uint idle=WaitForInputIdle(owned.Process,5000);if(idle!=0)throw new InvalidOperationException("zoom_not_ready");
    bool visible=false;
    Check(EnumWindows(delegate(IntPtr window,IntPtr data){uint id;GetWindowThreadProcessId(window,out id);if(id==owned.ProcessId && IsWindowVisible(window))visible=true;return true;},IntPtr.Zero));
    if(!visible)throw new InvalidOperationException("zoom_not_ready");
    // Recheck identity/liveness after the window observation.
    actual=FromHandle(owned.Process,owned.ProcessId);Check(GetExitCodeProcess(owned.Process,out exit));
    if(exit!=259 || actual.Sid!=owned.Sid || actual.Created!=owned.Created)throw new InvalidOperationException("identity_mismatch");
    return true;
  }
  public static void ReleaseOwned(WorkflowHandles owned) {
    if(PrivilegeCustodyUnresolved || owned.ProfilePrivileges!=null && !owned.ProfilePrivileges.RestorationVerified)throw new InvalidOperationException("profile_privilege_restore_unverified");
    // Unload only the reference returned by our successful LoadUserProfile call.
    if(owned.Profile!=IntPtr.Zero){Check(UnloadUserProfile(owned.Token,owned.Profile));owned.Profile=IntPtr.Zero;}
    if(owned.Token!=IntPtr.Zero){Check(CloseHandle(owned.Token));owned.Token=IntPtr.Zero;}
    if(owned.Process!=IntPtr.Zero){Check(CloseHandle(owned.Process));owned.Process=IntPtr.Zero;}
    owned.ResourcesReleased=true;
  }


  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file,int kind,IntPtr data,uint size);

  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle,int kind,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static void AssertOwnedDirectoryHandle(SafeFileHandle handle,string sid) {
    IntPtr owner,group,dacl,sacl,sd;uint error=GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out sd);
    if(error!=0)throw new Win32Exception((int)error);
    try {
      string ownerSid=new SecurityIdentifier(owner).Value;
      var allowed=new HashSet<string> {sid,"S-1-5-18","S-1-5-32-544"};
      if(!allowed.Contains(ownerSid) || dacl==IntPtr.Zero)throw new InvalidOperationException("ownership_unverified");
      uint length=GetSecurityDescriptorLength(sd);if(length<20 || length>65536)throw new InvalidOperationException("ownership_unverified");
      byte[] bytes=new byte[length];Marshal.Copy(sd,bytes,0,(int)length);
      var descriptor=new RawSecurityDescriptor(bytes,0);
      if(descriptor.DiscretionaryAcl==null)throw new InvalidOperationException("ownership_unverified");
      foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
        var common=ace as CommonAce;
        if(common==null)throw new InvalidOperationException("ownership_unverified");
        if(common.AceQualifier==AceQualifier.AccessAllowed && (common.AccessMask&unchecked((int)0x500d0156))!=0) {
          if(common.SecurityIdentifier.Value=="S-1-3-0" && (common.AceFlags&AceFlags.InheritOnly)!=0)continue;
          if(!allowed.Contains(common.SecurityIdentifier.Value))throw new InvalidOperationException("ownership_unverified");
        }
      }
    }finally{LocalFree(sd);}
  }

  public sealed class QuarantineProof {public string Path,FileId;public uint Volume;}
  public static string FileIdentity(SafeFileHandle handle) {
    Info info;Check(GetFileInformationByHandle(handle,out info));
    if((info.Attributes&0x400)!=0 || (info.Attributes&0x10)!=0)throw new InvalidOperationException("storage_unverified");
    return info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");
  }
  public static void VerifyQuarantine(string path,string expectedSid,uint volume,string fileId) {
    using(var handle=CreateFileW(path,0x00020080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      AssertOwnedDirectoryHandle(handle,expectedSid);
      Info actual;Check(GetFileInformationByHandle(handle,out actual));
      if((actual.Attributes&0x400)!=0 || (actual.Attributes&0x10)==0 || actual.Volume!=volume ||
        actual.IndexHigh.ToString("x8")+actual.IndexLow.ToString("x8")!=fileId)throw new InvalidOperationException("identity_mismatch");
    }
  }
  public static QuarantineProof Quarantine(string path,string destination,string expectedSid) {
    // No FILE_SHARE_DELETE: pin this exact directory against replacement.
    using(var h=CreateFileW(path,0x00030080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(h.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      AssertOwnedDirectoryHandle(h,expectedSid);
      Info before;Check(GetFileInformationByHandle(h,out before));
      if((before.Attributes&0x400)!=0 || (before.Attributes&0x10)==0)throw new InvalidOperationException("path_unverified");
      // FILE_RENAME_INFO: ReplaceIfExists=false, RootDirectory=NULL, absolute UTF-16 name.
      byte[] name=Encoding.Unicode.GetBytes(destination);
      int rootOffset=IntPtr.Size==8?8:4,lengthOffset=rootOffset+IntPtr.Size,nameOffset=lengthOffset+4;
      IntPtr data=Marshal.AllocHGlobal(nameOffset+name.Length);
      try {
        for(int i=0;i<nameOffset;i++)Marshal.WriteByte(data,i,0);
        Marshal.WriteInt32(data,lengthOffset,name.Length);Marshal.Copy(name,0,IntPtr.Add(data,nameOffset),name.Length);
        Check(SetFileInformationByHandle(h,3,data,(uint)(nameOffset+name.Length)));
      }finally{Marshal.FreeHGlobal(data);}
      Info after;Check(GetFileInformationByHandle(h,out after));
      if(after.Volume!=before.Volume || after.IndexHigh!=before.IndexHigh || after.IndexLow!=before.IndexLow)throw new InvalidOperationException("identity_mismatch");
      using(var named=CreateFileW(destination,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
        if(named.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
        Info readback;Check(GetFileInformationByHandle(named,out readback));
        if((readback.Attributes&0x400)!=0 || readback.Volume!=before.Volume || readback.IndexHigh!=before.IndexHigh || readback.IndexLow!=before.IndexLow)throw new InvalidOperationException("identity_mismatch");
      }
      return new QuarantineProof {Path=destination,Volume=before.Volume,FileId=before.IndexHigh.ToString("x8")+before.IndexLow.ToString("x8")};
    }
  }

  public static void Purge(string sid,string path) { Check(DeleteProfileW(sid,path,null)); }
  public static string Provision(string sid) { var b=new StringBuilder(32768);int hr=CreateProfile(sid,"user1",b,(uint)b.Capacity);if(hr!=0) Marshal.ThrowExceptionForHR(hr);return b.ToString(); }
}
'@


function Assert-NoForeignWriters([string]$path,[string]$sid) {
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowed=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if($sid){$allowed+=,$sid}
  if($owner -notin $allowed){Deny 'identity_mismatch'}
  $writeMask=[int64][Security.AccessControl.FileSystemRights]::Write -bor [int64][Security.AccessControl.FileSystemRights]::Delete -bor [int64][Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int64][Security.AccessControl.FileSystemRights]::TakeOwnership -bor [int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
  foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($ace.AccessControlType -eq 'Allow' -and ([int64]$ace.FileSystemRights -band $writeMask) -ne 0){
      $principal=$ace.IdentityReference.Value
      if($principal -eq 'S-1-3-0' -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}
      if($principal -notin $allowed){Deny 'identity_mismatch'}
    }
  }
}
function Assert-ProfileNamespaceProtected {
  foreach($path in @('C:\','C:\Users')){
    if($path -eq 'C:\Users'){Assert-NoForeignWriters $path $null}
    $item=Read-ItemExact $path
    if($null -eq $item -or !$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Deny 'identity_mismatch'}
  }
  return $true
}

function Local-Account {
  $all = @(Microsoft.PowerShell.LocalAccounts\Get-LocalUser -ErrorAction Stop)
  $match = @($all | Where-Object { $_.Name.Equals('user1',[StringComparison]::OrdinalIgnoreCase) })
  if($match.Count -gt 1) { Deny 'identity_mismatch' }
  if($match.Count -eq 0) { return $null }
  $u = $match[0]
  if($u.SID.Value -notmatch ('^'+[regex]::Escape($script:MachineSid)+'-[1-9][0-9]*$')) { Deny 'identity_mismatch' }
  $rid = [uint64]($u.SID.Value.Split('-')[-1])
  if($rid -lt 1000 -or $rid -gt [uint32]::MaxValue -or $u.PrincipalSource.ToString() -ne 'Local' -or $u.Enabled -isnot [bool]) { Deny 'identity_mismatch' }
  return $u
}
function Current-Profile {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $p = @(Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='"+$sid+"'") -OperationTimeoutSec 10 -ErrorAction Stop)
  if($p.Count -ne 1 -or !$p[0].LocalPath -or (ExactPath $p[0].LocalPath) -or $p[0].LocalPath.StartsWith($script:Target+'\',[StringComparison]::OrdinalIgnoreCase) -or $script:Target.StartsWith($p[0].LocalPath.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { Deny 'identity_mismatch' }
  return @{ sid=$sid;path=[string]$p[0].LocalPath }
}

function Resolve-BuiltinAlias([string]$sid) {
  if($sid -notin @('S-1-5-32-545','S-1-5-32-544')){Deny 'standard_account_unverified'}
  $groups=@(Microsoft.PowerShell.LocalAccounts\Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new($sid)) -ErrorAction Stop)
  if($groups.Count -ne 1 -or $groups[0].SID.Value -cne $sid -or $groups[0].Name -isnot [string] -or !$groups[0].Name -or $groups[0].Name.Length -gt 256){Deny 'standard_account_unverified'}
  return @{sid=$sid;name=[string]$groups[0].Name}
}
function Read-StandardAccountFacts($c,[string]$sid) {
  $started=Millis;Assert-Context $c;$j=Owned-Journal $c
  if($sid -cne $script:CreatedSid -or $j.phase -notin @('creating-account','binding-account','creating-profile','enabling-account','application-workflow') -or
    ($c.operation.accountSid -ne $sid -and !($null -eq $c.operation.accountSid -and $j.phase -eq 'creating-account' -and $j.newAccountSid -ceq $sid))){Deny 'standard_account_unverified'}
  $u=Local-Account;$current=Current-Profile
  if($null -eq $u -or $u.SID.Value -cne $sid -or $sid -ceq $current.sid){Deny 'identity_mismatch'}
  $users=Resolve-BuiltinAlias 'S-1-5-32-545';$admins=Resolve-BuiltinAlias 'S-1-5-32-544'
  $usersMembers=@([FixerResetNativeV1]::ReadLocalGroupSids($users.name))
  $adminMembers=@([FixerResetNativeV1]::ReadLocalGroupSids($admins.name))
  $effective=@([FixerResetNativeV1]::ReadUserLocalGroups('user1'))
  $usersAfter=Resolve-BuiltinAlias 'S-1-5-32-545';$adminsAfter=Resolve-BuiltinAlias 'S-1-5-32-544'
  if($usersAfter.name -cne $users.name -or $adminsAfter.name -cne $admins.name){Deny 'standard_account_unverified'}
  $indirectAdmin=@($effective | Where-Object {$_.Equals($admins.name,[StringComparison]::OrdinalIgnoreCase)}).Count -ne 0
  $effectiveUsers=@($effective | Where-Object {$_.Equals($users.name,[StringComparison]::OrdinalIgnoreCase)}).Count -ne 0
  if(($sid -in $usersMembers) -ne $effectiveUsers){Deny 'standard_account_unverified'}
  # Reject common automatic principals if an unusual local policy made them
  # administrators. Never change that policy or another member to make us pass.
  $automatic=@($sid,'S-1-5-32-545','S-1-1-0','S-1-5-11','S-1-5-4','S-1-2-0','S-1-2-1','S-1-5-113','S-1-5-15','S-1-5-64-10',($script:MachineSid+'-513'))
  $directAdmin=@($adminMembers | Where-Object {$_ -in $automatic}).Count -ne 0
  $final=Local-Account
  if($null -eq $final -or $final.SID.Value -cne $sid -or $final.Enabled -ne $u.Enabled){Deny 'identity_mismatch'}
  if((Millis)-$started -ge 5000 -or $script:Lease.expiresAtMs -le (Millis)){Deny 'standard_account_unverified'}
  return @{account=$final;usersGroupSid='S-1-5-32-545';usersMembershipVerified=($sid -in $usersMembers);administratorsExcluded=(!$directAdmin -and !$indirectAdmin);groupEnumerationComplete=$true;standardAccountVerified=($sid -in $usersMembers -and !$directAdmin -and !$indirectAdmin);membershipProofKind='raw-local-sid'}
}
function Assert-StandardAccount($c,[string]$sid) {
  $facts=Read-StandardAccountFacts $c $sid
  if(!$facts.administratorsExcluded){Deny 'standard_account_privileged'}
  if(!$facts.usersMembershipVerified -or !$facts.groupEnumerationComplete -or !$facts.standardAccountVerified){Deny 'standard_account_unverified'}
  return $facts
}
function Ensure-StandardAccountMembership($c,[string]$sid) {
  $facts=Read-StandardAccountFacts $c $sid
  if(!$facts.administratorsExcluded){Deny 'standard_account_privileged'}
  if($facts.account.Enabled){Deny 'standard_account_unverified'}
  if(!$facts.usersMembershipVerified){
    $j=Owned-Journal $c
    if($j.phase -cne 'creating-account' -or $j.newAccountSid -cne $sid -or $facts.account.Enabled){Deny 'standard_account_unverified'}
    $j.usersMembershipIntent=$sid;Write-State 'journal.json' $j
    $fresh=Read-StandardAccountFacts $c $sid
    if($fresh.account.Enabled -or !$fresh.administratorsExcluded){Deny 'standard_account_unverified'}
    if(!$fresh.usersMembershipVerified){
      # Exact built-in alias SID and the actual newly-created LocalUser SID.
      # No account-name resolution, group replacement or unrelated-member edit.
      Microsoft.PowerShell.LocalAccounts\Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $fresh.account -ErrorAction Stop
    }
  }
  $verified=Assert-StandardAccount $c $sid
  if($verified.account.Enabled){Deny 'standard_account_unverified'}
  return $verified
}
function Set-StandardAccountProof($receipt,$facts) {
  foreach($key in @('usersGroupSid','usersMembershipVerified','administratorsExcluded','groupEnumerationComplete','standardAccountVerified','membershipProofKind')){$receipt[$key]=$facts[$key]}
  return $receipt
}


function Profile-Value($record,[string]$name) {
  if($null -eq $record){return $null}
  if($record -is [Collections.IDictionary]){
    if($record.Contains($name)){return ,$record[$name]}
    return $null
  }
  $property=$record.PSObject.Properties[$name]
  if($null -eq $property){return $null}
  return ,$property.Value
}
function Profile-True($value) {
  return $value -is [bool] -and $value
}
function Profile-CanonicalSid($value) {
  if($value -isnot [string] -or !$value){return $null}
  try{$sid=[Security.Principal.SecurityIdentifier]::new($value).Value;if(!$sid.Equals($value,[StringComparison]::OrdinalIgnoreCase)){return $null};return $sid}catch{return $null}
}
function Normalize-ProfilePath($value,$environment) {
  $bad=@{known=$false;path=$null;reason='malformed-profile-path'}
  if($value -isnot [string] -or !$value -or $value.Trim() -cne $value -or $value -match '[\x00-\x1f\x7f"<>|?*]'){return $bad}
  $path=$value
  foreach($match in [regex]::Matches($value,'%([^%]+)%')){
    $name=$match.Groups[1].Value.ToLowerInvariant()
    if($name -notin @('systemroot','windir','systemdrive','programdata') -or $environment -isnot [Collections.IDictionary] -or
      !$environment.Contains($name) -or $environment[$name] -isnot [string] -or !$environment[$name]){
      return @{known=$false;path=$null;reason='unexpanded-profile-path'}
    }
    $path=$path.Replace($match.Value,$environment[$name])
  }
  if($path.Contains('%')){return @{known=$false;path=$null;reason='unexpanded-profile-path'}}
  if($path.Trim() -cne $path -or $path -match '[\x00-\x1f\x7f"<>|?*]'){return $bad}
  $path=$path.Replace('/','\')
  if($path -notmatch '^[A-Za-z]:\\[^:]*$' -or $path.StartsWith('\')){return $bad}
  foreach($part in $path.Split('\')){
    if(!$part -or $part -in @('.','..') -or $part -match '^[A-Za-z]:$'){continue}
    if($part.TrimEnd(' ','.') -cne $part -or $part -match '~[0-9]' -or
      $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$'){return $bad}
  }
  try{$full=[IO.Path]::GetFullPath($path)}catch{return $bad}
  if($full.Length -gt 3){$full=$full.TrimEnd('\')}
  return @{known=$true;path=$full;reason=$null}
}
function Profile-PathRelation([string]$path,[string]$root) {
  if($path.Equals($root,[StringComparison]::OrdinalIgnoreCase)){return 'exact'}
  if($path.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){return 'descendant'}
  if($root.StartsWith($path.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){return 'ancestor'}
  return 'unrelated'
}
function Profile-NamespaceIssue($record,[string]$reason) {
  if(!$record.issues.Contains($reason)){[void]$record.issues.Add($reason)}
}
function Classify-ProfileNamespace($targetSid,$inventory,$quarantinePath=$null) {
  # A complete METADATA namespace proof. Foreign physical aliases are not
  # silently asserted disjoint; target/root/quarantine handle proofs stay separate.
  $environment=Profile-Value $inventory 'environment'
  $rows=[Collections.Generic.List[object]]::new()
  $globalUnknown=[Collections.Generic.HashSet[string]]::new()
  $blockers=[Collections.Generic.HashSet[string]]::new()
  $foreign=[Collections.Generic.HashSet[string]]::new()
  $targetConflicts=[Collections.Generic.HashSet[string]]::new()
  $evidence=[Collections.Generic.List[object]]::new()
  $complete=$true;$coverageKnown=$true
  $target=Profile-CanonicalSid $targetSid
  if($null -ne $targetSid -and $null -eq $target){[void]$globalUnknown.Add('invalid-target-sid')}
  $roots=@(@{name='canonical';path=$script:Target})
  if($null -ne $quarantinePath){
    $q=Normalize-ProfilePath $quarantinePath $environment
    if(!$q.known -or $q.path -notmatch ('^'+[regex]::Escape($script:StateRoot)+'\\purge-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')){
      [void]$globalUnknown.Add('invalid-quarantine-scope')
    }else{$roots+=,@{name='quarantine';path=$q.path}}
  }
  foreach($definition in @(
    @{source='cim';field='cimRecords';complete='cimComplete'},
    @{source='registry';field='registryRecords';complete='registryComplete'},
    @{source='configuration';field='configurationRecords';complete='configurationComplete'}
  )){
    if(!(Profile-True (Profile-Value $inventory $definition.complete))){$complete=$false;$coverageKnown=$false;[void]$globalUnknown.Add($definition.source+'-inventory-incomplete')}
    $records=Profile-Value $inventory $definition.field
    if($records -isnot [Array]){$complete=$false;$coverageKnown=$false;[void]$globalUnknown.Add($definition.source+'-inventory-missing');continue}
    if($records.Count -gt 4096){$complete=$false;$coverageKnown=$false;[void]$globalUnknown.Add($definition.source+'-inventory-too-large');continue}
    $index=0
    foreach($record in $records){
      $row=@{source=$definition.source;index=$index;sid=$null;path=$null;relation='unknown';scope=$null;backup=$false;name=$null;loaded=$null;special=$null;status=$null;issues=[Collections.Generic.List[string]]::new()}
      $index++
      if((Profile-Value $record 'source') -isnot [string] -or (Profile-Value $record 'source') -cne $definition.source){Profile-NamespaceIssue $row 'profile-source-unverified'}
      if(!(Profile-True (Profile-Value $record 'readComplete'))){$complete=$false;Profile-NamespaceIssue $row 'profile-record-unread'}
      if($definition.source -in @('registry','configuration') -and (Profile-Value $record 'valueKind') -notin @('String','ExpandString')){Profile-NamespaceIssue $row 'profile-path-kind-unverified'}
      # CIM LocalPath and REG_SZ are concrete paths; only REG_EXPAND_SZ has
      # machine-variable expansion semantics. No operator/user variable expands.
      $pathEnvironment=if($definition.source -ne 'cim' -and (Profile-Value $record 'valueKind') -eq 'ExpandString'){$environment}else{@{}}
      $normalized=Normalize-ProfilePath (Profile-Value $record 'rawPath') $pathEnvironment
      if(!$normalized.known){Profile-NamespaceIssue $row $normalized.reason}
      else{
        $row.path=$normalized.path;$row.relation='unrelated'
        foreach($root in $roots){
          $relation=Profile-PathRelation $row.path $root.path
          if($relation -ne 'unrelated'){$row.relation=$relation;$row.scope=$root.name;break}
        }
      }
      if($definition.source -eq 'configuration'){
        $row.name=Profile-Value $record 'name'
        if($row.name -notin @('Default','Public','ProgramData','ProfilesDirectory')){Profile-NamespaceIssue $row 'profile-config-unrecognized'}
        if($normalized.known){
          $container=($row.name -eq 'ProfilesDirectory' -and $row.path.Equals('C:\Users',[StringComparison]::OrdinalIgnoreCase)) -or
            ($row.name -eq 'ProgramData' -and $row.path.Equals('C:\ProgramData',[StringComparison]::OrdinalIgnoreCase))
          if($row.name -eq 'ProfilesDirectory' -and !$container){Profile-NamespaceIssue $row 'profiles-root-config-mismatch'}
          if($row.name -eq 'ProgramData' -and !$container){Profile-NamespaceIssue $row 'programdata-config-mismatch'}
          if($row.relation -ne 'unrelated' -and !$container){[void]$targetConflicts.Add('config|'+$row.name);[void]$blockers.Add('profile-config-overlap');$evidence.Add(@{source=$row.source;index=$row.index;scope=$row.scope;relation=$row.relation;reason='profile-config-overlap'})}
        }
      }else{
        $identity=if($definition.source -eq 'registry'){Profile-Value $record 'key'}else{Profile-Value $record 'sid'}
        if($definition.source -eq 'registry' -and $identity -is [string] -and $identity.EndsWith('.bak',[StringComparison]::OrdinalIgnoreCase)){
          $row.backup=$true;$identity=$identity.Substring(0,$identity.Length-4);Profile-NamespaceIssue $row 'backup-profile-registration'
        }
        $row.sid=Profile-CanonicalSid $identity
        if($null -eq $row.sid){Profile-NamespaceIssue $row 'profile-sid-unverified'}
        if($definition.source -eq 'cim'){
          $row.loaded=Profile-Value $record 'loaded';$row.special=Profile-Value $record 'special';$row.status=Profile-Value $record 'status'
          if($row.loaded -isnot [bool] -or $row.special -isnot [bool]){Profile-NamespaceIssue $row 'profile-state-unverified'}
          if(($row.status -isnot [int] -and $row.status -isnot [long] -and $row.status -isnot [uint32]) -or
            $row.status -lt 0 -or $row.status -gt 15){Profile-NamespaceIssue $row 'profile-status-unverified'}
        }
        if($null -ne $row.sid -and $normalized.known){
          $isTarget=($null -ne $target -and $row.sid -ceq $target)
          if($row.relation -ne 'unrelated' -and !$isTarget){
            [void]$foreign.Add($row.sid+'|'+$row.path.ToLowerInvariant());[void]$blockers.Add('foreign-profile-overlap')
            $evidence.Add(@{source=$row.source;index=$row.index;scope=$row.scope;relation=$row.relation;reason='foreign-profile-overlap'})
          }
          if($isTarget -and (!($row.path.Equals($script:Target,[StringComparison]::OrdinalIgnoreCase)) -or $row.backup -or
            ($row.source -eq 'cim' -and ($row.special -eq $true -or $row.status -ne 0)))){
            [void]$targetConflicts.Add($row.source+'|'+$row.index);[void]$blockers.Add('target-profile-mapping-conflict')
            $evidence.Add(@{source=$row.source;index=$row.index;scope=$row.scope;relation=$row.relation;reason='target-profile-mapping-conflict'})
          }
        }
      }
      $rows.Add($row)
    }
  }
  foreach($name in @('Default','Public','ProgramData','ProfilesDirectory')){
    $matches=@($rows | Where-Object {$_.source -eq 'configuration' -and $_.name -eq $name})
    if($matches.Count -eq 0){$complete=$false;$coverageKnown=$false;[void]$globalUnknown.Add('profile-config-missing-'+$name)}
    if($matches.Count -gt 1){foreach($row in $matches){Profile-NamespaceIssue $row 'duplicate-profile-config'}}
  }
  $bySid=@{};$byPath=@{}
  foreach($row in $rows){
    if($row.source -eq 'configuration'){continue}
    if($null -ne $row.sid){
      if(!$bySid.ContainsKey($row.sid)){$bySid[$row.sid]=@{cim=[Collections.Generic.List[object]]::new();registry=[Collections.Generic.List[object]]::new()}}
      $bySid[$row.sid][$row.source].Add($row)
    }
    if($null -ne $row.path){
      $path=$row.path.ToLowerInvariant()
      if(!$byPath.ContainsKey($path)){$byPath[$path]=@{records=[Collections.Generic.List[object]]::new();owners=[Collections.Generic.HashSet[string]]::new()}}
      $byPath[$path].records.Add($row)
      if($null -ne $row.sid){[void]$byPath[$path].owners.Add($row.sid)}
    }
  }
  foreach($set in $bySid.Values){
    $cim=@($set.cim.ToArray());$registry=@($set.registry.ToArray())
    if($cim.Count -ne 1 -or $registry.Count -ne 1){
      foreach($row in @($cim)+@($registry)){Profile-NamespaceIssue $row 'duplicate-or-unpaired-profile-sid'}
    }elseif($null -eq $cim[0].path -or $null -eq $registry[0].path -or !$cim[0].path.Equals($registry[0].path,[StringComparison]::OrdinalIgnoreCase)){
      Profile-NamespaceIssue $cim[0] 'profile-source-path-conflict';Profile-NamespaceIssue $registry[0] 'profile-source-path-conflict'
    }
  }
  foreach($set in $byPath.Values){
    if($set.owners.Count -gt 1){foreach($row in $set.records){Profile-NamespaceIssue $row 'conflicting-profile-path-owners'}}
  }
  $observedUnknown=0
  foreach($reason in $globalUnknown){[void]$blockers.Add($reason)}
  foreach($row in $rows){
    if($row.issues.Count -gt 0){
      $observedUnknown++
      foreach($reason in $row.issues){[void]$blockers.Add($reason);$evidence.Add(@{source=$row.source;index=$row.index;scope=$row.scope;relation=$row.relation;reason=$reason})}
    }
  }
  $related=@($rows | Where-Object {$_.source -ne 'configuration' -and (($null -ne $target -and $_.sid -ceq $target) -or $_.relation -notin @('unrelated','unknown'))})
  $unknown=if($coverageKnown){$observedUnknown}else{$null}
  return @{complete=$complete;verified=($complete -and $globalUnknown.Count -eq 0 -and $observedUnknown -eq 0 -and $foreign.Count -eq 0 -and $targetConflicts.Count -eq 0);
    proofKind='complete-profile-metadata';unknownProfileCount=$unknown;observedUnknownProfileCount=$observedUnknown;foreignProfileConflictCount=$foreign.Count;targetProfileConflictCount=$targetConflicts.Count;
    blockers=@($blockers | ForEach-Object {$_});evidence=$evidence.GetRange(0,[Math]::Min($evidence.Count,128)).ToArray();evidenceTruncated=($evidence.Count -gt 128);rows=$rows.ToArray();cim=@($related | Where-Object {$_.source -eq 'cim'});registrations=@($related | Where-Object {$_.source -eq 'registry'})}
}
function Assert-ProfileNamespace($facts) {
  if(!(Profile-True (Profile-Value $facts 'namespaceComplete')) -or !(Profile-True (Profile-Value $facts 'namespaceVerified')) -or
    (Profile-Value $facts 'namespaceProofKind') -cne 'complete-profile-metadata'){Deny 'profile_namespace_unverified'}
  foreach($name in @('unknownProfileCount','foreignProfileConflictCount','targetProfileConflictCount')){
    $value=Profile-Value $facts $name
    if(($value -isnot [int] -and $value -isnot [long]) -or $value -ne 0){Deny 'profile_namespace_unverified'}
  }
  $blockers=Profile-Value $facts 'namespaceBlockers'
  if($blockers -isnot [Array] -or $blockers.Count -ne 0){Deny 'profile_namespace_unverified'}
}


function Read-ProfileInventory {
  $windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  $inventory=@{cimComplete=$false;registryComplete=$false;configurationComplete=$false;cimRecords=@();registryRecords=@();configurationRecords=@();
    environment=@{systemroot=$windows;windir=$windows;systemdrive=[IO.Path]::GetPathRoot([Environment]::SystemDirectory).TrimEnd('\');programdata=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)}}
  $cim=[Collections.Generic.List[object]]::new();$registry=[Collections.Generic.List[object]]::new();$configuration=[Collections.Generic.List[object]]::new()
  try{
    foreach($profile in @(Get-CimInstance -ClassName Win32_UserProfile -OperationTimeoutSec 10 -ErrorAction Stop)){
      $cim.Add(@{source='cim';readComplete=$true;sid=(Profile-Value $profile 'SID');rawPath=(Profile-Value $profile 'LocalPath');
        loaded=(Profile-Value $profile 'Loaded');special=(Profile-Value $profile 'Special');status=(Profile-Value $profile 'Status')})
    }
    $inventory.cimComplete=$true
  }catch{$inventory.cimComplete=$false}
  $key=$null
  try{
    $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList')
    if($null -eq $key){throw [InvalidOperationException]::new('profile_namespace_unverified')}
    $names=@($key.GetSubKeyNames())
    foreach($name in $names){
      $record=@{source='registry';readComplete=$false;key=$name;rawPath=$null;valueKind=$null};$sub=$null
      try{
        $sub=$key.OpenSubKey($name)
        if($null -ne $sub){
          $record.valueKind=$sub.GetValueKind('ProfileImagePath').ToString()
          $record.rawPath=$sub.GetValue('ProfileImagePath',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          $record.readComplete=$true
        }
      }catch{$record.readComplete=$false}
      finally{if($null -ne $sub){$sub.Dispose()}}
      $registry.Add($record)
    }
    $before=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($name in $names){[void]$before.Add($name)}
    $inventory.registryComplete=$before.SetEquals([string[]]@($key.GetSubKeyNames()))
    foreach($name in @('Default','Public','ProgramData','ProfilesDirectory')){
      $record=@{source='configuration';readComplete=$false;name=$name;rawPath=$null;valueKind=$null}
      try{
        $record.valueKind=$key.GetValueKind($name).ToString()
        $record.rawPath=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $record.readComplete=$true
      }catch{$record.readComplete=$false}
      $configuration.Add($record)
    }
    $inventory.configurationComplete=$true
  }catch{$inventory.registryComplete=$false;$inventory.configurationComplete=$false}
  finally{if($null -ne $key){$key.Dispose()}}
  $inventory.cimRecords=$cim.ToArray();$inventory.registryRecords=$registry.ToArray();$inventory.configurationRecords=$configuration.ToArray()
  return $inventory
}
function Profile-Facts($sid,$quarantinePath=$null) {
  $capturedAt=Millis
  if(!([FixerResetNativeV1]::ProfilesRoot().Equals('C:\Users',[StringComparison]::OrdinalIgnoreCase))){Deny 'identity_mismatch'}
  if($null -ne $quarantinePath -and ($null -eq $script:Lease -or
    $quarantinePath -cne [IO.Path]::Combine($script:StateRoot,('purge-'+$script:Lease.nonce)))){Deny 'context_invalid'}
  $namespace=Classify-ProfileNamespace $sid (Read-ProfileInventory) $quarantinePath
  $cim=@($namespace.cim | ForEach-Object {@{SID=$_.sid;LocalPath=$_.path;Loaded=$_.loaded;Special=$_.special;Status=$_.status}})
  $registrations=@($namespace.registrations | ForEach-Object {@{sid=$_.sid;path=$_.path;backup=$_.backup}})
  $item=Read-ItemExact $script:Target
  $hive=$false
  if($sid){foreach($hiveName in @($sid,($sid+'_Classes'))){$h=[Microsoft.Win32.Registry]::Users.OpenSubKey($hiveName);if($null -ne $h){$hive=$true;$h.Dispose()}}}
  $absent=($namespace.verified -and $null -eq $item -and $cim.Count -eq 0 -and $registrations.Count -eq 0)
  $owned=($namespace.verified -and $null -ne $item -and !($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
    $cim.Count -eq 1 -and $registrations.Count -eq 1 -and $cim[0].SID -ceq $sid -and $registrations[0].sid -ceq $sid -and
    (ExactPath $cim[0].LocalPath) -and (ExactPath $registrations[0].path))
  if($owned){
    $owner=(Get-Acl -LiteralPath $script:Target -ErrorAction Stop).GetOwner([Security.Principal.SecurityIdentifier]).Value
    $owned=$owner -in @($sid,'S-1-5-18','S-1-5-32-544')
  }
  return @{absent=$absent;exists=($null -ne $item);owned=$owned;cim=$cim;registrations=$registrations;hiveLoaded=$hive;capturedAtMs=$capturedAt;
    namespaceComplete=$namespace.complete;namespaceVerified=$namespace.verified;namespaceProofKind=$namespace.proofKind;
    unknownProfileCount=$namespace.unknownProfileCount;observedUnknownProfileCount=$namespace.observedUnknownProfileCount;
    foreignProfileConflictCount=$namespace.foreignProfileConflictCount;targetProfileConflictCount=$namespace.targetProfileConflictCount;
    namespaceBlockers=$namespace.blockers;conflictEvidence=$namespace.evidence}
}
function Set-ProfileNamespaceProof($receipt,$facts) {
  $receipt.profileNamespaceComplete=$facts.namespaceComplete;$receipt.profileNamespaceVerified=$facts.namespaceVerified;$receipt.profileNamespaceProofKind=$facts.namespaceProofKind
  foreach($name in @('unknownProfileCount','observedUnknownProfileCount','foreignProfileConflictCount','targetProfileConflictCount')){$receipt[$name]=$facts[$name]}
  $receipt.namespaceBlockers=$facts.namespaceBlockers;$receipt.profileConflictEvidence=$facts.conflictEvidence
  return $receipt
}

function Resolve-InternalProfileLink($parent,$target) {
  if($parent -isnot [string] -or $target -isnot [string] -or !$target -or
    $parent -notmatch '^[A-Za-z]:[\\/]' -or $target -match '[\x00-\x1f\x7f"<>|?*]'){Deny 'identity_mismatch'}
  $raw=$target.Replace('/','\')
  # No UNC, NT/device namespace, alternate stream or drive-relative interpretation.
  if($raw.StartsWith('\') -or ($raw.Contains(':') -and $raw -notmatch '^[A-Za-z]:\\[^:]*$')){Deny 'identity_mismatch'}
  foreach($part in $raw.Split('\')){
    if(!$part -or $part -in @('.','..') -or $part -match '^[A-Za-z]:$'){continue}
    if($part.TrimEnd(' ','.') -cne $part -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$'){Deny 'identity_mismatch'}
  }
  $base=[IO.Path]::GetFullPath($parent)
  if(!(ExactPath $base) -and !$base.StartsWith($script:Target+'\',[StringComparison]::OrdinalIgnoreCase)){Deny 'identity_mismatch'}
  # Normalize ABSOLUTE as well as relative targets before the containment test.
  $resolved=if([IO.Path]::IsPathFullyQualified($raw)){[IO.Path]::GetFullPath($raw)}else{[IO.Path]::GetFullPath([IO.Path]::Combine($base,$raw))}
  if(!$resolved.StartsWith($script:Target+'\',[StringComparison]::OrdinalIgnoreCase)){Deny 'identity_mismatch'}
  return $resolved
}
function Assert-Tree {
  $u=Local-Account;if($null -eq $u){Deny 'identity_mismatch'}
  Assert-NoForeignWriters $script:Target $u.SID.Value
  $pending=[Collections.Generic.Queue[string]]::new();$pending.Enqueue($script:Target)
  $count=0
  while($pending.Count -gt 0) {
    $path=$pending.Dequeue()
    foreach($item in @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)) {
      $count++;if($count -gt 100000) { Deny 'profile_purge_incomplete' }
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [void](Resolve-InternalProfileLink ([IO.Path]::GetDirectoryName($item.FullName)) $item.LinkTarget)
      } else { Assert-NoForeignWriters $item.FullName $u.SID.Value;if($item.PSIsContainer){$pending.Enqueue($item.FullName)} }
    }
  }
  return $count
}
function Process-Facts($sid) {
  $processes=@();$unknown=0
  $accounts=@(Get-CimInstance -ClassName Win32_UserAccount -Filter ("SID='"+$sid+"'") -OperationTimeoutSec 10 -ErrorAction Stop)
  if($accounts.Count -ne 1 -or $accounts[0].LocalAccount -ne $true) { Deny 'identity_mismatch' }
  $logons=@(Get-CimAssociatedInstance -InputObject $accounts[0] -Association Win32_LoggedOnUser -ResultClassName Win32_LogonSession -OperationTimeoutSec 10 -ErrorAction Stop)
  $seen=[Collections.Generic.HashSet[int]]::new()
  foreach($logon in $logons) {
    foreach($p in @(Get-CimAssociatedInstance -InputObject $logon -Association Win32_SessionProcess -ResultClassName Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop)) {
      $pidValue=[int]$p.ProcessId
      if($seen.Add($pidValue)) {
        try { $info=[FixerResetNativeV1]::ReadProcess($pidValue);if($info.Sid -eq $sid) { $processes += $info } else { $unknown++ } }
        catch { $unknown++ }
      }
    }
  }
  $again=Local-Account
  if($null -eq $again -or $again.SID.Value -ne $sid) { Deny 'identity_mismatch' }
  return @{ processes=$processes;unknown=$unknown;capturedAtMs=(Millis) }
}
function Session-Facts($sid) {
  $all=@([FixerResetNativeV1]::Sessions())
  return @{ active=@($all | Where-Object { $_.Occupied -and $_.Known -and $_.Sid -eq $sid }).Count;unknown=@($all | Where-Object { !$_.Known }).Count;capturedAtMs=(Millis) }
}
function Scope($c,[string]$status='verified') {
  return @{ status=$status;complete=$true;schemaVersion=1;operationId=$c.operation.id;generation=$c.operation.generation;machineId=$c.operation.machineId;accountSid=$c.operation.accountSid;leaseNonce=$script:Lease.nonce;capturedAtMs=(Millis);profilePath=$script:Target }
}
function Assert-Context($c) {
  if($null -eq $script:Lease -or $null -eq $script:LeaseStream -or $c.profilePath -cne $script:Target -or $c.operation.accountName -cne 'user1' -or $c.operation.id -cne $script:Lease.operationId -or $c.operation.generation -ne $script:Lease.generation -or $c.operation.machineId -cne $script:Lease.machineId -or $c.operation.machineSid -cne $script:MachineSid -or $c.operation.leaseNonce -cne $script:Lease.nonce -or $c.lease.nonce -cne $script:Lease.nonce -or $script:Lease.expiresAtMs -le (Millis)) { Deny 'context_invalid' }
  if($null -ne $c.operation.accountSid) {
    if($c.operation.accountSid -isnot [string] -or $c.operation.accountSid -notmatch ('^'+[regex]::Escape($script:MachineSid)+'-[1-9][0-9]{3,9}$')){Deny 'context_invalid'}
    $rid=[uint64]($c.operation.accountSid.Split('-')[-1]);if($rid -lt 1000 -or $rid -gt [uint32]::MaxValue){Deny 'context_invalid'}
  }
  Assert-Private $script:StateRoot
  [void](Assert-ProfileNamespaceProtected)
  $readback=Read-StreamJson $script:LeaseStream
  if($null -eq $readback -or $readback.nonce -cne $script:Lease.nonce -or $readback.unresolved -ne $true) { Deny 'recovery_required' }
}
function Read-Binding($sid) {
  $b=Read-State 'binding.json'
  if($null -eq $b) { return $null }
  if($b.schemaVersion -ne 1 -or $b.machineId -cne $script:MachineId -or $b.machineSid -cne $script:MachineSid -or $b.accountName -cne 'user1' -or $b.accountSid -cne $sid -or !(ExactPath $b.profilePath)) { Deny 'binding_unverified' }
  return $b
}
function Owned-Journal($c) {
  $j=Read-State 'journal.json'
  if($null -eq $j -or $j.operationId -cne $c.operation.id -or $j.generation -ne $c.operation.generation -or $j.leaseNonce -cne $script:Lease.nonce -or $j.machineId -cne $script:MachineId -or $j.unresolved -ne $true) { Deny 'journal_unverified' }
  return $j
}
function Admission($c) {
  Assert-Context $c
  $u=Local-Account;$current=Current-Profile
  $sid=if($null -eq $u) { $null } else { $u.SID.Value }
  if($sid -eq $current.sid) { Deny 'identity_mismatch' }
  $p=Profile-Facts $sid
  $r=Scope $c
  $r.accountName='user1';$r.isLocal=$true;$r.currentUserSid=$current.sid;$r.currentUserProfilePath=$current.path;$r.currentUserProfilePathVerified=$true;$r.currentUserProtected=$true
  $r.accountExists=($null -ne $u);$r.accountLookupComplete=$true;$r.profileExists=$p.exists;$r.registeredProfileCount=$p.registrations.Count
  $r=Set-ProfileNamespaceProof $r $p;$r.capturedAtMs=$p.capturedAtMs
  $r.profilePath=$script:Target;$r.profilesRoot='C:\Users';$r.profilesRootVerified=$true;$r.ancestorsReparseFree=$true
  if(!$p.namespaceVerified){$r.status='blocked';$r.kind='blocked';$r.profileOwnershipVerified=$false;return $r}
  if($null -eq $u -and $p.absent) { $r.kind='fresh-absent';$r.accountSid=$null;$r.profileOwnershipVerified=$true;return $r }
  if($null -eq $u -or !$p.owned) { Deny 'identity_mismatch' }
  $r.accountSid=$sid;$r.builtin=$false;$r.protected=$false;$r.enabled=[bool]$u.Enabled;$r.registeredSid=$sid;$r.registeredPath=$script:Target;$r.special=[bool]$p.cim[0].Special
  $r.profileOwnershipVerified=$true;$r.leafReparseFree=$true
  $b=Read-Binding $sid
  if($null -eq $b) { $r.kind='operator-target' }
  else { $r.kind='bound-existing';$r.binding=@{ verified=$true;storageProtected=$true;ownerVerified=$true;accountSid=$sid;machineId=$script:MachineId;machineSid=$script:MachineSid;accountName='user1';profilePath=$script:Target } }
  return $r
}
function Verify-Consent($c) {
  $a=Admission $c;$x=$c.consent
  if($a.kind -notin @('operator-target','bound-existing') -or $null -eq $x -or $x.confirmed -ne $true -or $x.scope -cne 'purge-exact-local-user1' -or $x.operationId -cne $c.operation.id -or $x.generation -ne $c.operation.generation -or $x.machineId -cne $script:MachineId -or $x.accountSid -cne $a.accountSid -or !(ExactPath $x.profilePath) -or $x.id -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { Deny 'context_invalid' }
  return $a
}
function Assert-Expected($c,[string]$effect) {
  $validationStarted=Millis
  Assert-Context $c;$journal=Owned-Journal $c
  $states=@{persistBinding=@('verified-operator-target','disabled-account-profile-absent');fenceAccount=@('bound-existing-account');shutdownAccount=@('disabled-bound-account');purgeProfile=@('disabled-bound-account-profile-unloaded');deleteAccount=@('disabled-bound-account-profile-absent');createDisabledAccount=@('account-and-profile-absent');createProfile=@('disabled-account-profile-absent');enableAccount=@('disabled-account-owned-profile')}
  $phases=@{persistBinding='binding-account';fenceAccount='fencing-account';shutdownAccount='stopping-account';purgeProfile='purging-profile';deleteAccount='deleting-account';createDisabledAccount='creating-account';createProfile='creating-profile';enableAccount='enabling-account'}
  if(!$states.ContainsKey($effect) -or $c.expected.state -notin $states[$effect] -or $journal.phase -cne $phases[$effect]){Deny 'context_invalid'}
  if($effect -eq 'persistBinding' -and (($c.source -eq 'created' -and $c.expected.state -ne 'disabled-account-profile-absent') -or ($c.source -eq 'operator-target' -and $c.expected.state -ne 'verified-operator-target'))){Deny 'context_invalid'}
  if($c.expected.accountName -cne 'user1' -or !(ExactPath $c.expected.profilePath) -or $c.expected.accountSid -cne $c.operation.accountSid) { Deny 'context_invalid' }
  $u=Local-Account;$current=Current-Profile
  if($null -ne $u -and ($u.SID.Value -ne $c.operation.accountSid -or $u.SID.Value -eq $current.sid)) { Deny 'identity_mismatch' }
  $quarantineScope=if($effect -eq 'purgeProfile'){[IO.Path]::Combine($script:StateRoot,('purge-'+$script:Lease.nonce))}else{$null}
  $p=Profile-Facts $c.operation.accountSid $quarantineScope
  Assert-ProfileNamespace $p
  if($effect -in @('createProfile','enableAccount') -and $script:CreatedSid -cne $c.operation.accountSid){Deny 'identity_mismatch'}
  $script:EffectsStarted=$true
  switch($c.expected.state) {
    'account-and-profile-absent' { if($null -ne $u -or !$p.absent -or $null -ne $c.operation.accountSid) { Deny 'namespace_not_absent' };break }
    'verified-operator-target' { [void](Verify-Consent $c);break }
    'disabled-account-profile-absent' { if($null -eq $u -or $u.Enabled -or !$p.absent) { Deny 'namespace_not_absent' };if($effect -eq 'persistBinding' -and $script:CreatedSid -ne $u.SID.Value) { Deny 'identity_mismatch' };break }
    'bound-existing-account' { if($null -eq $u -or !$p.owned -or $null -eq (Read-Binding $u.SID.Value)) { Deny 'binding_unverified' };break }
    'disabled-bound-account' { if($null -eq $u -or $u.Enabled -or !$p.owned -or $null -eq (Read-Binding $u.SID.Value)) { Deny 'binding_unverified' };break }
    'disabled-bound-account-profile-absent' { if($null -eq $u -or $u.Enabled -or !$p.absent -or $null -eq (Read-Binding $u.SID.Value)) { Deny 'identity_mismatch' };break }
    'disabled-bound-account-profile-unloaded' {
      if($null -eq $u -or $u.Enabled -or !$p.owned -or $p.cim[0].Loaded -or $p.cim[0].Special -or $p.hiveLoaded -or $null -eq (Read-Binding $u.SID.Value)) { Deny 'target_in_use' }
      $s=Session-Facts $u.SID.Value;$q=Process-Facts $u.SID.Value
      if($s.active -ne 0 -or $s.unknown -ne 0 -or $q.processes.Count -ne 0 -or $q.unknown -ne 0) { Deny 'target_in_use' }
      [void](Assert-Tree);break
    }
    'disabled-account-owned-profile' { if($null -eq $u -or $u.Enabled -or !$p.owned -or $p.cim[0].Loaded -or $p.cim[0].Special -or $p.hiveLoaded -or $null -eq (Read-Binding $u.SID.Value)) { Deny 'identity_mismatch' };break }
    default { Deny 'context_invalid' }
  }
  $finalAccount=Local-Account
  if($c.expected.state -eq 'account-and-profile-absent'){
    if($null -ne $finalAccount){Deny 'identity_mismatch'}
  }elseif($null -eq $finalAccount -or $finalAccount.SID.Value -cne $c.operation.accountSid){Deny 'identity_mismatch'}
  if((Millis)-$validationStarted -ge 5000 -or $script:Lease.expiresAtMs -le (Millis)){Deny 'context_invalid'}
}
function Assert-QuarantinedExpected($c) {
  $validationStarted=Millis
  Assert-Context $c;$j=Owned-Journal $c
  $expectedPath=[IO.Path]::Combine($script:StateRoot,('purge-'+$script:Lease.nonce))
  if($j.phase -cne 'purging-profile' -or $j.quarantineState -cne 'purge-intent' -or
    $j.quarantinePath -cne $expectedPath -or $j.quarantineFileId -notmatch '^[0-9a-f]{16}$' -or
    ($j.quarantineVolume -isnot [int] -and $j.quarantineVolume -isnot [long] -and $j.quarantineVolume -isnot [uint32]) -or
    $j.quarantineVolume -lt 0 -or $j.quarantineVolume -gt [uint32]::MaxValue -or
    $c.expected.accountSid -cne $c.operation.accountSid -or $c.expected.accountName -cne 'user1' -or
    !(ExactPath $c.expected.profilePath) -or $c.expected.state -cne 'disabled-bound-account-profile-unloaded'){Deny 'context_invalid'}
  $current=Current-Profile;$u=Local-Account
  if($null -eq $u -or $u.Enabled -or $u.SID.Value -cne $c.operation.accountSid -or $u.SID.Value -ceq $current.sid -or
    $null -eq (Read-Binding $c.operation.accountSid)){Deny 'identity_mismatch'}
  # The canonical folder must stay absent after our rename. SID registrations
  # still identify the old unloaded profile until DeleteProfileW removes them.
  $p=Profile-Facts $c.operation.accountSid $expectedPath
  Assert-ProfileNamespace $p
  if($p.exists -or $p.cim.Count -ne 1 -or $p.registrations.Count -ne 1 -or
    $p.cim[0].SID -cne $c.operation.accountSid -or !(ExactPath $p.cim[0].LocalPath) -or
    $p.registrations[0].sid -cne $c.operation.accountSid -or !(ExactPath $p.registrations[0].path) -or
    $p.cim[0].Loaded -isnot [bool] -or $p.cim[0].Loaded -or $p.cim[0].Special -isnot [bool] -or
    $p.cim[0].Special -or $p.hiveLoaded){Deny 'target_in_use'}
  $sessions=Session-Facts $c.operation.accountSid;$processes=Process-Facts $c.operation.accountSid
  if($sessions.active -ne 0 -or $sessions.unknown -ne 0 -or $processes.processes.Count -ne 0 -or $processes.unknown -ne 0){Deny 'target_in_use'}
  $finalAccount=Local-Account
  if($null -eq $finalAccount -or $finalAccount.Enabled -or $finalAccount.SID.Value -cne $c.operation.accountSid){Deny 'identity_mismatch'}
  [FixerResetNativeV1]::VerifyQuarantine($expectedPath,$c.operation.accountSid,[uint32]$j.quarantineVolume,$j.quarantineFileId)
  # This gate follows EVERY metadata/SAM/handle read and the durable intent write.
  if((Millis)-$validationStarted -ge 5000 -or $script:Lease.expiresAtMs -le (Millis)){Deny 'context_invalid'}
}
function Effect-Proof($c) {
  $r=Scope $c;$r.nativeIdentityVerified=$true;$r.atomicExpectationVerified=$true;return $r
}

function Assert-Workflow($c,[switch]$RequireLoaded,[switch]$RequireProcess) {
  $validationStarted=Millis
  Assert-Context $c;$j=Owned-Journal $c
  if($j.phase -cne 'application-workflow' -or $script:CreatedSid -cne $c.operation.accountSid){Deny 'context_invalid'}
  $a=Admission $c;$p=Profile-Facts $c.operation.accountSid
  Assert-ProfileNamespace $p
  if($a.kind -ne 'bound-existing' -or $a.accountSid -cne $c.operation.accountSid -or !$a.enabled -or !$p.owned -or $p.cim[0].Special){Deny 'identity_mismatch'}
  if($RequireLoaded -and (!$p.cim[0].Loaded -or !$p.hiveLoaded -or $null -eq $script:Workflow -or $script:Workflow.handles.Profile -eq [IntPtr]::Zero)){Deny 'target_in_use'}
  if($RequireProcess){[void][FixerResetNativeV1]::VerifyLive($script:Workflow.handles,$false)}
  if((Millis)-$validationStarted -ge 5000 -or $script:Lease.expiresAtMs -le (Millis)){Deny 'context_invalid'}
  return $p
}
function Trusted-Zoom([string]$path) {
  $allowed=@()
  foreach($folder in @([Environment+SpecialFolder]::ProgramFiles,[Environment+SpecialFolder]::ProgramFilesX86)){
    $root=[Environment]::GetFolderPath($folder)
    if($root){$allowed+=,[IO.Path]::Combine($root,'Zoom\bin\Zoom.exe')}
  }
  if($path -notin $allowed -or ![IO.Path]::IsPathFullyQualified($path)){Deny 'zoom_untrusted'}
  $full=[IO.Path]::GetFullPath($path)
  if(!$full.Equals($path,[StringComparison]::OrdinalIgnoreCase)){Deny 'zoom_untrusted'}
  $guards=[Collections.Generic.List[IDisposable]]::new()
  $file=$null
  try{
    $ancestor=[IO.Path]::GetDirectoryName($full)
    while($ancestor -and $ancestor -ne [IO.Path]::GetPathRoot($ancestor)){
      Assert-NoForeignWriters $ancestor $null
      $guards.Add([FixerResetNativeV1]::GuardDirectory($ancestor));$ancestor=[IO.Path]::GetDirectoryName($ancestor)
    }
    $item=Read-ItemExact $full
    if($null -eq $item -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Deny 'zoom_untrusted'}
    Assert-NoForeignWriters $full $null
    $file=[IO.File]::Open($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $signature=Get-AuthenticodeSignature -LiteralPath $full -ErrorAction Stop
    if($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate){Deny 'zoom_untrusted'}
    $publisher=$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
    if($publisher -notin @('Zoom Communications, Inc.','Zoom Video Communications, Inc.')){Deny 'zoom_untrusted'}
    $hash=[Security.Cryptography.SHA256]::Create()
    try{$digest=([BitConverter]::ToString($hash.ComputeHash($file))).Replace('-','').ToLowerInvariant();$file.Position=0}finally{$hash.Dispose()}
    return @{path=$full;file=$file;guards=$guards;sha256=$digest;publisher=$publisher}
  }catch{if($null -ne $file){$file.Dispose()};foreach($g in $guards){$g.Dispose()};throw}
}
function Workflow-Receipt($c,[string]$step) {
  $observedAt=Millis
  $current=Current-Profile
  if($current.sid -eq $c.operation.accountSid){Deny 'identity_mismatch'}
  $r=Scope $c;$r.operatorSid=$current.sid;$r.operatorProfilePath=$current.path;$r.currentUserProtected=$true;$r.verified=$true;$r.step=$step;$r.registeredSid=$c.operation.accountSid;$r.registeredPath=$script:Target
  $r.capturedAtMs=$observedAt
  if((Millis)-$observedAt -ge 5000 -or $script:Lease.expiresAtMs -le (Millis)){Deny 'context_invalid'}
  return $r
}

function Credential-DirectorySecurity([string]$operatorSid) {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($operatorSid))
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($operatorSid,'S-1-5-18','S-1-5-32-544')){
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  return $acl
}
function Credential-FileSecurity([string]$operatorSid) {
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($operatorSid))
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($operatorSid,'S-1-5-18','S-1-5-32-544')){
    [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))
  }
  return $acl
}
function Assert-CredentialPrivate([string]$path,[string]$operatorSid) {
  $item=Read-ItemExact $path
  if($null -eq $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Deny 'storage_unverified'}
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $operatorSid -or !$acl.AreAccessRulesProtected){Deny 'storage_unverified'}
  $seen=[Collections.Generic.HashSet[string]]::new()
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or
      $rule.IdentityReference.Value -notin @($operatorSid,'S-1-5-18','S-1-5-32-544') -or
      $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){Deny 'storage_unverified'}
    [void]$seen.Add($rule.IdentityReference.Value)
  }
  foreach($sid in @($operatorSid,'S-1-5-18','S-1-5-32-544')){if(!$seen.Contains($sid)){Deny 'storage_unverified'}}
}
function Current-SealedCredential($c) {
  if($null -eq $script:Workflow -or !$script:Workflow.sealVerified -or $null -eq $script:Workflow.sealed){Deny 'credentials_invalid'}
  $cached=$script:Workflow.sealed;$current=Current-Profile;$b=$cached.binding
  if($b.operatorSid -cne $current.sid -or $b.operatorProfilePath -cne $current.path -or $b.accountSid -cne $c.operation.accountSid -or
    $b.operationId -cne $c.operation.id -or $b.generation -ne $c.operation.generation -or $b.machineId -cne $script:MachineId -or
    $b.machineSid -cne $script:MachineSid -or !(ExactPath $b.profilePath)){Deny 'credentials_invalid'}
  $bytes=[Convert]::FromBase64String($cached.ciphertext)
  if([Convert]::ToBase64String($bytes) -cne $cached.ciphertext){Deny 'credentials_invalid'}
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$digest=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  if($digest -cne $cached.ciphertextSha256){Deny 'credentials_invalid'}
  return $cached
}
function Persist-OwnedCredential($c) {
  [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
  $cached=Current-SealedCredential $c
  $current=Current-Profile
  $appData=[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  $expectedAppData=[IO.Path]::Combine($current.path,'AppData\Roaming')
  if(!$appData.Equals($expectedAppData,[StringComparison]::OrdinalIgnoreCase) -or
    !$current.path.StartsWith('C:\Users\',[StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFullPath($appData) -cne $appData -or
    $c.operation.id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
    $c.operation.id -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$'){Deny 'storage_unverified'}
  $root=[IO.Path]::Combine($appData,'1132 Fixer\helper-credentials-v2')
  $path=[IO.Path]::Combine($root,($c.operation.id+'.json'))
  $guards=[Collections.Generic.List[IDisposable]]::new()
  $stream=$null;$read=$null
  try {
    foreach($parent in @($current.path,[IO.Path]::Combine($current.path,'AppData'),$appData)){
      Assert-NoForeignWriters $parent $current.sid
      $guards.Add([FixerResetNativeV1]::GuardDirectory($parent))
    }
    $appRoot=[IO.Path]::Combine($appData,'1132 Fixer')
    if($null -eq (Read-ItemExact $appRoot)){
      [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($appRoot),(Credential-DirectorySecurity $current.sid))
    }
    Assert-NoForeignWriters $appRoot $current.sid
    $guards.Add([FixerResetNativeV1]::GuardDirectory($appRoot))
    if($null -eq (Read-ItemExact $root)){
      [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($root),(Credential-DirectorySecurity $current.sid))
    }
    Assert-CredentialPrivate $root $current.sid
    $guards.Add([FixerResetNativeV1]::GuardDirectory($root))
    $envelope=@{schemaVersion=2;protection='DPAPI-CurrentUser';binding=$cached.binding;ciphertext=$cached.ciphertext}
    $expectedJson=ConvertTo-Json -InputObject $envelope -Depth 12 -Compress
    if($null -eq $script:Workflow.persistedCredential){
      # CreateNew never overwrites another operation, old blob or user data.
      $stream=[IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($path),[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(Credential-FileSecurity $current.sid))
      Write-StreamJson $stream $envelope
      Assert-CredentialPrivate $path $current.sid
      $identity=[FixerResetNativeV1]::FileIdentity($stream.SafeFileHandle)
      $stream.Dispose();$stream=$null
      # Retain a read-only handle: future readers work, replacement/writes do not.
      $read=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      if([FixerResetNativeV1]::FileIdentity($read.SafeFileHandle) -cne $identity){Deny 'storage_unverified'}
    }else{
      if($script:Workflow.persistedCredential.path -cne $path){Deny 'storage_unverified'}
      $read=$script:Workflow.credentialRead
      if($null -eq $read -or [FixerResetNativeV1]::FileIdentity($read.SafeFileHandle) -cne $script:Workflow.persistedCredential.fileIdentity){Deny 'storage_unverified'}
      $identity=$script:Workflow.persistedCredential.fileIdentity
    }
    Assert-CredentialPrivate $path $current.sid
    $readback=Read-StreamJson $read
    if((ConvertTo-Json -InputObject $readback -Depth 12 -Compress) -cne $expectedJson){Deny 'storage_unverified'}
    $bytes=[Convert]::FromBase64String($readback.ciphertext)
    if([Convert]::ToBase64String($bytes) -cne $readback.ciphertext){Deny 'storage_unverified'}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$digest=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    if($digest -cne $cached.ciphertextSha256){Deny 'storage_unverified'}
    $proofStarted=Millis
    [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
    Assert-CredentialPrivate $path $current.sid
    if([FixerResetNativeV1]::FileIdentity($read.SafeFileHandle) -cne $identity -or
      (ConvertTo-Json -InputObject (Read-StreamJson $read) -Depth 12 -Compress) -cne $expectedJson){Deny 'storage_unverified'}
    $script:Workflow.persistedCredential=@{path=$path;ciphertextSha256=$digest;fileIdentity=$identity}
    if($null -eq $script:Workflow.credentialRead){
      $script:Workflow.credentialRead=$read;$read=$null
      $script:Workflow.credentialGuards=$guards;$guards=$null
    }else{$read=$null}
    $r=Workflow-Receipt $c 'persist-credential'
    $r.stored=$true;$r.readbackVerified=$true;$r.storageProtected=$true;$r.ownerVerified=$true;$r.formatVersion=2;$r.protection='DPAPI-CurrentUser'
    $r.path=$path;$r.credentialPath=$path;$r.ciphertextSha256=$digest
    if((Millis)-$proofStarted -ge 5000 -or $script:Lease.expiresAtMs -le (Millis)){Deny 'storage_unverified'}
    return $r
  }finally{
    if($null -ne $stream){$stream.Dispose()}
    if($null -ne $read -and $read -ne $script:Workflow.credentialRead){$read.Dispose()}
    if($null -ne $guards){foreach($guard in $guards){$guard.Dispose()}}
  }
}

function Invoke-FixedWorkflow([string]$command,$c,$secret) {
  switch($command){
    'workflow-launch-zoom'{
      [void](Assert-Workflow $c)
      $role=Assert-StandardAccount $c $c.operation.accountSid
      if(!$role.account.Enabled){Deny 'standard_account_unverified'}
      if($null -ne $script:Workflow -or $secret -isnot [string] -or $secret.Length -lt 20 -or $secret.Length -gt 128 -or $secret -match '[\x00-\x1f\x7f]'){Deny 'credentials_invalid'}
      $trusted=Trusted-Zoom $c.zoomPath
      # Custody is retained before any token/profile/process effect. Journal already unresolved.
      $script:Workflow=@{handles=$null;trusted=$trusted;profileVerified=$false;configuration=$null;sealVerified=$false;sealed=$null;persistedCredential=$null;credentialRead=$null;credentialGuards=$null}
      $script:EffectsStarted=$true
      $handles=[FixerResetNativeV1]::LoadOwnedProfile($secret,$c.operation.accountSid,$script:Target)
      $script:Workflow.handles=$handles
      [void](Assert-Workflow $c)
      [FixerResetNativeV1]::LoadProfile($handles)
      [void](Assert-Workflow $c -RequireLoaded)
      [FixerResetNativeV1]::Launch($handles,$trusted.path)
      [void][FixerResetNativeV1]::VerifyLive($handles,$false)
      $r=Workflow-Receipt $c 'launch-zoom';$r.launched=$true;$r.tokenSid=$handles.Sid;$r.processId=$handles.ProcessId;$r.creationFileTime=$handles.Created.ToString();$r.executablePath=$trusted.path;$r.executableSha256=$trusted.sha256;$r.publisher=$trusted.publisher;$r.liveHandleVerified=$true
      return $r
    }
    'workflow-verify-profile'{
      [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
      $script:Workflow.profileVerified=$true
      $r=Workflow-Receipt $c 'verify-profile';$r.loaded=$true;$r.special=$false;$r.ownershipVerified=$true;$r.hiveOwnedReference=$true;return $r
    }
    'workflow-configure-helper'{
      [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
      if(!$script:Workflow.profileVerified){Deny 'context_invalid'}
      $root=[Microsoft.Win32.RegistryKey]::FromHandle([Microsoft.Win32.SafeHandles.SafeRegistryHandle]::new($script:Workflow.handles.Profile,$false))
      $settings=@{}
      try{
        foreach($kind in @('webcam','microphone')){
          $policy='not-denied'
          $policyKey=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Policies\Microsoft\Windows\AppPrivacy')
          try{
            if($null -ne $policyKey){
              $policyName=if($kind -eq 'webcam'){'LetAppsAccessCamera'}else{'LetAppsAccessMicrophone'}
              $v=$policyKey.GetValue($policyName,$null)
              if($null -ne $v -and $v -isnot [int]){$policy='unknown'}
              elseif($v -eq 2){$policy='denied'}
            }
          }finally{if($null -ne $policyKey){$policyKey.Dispose()}}
          if($kind -eq 'webcam'){
            $camera=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Policies\Microsoft\Camera')
            try{if($null -ne $camera){$v=$camera.GetValue('AllowCamera',$null);if($null -ne $v -and $v -isnot [int]){$policy='unknown'}elseif($v -eq 0){$policy='denied'}}}finally{if($null -ne $camera){$camera.Dispose()}}
          }
          if($policy -eq 'not-denied'){
            [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
            $key=$root.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\'+$kind,$true)
            try{$key.SetValue('Value','Allow',[Microsoft.Win32.RegistryValueKind]::String);$readback=$key.GetValue('Value');if($readback -cne 'Allow'){Deny 'native_failure'}}finally{$key.Dispose()}
            $settings[$kind]=@{status='configured';value='Allow';machinePolicy='not-denied';effectiveAccess='requires-app-runtime-verification'}
          }else{$settings[$kind]=@{status=if($policy -eq 'denied'){'policy-denied'}else{'unverified'};machinePolicy=$policy}}
        }
      }finally{$root.Dispose()}
      $frameStatus='unverified'
      try{$frame=@(Get-Service -Name 'FrameServer' -ErrorAction Stop);if($frame.Count -eq 1){$frameStatus=$frame[0].Status.ToString().ToLowerInvariant()}}catch{$frameStatus='unavailable'}
      $configuration=@{camera=$settings.webcam;microphone=$settings.microphone;hive=@{status='owned-loaded-reference';accountSid=$c.operation.accountSid};frameServer=@{status=$frameStatus;action='read-only'};optionalPreferences=@{status='not-requested'}}
      $script:Workflow.configuration=$configuration
      $r=Workflow-Receipt $c 'configure-helper';$r.configuration=$configuration;$r.preferencesVerified=$true
      $r.warnings=@($settings.Keys | Where-Object {$settings[$_].status -ne 'configured'} | ForEach-Object {$_+':'+$settings[$_].status})
      return $r
    }
    'workflow-seal-credential'{
      [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
      if(!$script:Workflow.profileVerified -or $null -eq $script:Workflow.configuration -or $secret -isnot [string] -or $secret.Length -lt 20 -or $secret.Length -gt 128 -or $secret -match '[\x00-\x1f\x7f]'){Deny 'credentials_invalid'}
      $current=Current-Profile
      if($null -ne $script:Workflow.sealed){
        $cached=Current-SealedCredential $c
        $r=Workflow-Receipt $c 'seal-credential';$r.ciphertext=$cached.ciphertext;$r.protection='DPAPI-CurrentUser';$r.operatorSid=$current.sid;$r.binding=$cached.binding;return $r
      }
      $metadata=@{schemaVersion=1;operatorSid=$current.sid;operatorProfilePath=$current.path;accountName='user1';accountSid=$c.operation.accountSid;profilePath=$script:Target;machineId=$script:MachineId;machineSid=$script:MachineSid;operationId=$c.operation.id;generation=$c.operation.generation;executablePath=$script:Workflow.trusted.path;executableSha256=$script:Workflow.trusted.sha256}
      $clear=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @{binding=$metadata;password=$secret} -Depth 8 -Compress))
      try{
        $cipher=[Security.Cryptography.ProtectedData]::Protect($clear,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $readback=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        try{if(![Security.Cryptography.CryptographicOperations]::FixedTimeEquals($clear,$readback)){Deny 'credentials_invalid'}}finally{[Array]::Clear($readback,0,$readback.Length)}
        $base64=[Convert]::ToBase64String($cipher)
      }finally{[Array]::Clear($clear,0,$clear.Length)}
      $sha=[Security.Cryptography.SHA256]::Create()
      try{$digest=([BitConverter]::ToString($sha.ComputeHash($cipher))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
      $script:Workflow.sealed=@{ciphertext=$base64;binding=$metadata;ciphertextSha256=$digest}
      $script:Workflow.sealVerified=$true
      $r=Workflow-Receipt $c 'seal-credential';$r.ciphertext=$base64;$r.protection='DPAPI-CurrentUser';$r.operatorSid=$current.sid;$r.binding=$metadata;return $r
    }
    'workflow-persist-credential'{return Persist-OwnedCredential $c}
    'workflow-verify-zoom'{
      [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
      if(!$script:Workflow.profileVerified -or $null -eq $script:Workflow.configuration -or !$script:Workflow.sealVerified){Deny 'context_invalid'}
      [void][FixerResetNativeV1]::VerifyLive($script:Workflow.handles,$true)
      $script:ZoomVerified=$true
      $r=Workflow-Receipt $c 'verify-zoom';$r.ready=$true;$r.tokenSid=$script:Workflow.handles.Sid;$r.processId=$script:Workflow.handles.ProcessId;$r.creationFileTime=$script:Workflow.handles.Created.ToString();$r.executablePath=$script:Workflow.trusted.path;$r.executableSha256=$script:Workflow.trusted.sha256;$r.liveHandleVerified=$true;$r.configuration=$script:Workflow.configuration
      return $r
    }
    default{Deny 'context_invalid'}
  }
}
function Complete-OwnedWorkflowResources($c) {
  $j=Read-State 'journal.json'
  if($null -eq $j -or $j.phase -ne 'complete' -or $j.unresolved -ne $false){Deny 'recovery_required'}
  # A crash during our owned-reference release must also remain visible on restart.
  $j.phase='releasing-owned-resources';$j.unresolved=$true;Write-State 'journal.json' $j
  if($null -ne $script:Workflow.handles){[FixerResetNativeV1]::ReleaseOwned($script:Workflow.handles)}
  if($null -ne $script:Workflow.credentialRead){$script:Workflow.credentialRead.Dispose()}
  if($null -ne $script:Workflow.credentialGuards){foreach($guard in $script:Workflow.credentialGuards){$guard.Dispose()}}
  $script:Workflow.trusted.file.Dispose()
  foreach($guard in $script:Workflow.trusted.guards){$guard.Dispose()}
  $script:Workflow=$null
  $j.phase='complete';$j.unresolved=$false;Write-State 'journal.json' $j
}

function Handle-Command([string]$command,$c,$secret) {
  if([FixerResetNativeV1]::PrivilegeCustodyUnresolved){Deny 'profile_privilege_restore_unverified'}
  if($command -in @('workflow-launch-zoom','workflow-verify-profile','workflow-configure-helper','workflow-seal-credential','workflow-persist-credential','workflow-verify-zoom')){return Invoke-FixedWorkflow $command $c $secret}
  switch($command) {
    'inspectRecovery' {
      $j=Read-State 'journal.json';$old=if($null -ne $script:LeaseStream){Read-StreamJson $script:LeaseStream}else{Read-State 'lease.json'}
      $blocked=($null -ne $j -and $j.unresolved -eq $true) -or ($null -ne $old -and $old.unresolved -eq $true)
      $current=Current-Profile;$target=Local-Account
      return @{ operatorSid=$current.sid;operatorProfilePath=$current.path;currentUserProfilePathVerified=$true;currentUserProtected=($null -eq $target -or $target.SID.Value -ne $current.sid);status=if($blocked){'blocked'}else{'clear'};complete=$true;blocked=$blocked;storageProtected=$true;leaseHeld=($null -ne $script:LeaseStream);machineId=$script:MachineId }
    }
    'acquireLease' {
      if($null -ne $script:LeaseStream -or $c.operation.machineId -cne $script:MachineId -or $c.operation.accountName -cne 'user1' -or $c.operation.id -isnot [string] -or $c.operation.id -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' -or ($c.operation.generation -isnot [long] -and $c.operation.generation -isnot [int]) -or $c.operation.generation -lt 1) { Deny 'context_invalid' }
      $stream=$null
      try { $stream=Open-Private 'lease.json' -AllowNew } catch [IO.IOException] { return @{status='busy';complete=$true;acquired=$false} }
      try {
        $old=Read-StreamJson $stream;$j=Read-State 'journal.json'
        if(($null -ne $old -and $old.unresolved -eq $true) -or ($null -ne $j -and $j.unresolved -eq $true)) { Deny 'prior_unresolved' }
        $at=Millis
        $script:Lease=@{status='held';scope='machine';exclusive=$true;operationId=$c.operation.id;generation=$c.operation.generation;machineId=$script:MachineId;machineSid=$script:MachineSid;machineVerified=$true;nonce=[Guid]::NewGuid().ToString('N');acquiredAtMs=$at;expiresAtMs=($at+3600000);unresolved=$true}
        Write-StreamJson $stream $script:Lease
        $script:LeaseStream=$stream;$script:JournalOwned=$false;$script:EffectsStarted=$false;$stream=$null
        return $script:Lease
      } finally { if($null -ne $stream){$stream.Dispose()} }
    }
    'readJournal' {
      Assert-Context $c;$j=Read-State 'journal.json';$r=Scope $c;$r.storageProtected=$true
      $r.unresolved=($null -ne $j -and $j.unresolved -eq $true);$r.phase=if($null -eq $j){'none'}else{$j.phase};return $r
    }
    'writeJournal' {
      Assert-Context $c
      $allowed=@('binding-account','fencing-account','stopping-account','purging-profile','deleting-account','creating-account','creating-profile','enabling-account','application-workflow','complete')
      if($c.phase -notin $allowed -or $c.unresolved -isnot [bool] -or ($c.phase -ne 'complete' -and !$c.unresolved)) { Deny 'context_invalid' }
      if($c.phase -eq 'complete'){
        if(!$script:ZoomVerified -or $null -eq $script:Workflow.persistedCredential -or
          $script:Workflow.persistedCredential.ciphertextSha256 -cne $script:Workflow.sealed.ciphertextSha256){Deny 'recovery_required'}
        [void](Assert-Workflow $c -RequireLoaded -RequireProcess)
      }
      $j=Scope $c 'persisted';$j.phase=$c.phase;$j.unresolved=$c.unresolved;$j.storageProtected=$true
      Write-State 'journal.json' $j;$script:JournalOwned=$true;return $j
    }
    'inspectAdmission' { return Admission $c }
    'revalidateAdmission' { return Admission $c }
    'verifyOperatorTarget' { $a=Verify-Consent $c;$r=Scope $c;$r.consentVerified=$true;$r.purgeAuthorized=$true;$r.consentId=$c.consent.id;return $r }
    'revalidateEffect' {
      Assert-Expected $c $c.effect
      $r=Effect-Proof $c;$r.effect=$c.effect;$r.expectation=$c.expected.state;$r.preconditionsVerified=$true;return $r
    }
    'persistBinding' {
      Assert-Expected $c $command
      if($c.source -notin @('created','operator-target')) { Deny 'context_invalid' }
      $b=@{schemaVersion=1;machineId=$script:MachineId;machineSid=$script:MachineSid;accountName='user1';accountSid=$c.operation.accountSid;profilePath=$script:Target}
      Write-State 'binding.json' $b
      $r=Effect-Proof $c;$r.persisted=$true;$r.storageProtected=$true;$r.ownerVerified=$true;return $r
    }
    'fenceAccount' {
      Assert-Expected $c $command
      Microsoft.PowerShell.LocalAccounts\Disable-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($c.operation.accountSid)) -ErrorAction Stop
      $u=Local-Account;if($null -eq $u -or $u.SID.Value -ne $c.operation.accountSid -or $u.Enabled) { Deny 'identity_mismatch' }
      $r=Effect-Proof $c;$r.disabled=$true;return $r
    }
    'shutdownAccount' {
      Assert-Expected $c $command
      $s=Session-Facts $c.operation.accountSid;$q=Process-Facts $c.operation.accountSid
      if($s.active -ne 0 -or $s.unknown -ne 0 -or $q.unknown -ne 0) { Deny 'target_in_use' }
      foreach($p in $q.processes) { [FixerResetNativeV1]::StopOwnedProcess($p.Id,$p.Created,$c.operation.accountSid) }
      $s=Session-Facts $c.operation.accountSid;$q=Process-Facts $c.operation.accountSid
      if($s.active -ne 0 -or $s.unknown -ne 0 -or $q.unknown -ne 0 -or $q.processes.Count -ne 0) { Deny 'target_in_use' }
      $r=Effect-Proof $c;$r.outcome='complete';$r.timedOut=$false;$r.cleanupConfirmed=$true;$r.terminationConfirmed=$true;$r.remainingSessions=0;$r.remainingProcesses=0;$r.unknownOwnerCount=0
      $script:LastShutdown=$r;return $r
    }
    'captureResetSnapshot' {
      Assert-Context $c;$j=Owned-Journal $c;$a=Admission $c
      if($a.kind -ne 'bound-existing' -or $null -eq $script:LastShutdown -or $j.phase -ne 'stopping-account') { Deny 'binding_unverified' }
      $u=Local-Account;$accountAt=Millis;$p=Profile-Facts $c.operation.accountSid;$s=Session-Facts $c.operation.accountSid;$q=Process-Facts $c.operation.accountSid
      Assert-ProfileNamespace $p
      if($null -eq $u -or !$p.owned -or $u.SID.Value -ne $c.operation.accountSid){Deny 'identity_mismatch'}
      $probes=@{}
      foreach($name in @('binding','account','sessions','processes','profile','logonFence','lease','journal')) { $probes[$name]=Scope $c }
      $probes.binding.capturedAtMs=$a.capturedAtMs;$probes.account.capturedAtMs=$accountAt;$probes.logonFence.capturedAtMs=$accountAt
      $probes.binding.machineSid=$script:MachineSid;$probes.binding.accountName='user1';$probes.binding.ownerVerified=$true;$probes.binding.storageProtected=$true
      $probes.account.exists=$true;$probes.account.isLocal=$true;$probes.account.accountType='user';$probes.account.name='user1';$probes.account.builtin=$false;$probes.account.protected=$false;$probes.account.enabled=[bool]$u.Enabled;$probes.account.currentUserSid=$a.currentUserSid;$probes.account.currentUserProfilePath=$a.currentUserProfilePath
      $probes.shutdown=$script:LastShutdown.Clone();$probes.shutdown.spawnFailed=$false
      $probes.sessions.activeCount=$s.active;$probes.sessions.unknownOwnerCount=$s.unknown;$probes.sessions.capturedAtMs=$s.capturedAtMs
      $probes.processes.remainingCount=$q.processes.Count;$probes.processes.unknownOwnerCount=$q.unknown;$probes.processes.capturedAtMs=$q.capturedAtMs
      $probes.profile.exists=$p.exists;$probes.profile.loaded=$p.cim[0].Loaded;$probes.profile.special=$p.cim[0].Special;$probes.profile.hiveLoaded=$p.hiveLoaded;$probes.profile.path=$script:Target;$probes.profile.profilesRoot='C:\Users';$probes.profile.ownerSid=$u.SID.Value;$probes.profile.ownershipVerified=$p.owned;$probes.profile.profilesRootVerified=$true;$probes.profile.registeredSid=$p.registrations[0].sid;$probes.profile.registeredPath=$p.registrations[0].path;$probes.profile.ancestorsReparseFree=$true;$probes.profile.leafReparseFree=$true;$probes.profile.capturedAtMs=$p.capturedAtMs
      $probes.profile=Set-ProfileNamespaceProof $probes.profile $p
      $probes.logonFence.kind='account-disabled';$probes.logonFence.applied=(!$u.Enabled)
      $probes.lease.scope='machine';$probes.lease.held=$true;$probes.lease.exclusive=$true;$probes.lease.nonce=$script:Lease.nonce;$probes.lease.unresolvedWriter=$false;$probes.lease.expiresAtMs=$script:Lease.expiresAtMs
      $probes.journal.unresolved=$false;$probes.journal.priorUnresolved=$false;$probes.journal.currentOperationOwned=$true;$probes.journal.storageProtected=$true;$probes.journal.durablePhase=$j.phase;$probes.journal.phase='validated'
      return @{schemaVersion=1;operation=$c.operation;probes=$probes}
    }
    'purgeProfile' {
      Assert-Expected $c $command
      $quarantine=[IO.Path]::Combine($script:StateRoot,('purge-'+$script:Lease.nonce))
      if($null -ne (Read-ItemExact $quarantine)){Deny 'profile_purge_incomplete'}
      $j=Owned-Journal $c;$j.quarantinePath=$quarantine;$j.quarantineState='rename-pending';Write-State 'journal.json' $j
      Assert-Expected $c $command
      $moved=[FixerResetNativeV1]::Quarantine($script:Target,$quarantine,$c.operation.accountSid)
      $j.quarantineState='quarantined';$j.quarantineVolume=$moved.Volume;$j.quarantineFileId=$moved.FileId;Write-State 'journal.json' $j
      $j.quarantineState='purge-intent';Write-State 'journal.json' $j
      # Delete only this protected unique old path. Unknown purge never permits recreation.
      Assert-QuarantinedExpected $c
      [FixerResetNativeV1]::Purge($c.operation.accountSid,$quarantine)
      $p=Profile-Facts $c.operation.accountSid $quarantine
      Assert-ProfileNamespace $p
      if($null -ne (Read-ItemExact $quarantine) -or !$p.absent) { Deny 'profile_purge_incomplete' }
      $r=Effect-Proof $c;$r.purgeComplete=$true;$r.remainingOwnedPaths=0;$r.unknownPaths=0;$r.profileFolderAbsent=$true;$r.profileRegistrationAbsent=$true;return $r
    }
    'deleteAccount' {
      Assert-Expected $c $command
      Microsoft.PowerShell.LocalAccounts\Remove-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($c.operation.accountSid)) -ErrorAction Stop
      if($null -ne (Local-Account) -or !(Profile-Facts $c.operation.accountSid).absent) { Deny 'identity_mismatch' }
      $r=Effect-Proof $c;$r.accountAbsent=$true;$r.profileFolderAbsent=$true;$r.profileRegistrationAbsent=$true;return $r
    }
    'createDisabledAccount' {
      Assert-Expected $c $command
      if($secret -isnot [string] -or $secret.Length -lt 20 -or $secret.Length -gt 1024) { Deny 'credentials_invalid' }
      $secure=ConvertTo-SecureString -String $secret -AsPlainText -Force
      try { $new=Microsoft.PowerShell.LocalAccounts\New-LocalUser -Name 'user1' -Password $secure -Disabled -AccountNeverExpires -PasswordNeverExpires -ErrorAction Stop }
      finally { $secure.Dispose();$secret=$null }
      $u=Local-Account;$current=Current-Profile
      if($null -eq $u -or $u.SID.Value -ne $new.SID.Value -or $u.Enabled -or $u.SID.Value -eq $current.sid -or !(Profile-Facts $u.SID.Value).absent) { Deny 'identity_mismatch' }
      $script:CreatedSid=$u.SID.Value
      $j=Owned-Journal $c;$j.newAccountSid=$script:CreatedSid;Write-State 'journal.json' $j
      $role=Ensure-StandardAccountMembership $c $u.SID.Value
      $r=Effect-Proof $c;$r.accountSid=$u.SID.Value;$r.created=$true;$r.disabled=$true;$r.isLocal=$true;$r.accountName='user1';$r.currentUserProtected=$true;$r.currentUserSid=$current.sid;return Set-StandardAccountProof $r $role
    }
    'createProfile' {
      Assert-Expected $c $command
      $path=[FixerResetNativeV1]::Provision($c.operation.accountSid)
      if(!(ExactPath $path)) { Deny 'profile_creation_mismatch' }
      $p=Profile-Facts $c.operation.accountSid
      if(!$p.owned -or $p.cim[0].Loaded -or $p.cim[0].Special -or $p.hiveLoaded) { Deny 'identity_mismatch' }
      $r=Effect-Proof $c;$r.created=$true;$r.registeredSid=$c.operation.accountSid;$r.ownershipVerified=$true;$r.loaded=$false;$r.special=$false;$r.ancestorsReparseFree=$true;$r.leafReparseFree=$true;return $r
    }
    'enableAccount' {
      Assert-Expected $c $command
      [void](Assert-StandardAccount $c $c.operation.accountSid)
      Microsoft.PowerShell.LocalAccounts\Enable-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($c.operation.accountSid)) -ErrorAction Stop
      $u=Local-Account;if($null -eq $u -or $u.SID.Value -ne $c.operation.accountSid -or !$u.Enabled) { Deny 'identity_mismatch' }
      $role=Assert-StandardAccount $c $c.operation.accountSid
      if(!$role.account.Enabled){Deny 'standard_account_unverified'}
      $r=Effect-Proof $c;$r.enabled=$true;return Set-StandardAccountProof $r $role
    }
    'verifyProvisionedState' {
      $a=Admission $c;$p=Profile-Facts $c.operation.accountSid
      if($a.kind -ne 'bound-existing' -or $a.enabled -ne $c.expectedEnabled -or !$p.owned -or $p.cim[0].Special) { Deny 'identity_mismatch' }
      if(!$c.expectedEnabled -and ($p.cim[0].Loaded -or $p.hiveLoaded)) { Deny 'target_in_use' }
      $role=Assert-StandardAccount $c $c.operation.accountSid
      if($role.account.Enabled -ne $c.expectedEnabled){Deny 'standard_account_unverified'}
      $r=Scope $c;$r.bindingVerified=$true;$r.profileVerified=$true;$r.enabled=$a.enabled;return Set-StandardAccountProof $r $role
    }
    'releaseLease' {
      Assert-Context $c;$j=Read-State 'journal.json'
      $completed=($null -ne $j -and $j.unresolved -eq $false -and $j.phase -eq 'complete' -and $j.operationId -ceq $c.operation.id -and $j.leaseNonce -ceq $script:Lease.nonce)
      $cleanAdmission=(!$script:JournalOwned -and !$script:EffectsStarted -and ($null -eq $j -or ($j.unresolved -eq $false -and $j.phase -eq 'complete')))
      if(!$completed -and !$cleanAdmission){Deny 'recovery_required'}
      if($null -ne $script:Workflow){Complete-OwnedWorkflowResources $c}
      $r=Scope $c 'released';$r.nonce=$script:Lease.nonce
      $script:Lease.unresolved=$false;Write-StreamJson $script:LeaseStream $script:Lease
      $script:LeaseStream.Dispose();$script:LeaseStream=$null;$script:Lease=$null;return $r
    }
    'close' { if($null -ne $script:LeaseStream) { Deny 'recovery_required' };return @{status='closed';complete=$true;leaseHeld=$false} }
    default { Deny 'context_invalid' }
  }
}

try {
  if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -ne 'Core' -or ![Environment]::Is64BitProcess -or !$IsWindows) { Deny 'unsupported_host' }
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Deny 'unsupported_host' }
  $module=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts\1.0.0.0\Microsoft.PowerShell.LocalAccounts.psd1')
  $manifest=Test-ModuleManifest -Path $module -ErrorAction Stop
  if('Core' -notin $manifest.CompatiblePSEditions) { Deny 'unsupported_host' }
  Import-Module -Name $module -ErrorAction Stop
  foreach($name in @('Remove-LocalUser','Disable-LocalUser','Enable-LocalUser','Get-LocalGroup','Add-LocalGroupMember')) {
    $cmd=Get-Command ('Microsoft.PowerShell.LocalAccounts\'+$name) -ErrorAction Stop
    if($cmd.CommandType -ne 'Cmdlet' -or !$cmd.Parameters.ContainsKey('SID')) { Deny 'unsupported_host' }
  }
  $memberCommand=Get-Command 'Microsoft.PowerShell.LocalAccounts\Add-LocalGroupMember' -ErrorAction Stop
  if(!$memberCommand.Parameters.ContainsKey('Member') -or $memberCommand.Parameters['Member'].ParameterType.FullName -notmatch '\.LocalPrincipal\[\]$'){Deny 'unsupported_host'}
  Add-Type -TypeDefinition $nativeSource -ErrorAction Stop
  # Presence only. This preflight never enables privileges or assigns rights.
  if(![FixerResetNativeV1]::ProfilePrivilegesAssigned()){Deny 'profile_privileges_unavailable'}
  $script:MachineId=[Environment]::MachineName
  $domains=@(Microsoft.PowerShell.LocalAccounts\Get-LocalUser -ErrorAction Stop | ForEach-Object { if($null -ne $_.SID.AccountDomainSid -and $_.SID.AccountDomainSid.Value -like 'S-1-5-21-*') { $_.SID.AccountDomainSid.Value } } | Sort-Object -Unique)
  if($domains.Count -ne 1) { Deny 'unsupported_host' };$script:MachineSid=$domains[0]
  foreach($path in @('C:\','C:\ProgramData')) { $script:Guards.Add([FixerResetNativeV1]::GuardDirectory($path)) }
  foreach($path in @('C:\ProgramData\1132 Fixer',$script:StateRoot)) {
    [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($path),(Directory-Security))
    Assert-Private $path;$script:Guards.Add([FixerResetNativeV1]::GuardDirectory($path))
  }
  if(!([FixerResetNativeV1]::ProfilesRoot().Equals('C:\Users',[StringComparison]::OrdinalIgnoreCase))) { Deny 'unsupported_host' }
  $script:Guards.Add([FixerResetNativeV1]::GuardDirectory('C:\Users'))
  $nativeAvailable=[FixerResetNativeV1]::VerifyExports()
  $cimAvailable=$true
  foreach($className in @('Win32_UserProfile','Win32_UserAccount','Win32_LogonSession','Win32_Process','Win32_LoggedOnUser','Win32_SessionProcess')) {
    $class=Get-CimClass -ClassName $className -OperationTimeoutSec 10 -ErrorAction Stop
    if($null -eq $class){$cimAvailable=$false}
  }
  $probe=Open-Private 'storage-probe.json' -AllowNew
  try { Write-StreamJson $probe @{schemaVersion=1;nonce=$script:WorkerNonce};$storageAvailable=((Read-StreamJson $probe).nonce -ceq $script:WorkerNonce) } finally {$probe.Dispose()}
  $namespaceAvailable=Assert-ProfileNamespaceProtected
  $sidCommands=$true
  $caps=@{atomicIdentityExpectation=($nativeAvailable -and $sidCommands -and $namespaceAvailable);exclusiveProfileCreation=($nativeAvailable -and $namespaceAvailable -and $script:Guards.Count -eq 5);completePurgeReadback=($nativeAvailable -and $cimAvailable -and $storageAvailable)}
  if($caps.Values -contains $false){Deny 'unsupported_host'}
  $ready=@{kind='ready';protocolVersion=1;scriptSha256=$global:FixerResetScriptSha256;workerNonce=$script:WorkerNonce;machineId=$script:MachineId;machineSid=$script:MachineSid;shell=@{major=$PSVersionTable.PSVersion.Major;edition=$PSVersionTable.PSEdition;is64Bit=[Environment]::Is64BitProcess};storageProtected=$true;capabilities=$caps}
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $ready -Depth 8 -Compress))
  while($null -ne ($line=[Console]::In.ReadLine())) {
    $request=$null;$reply=$null;$command=''
    try {
      if($line.Length -gt 65536) { Deny 'context_invalid' }
      $request=ConvertFrom-Json -InputObject $line -AsHashtable -ErrorAction Stop
      $command=[string]$request.command
      if($request.id -isnot [string] -or $request.id -notmatch '^[A-Za-z0-9._:-]{1,128}$') { Deny 'context_invalid' }
      $result=Handle-Command $command $request.context $request['secret']
      $reply=@{kind='response';protocolVersion=1;scriptSha256=$global:FixerResetScriptSha256;workerNonce=$script:WorkerNonce;id=$request.id;command=$command;ok=$true;completed=$true;result=$result}
    } catch {
      $safe=@('unsupported_host','storage_unverified','context_invalid','lease_busy','prior_unresolved','identity_mismatch','target_in_use','namespace_not_absent','credentials_invalid','profile_purge_incomplete','profile_creation_mismatch','binding_unverified','journal_unverified','recovery_required','native_failure','zoom_untrusted','zoom_not_ready','zoom_exited','profile_privileges_unavailable','profile_privilege_restore_unverified','standard_account_unverified','standard_account_privileged','profile_namespace_unverified')
      $code=Safe-ErrorCode $_.Exception $safe
      $reply=@{kind='response';protocolVersion=1;scriptSha256=$global:FixerResetScriptSha256;workerNonce=$script:WorkerNonce;id=if($null -ne $request){$request.id}else{''};command=$command;ok=$false;completed=$true;error=@{code=$code}}
    } finally { if($null -ne $request) { $request['secret']=$null };$line=$null }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Depth 16 -Compress))
    if($command -eq 'close' -and $reply.ok) { break }
  }
} catch {
  $startupCode=Safe-ErrorCode $_.Exception @('unsupported_host','storage_unverified','profile_privileges_unavailable')
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{kind='startup-error';protocolVersion=1;error=@{code=$startupCode}} -Compress))
} finally {
  # EOF never resolves an interrupted journal. Close only handles owned here.
  if($null -ne $script:LeaseStream) { $script:LeaseStream.Dispose() }
  foreach($guard in $script:Guards) { $guard.Dispose() }
}
`;


const WINDOWS_WORKER_SHA256 = crypto.createHash('sha256').update(WINDOWS_WORKER_SOURCE, 'utf8').digest('hex');

async function createHelperResetWindows(options = {}) {
  const { transport, credentials, expectedMachineId, admission } = options;
  const clock = options.now || Date.now;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (!transport || typeof transport.start !== 'function' ||
      !credentials || typeof credentials.withPassword !== 'function' ||
      !identifier(expectedMachineId) || typeof clock !== 'function' ||
      !positive(timeoutMs) || timeoutMs > 0x7fffffff || !record(admission) ||
      admission.verified !== true || admission.kind !== 'recovery-probe' ||
      admission.machineId !== expectedMachineId || !identifier(admission.token)) {
    throw fail('native_configuration_invalid');
  }
  const session = await transport.start({
    bootstrapLine: Buffer.from(WINDOWS_WORKER_SOURCE, 'utf8').toString('base64'),
    startArgs: [...BOOTSTRAP_ARGS],
    scriptSha256: WINDOWS_WORKER_SHA256,
    maxResponseBytes: 256 * 1024,
    startupTimeoutMs: timeoutMs,
    admission: { ...admission }
  });
  let retained = false;
  let serial = 0;
  let credentialOperation = null;
  let secretDigest = null;
  let currentContext = null;
  let currentSeal = null;
  function retain(reason) {
    retained = true;
    if (session && typeof session.retainCustody === 'function') session.retainCustody(reason);
  }
  function blocked() {
    return retained || (session && typeof session.state === 'function' && session.state().retained === true);
  }
  const info = session && typeof session.info === 'function' && session.info();
  if (!record(info) || info.protocolVersion !== 1 || info.machineId !== expectedMachineId ||
      info.scriptSha256 !== WINDOWS_WORKER_SHA256 || !identifier(info.workerNonce) ||
      !record(info.shell) || info.shell.major !== 7 || info.shell.edition !== 'Core' || info.shell.is64Bit !== true ||
      info.storageProtected !== true || !record(info.capabilities) ||
      ['atomicIdentityExpectation', 'exclusiveProfileCreation', 'completePurgeReadback']
        .some(name => info.capabilities[name] !== true) ||
      typeof session.request !== 'function' || typeof session.close !== 'function') {
    retain('native_handshake_unverified');
    throw fail('native_handshake_unverified');
  }
  const capabilities = Object.freeze({ ...info.capabilities });
  const now = () => { const n = clock(); if (!positive(n)) throw fail('clock_invalid'); return n; };
  function freshReceipt(value, context, command) {
    const op = context.operation;
    const time = now();
    if (!record(value) || value.complete !== true || value.operationId !== op.id ||
        value.generation !== op.generation || value.machineId !== op.machineId ||
        value.leaseNonce !== op.leaseNonce || !positive(value.capturedAtMs) ||
        value.capturedAtMs > time || time - value.capturedAtMs >= MAX_AGE_MS ||
        !sameProfile(value.profilePath)) return false;
    if (command === 'createDisabledAccount') {
      return typeof value.accountSid === 'string' && value.accountSid.startsWith(op.machineSid + '-') &&
        Number(value.accountSid.slice(op.machineSid.length + 1)) >= 1000;
    }
    if (command === 'inspectAdmission' || command === 'revalidateAdmission') {
      return admissionNamespaceReceipt(value, context, command, time);
    }
    return value.accountSid === op.accountSid;
  }
  async function withCredentialForCurrentOperation(context, callback) {
    assertScope(context, expectedMachineId);
    const key = operationKey(context);
    if (blocked() || typeof callback !== 'function') throw fail('recovery_required');
    if (credentialOperation !== null && credentialOperation !== key) throw fail('credentials_invalid');
    let used = false;
    const value = await credentials.withPassword(copyContext(context), async password => {
      if (used) { retain('credential_provider_replayed'); throw fail('credentials_invalid'); }
      used = true;
      if (typeof password !== 'string' || password.length < 20 || password.length > 128 ||
          /[\x00-\x1f\x7f]/.test(password)) throw fail('credentials_invalid');
      const digest = crypto.createHash('sha256').update(password, 'utf8').digest();
      if (secretDigest && !crypto.timingSafeEqual(secretDigest, digest)) {
        digest.fill(0); retain('credential_provider_changed'); throw fail('credentials_invalid');
      }
      if (!secretDigest) { credentialOperation = key; secretDigest = Buffer.from(digest); }
      digest.fill(0);
      try { return await callback(password); } finally { password = null; }
    });
    if (!used) throw fail('credentials_invalid');
    return value;
  }
  async function request(command, context, secret) {
    if (blocked()) throw fail('recovery_required');
    if (!['inspectRecovery', ...REQUIRED_ADAPTERS, ...Object.values(WORKFLOW_COMMANDS)].includes(command)) {
      throw fail('context_invalid');
    }
    if (command !== 'inspectRecovery') assertScope(context, expectedMachineId);
    const id = 'native-' + (++serial);
    const packet = { id, command, context: copyContext(context || {}) };
    if (secret !== undefined) {
      if (!SECRET_COMMANDS.has(command)) throw fail('credentials_invalid');
      packet.secret = secret;
    }
    let response;
    try { response = await session.request(packet, { timeoutMs }); }
    catch (_) { retain('native_request_uncertain'); throw fail('native_request_uncertain'); }
    finally { packet.secret = null; }
    if (!record(response) || response.ok !== true || response.completed !== true || !record(response.result)) {
      if (EFFECT_COMMANDS.has(command) || !response || response.completed !== true ||
          command === 'releaseLease') retain('native_request_unverified');
      const code = response && response.error && response.error.code;
      throw fail(typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'native_request_unverified');
    }
    const result = response.result;
    if (command === 'inspectRecovery') {
      if (result.complete !== true || result.machineId !== expectedMachineId ||
          result.storageProtected !== true || typeof result.blocked !== 'boolean' ||
          result.status !== (result.blocked ? 'blocked' : 'clear')) {
        retain('native_recovery_unverified'); throw fail('native_recovery_unverified');
      }
      return result;
    }
    if (command === 'acquireLease') {
      if (result.status === 'busy' && result.complete === true && result.acquired === false) return result;
      const op = context.operation, time = now();
      if (result.status !== 'held' || result.scope !== 'machine' || result.exclusive !== true ||
          result.machineVerified !== true || result.operationId !== op.id || result.generation !== op.generation ||
          result.machineId !== expectedMachineId || !identifier(result.nonce) ||
          typeof result.machineSid !== 'string' || !/^S-1-5-21-\d+-\d+-\d+$/.test(result.machineSid) ||
          !positive(result.acquiredAtMs) || result.acquiredAtMs > time ||
          !positive(result.expiresAtMs) || result.expiresAtMs <= time) {
        retain('native_lease_unverified'); throw fail('native_lease_unverified');
      }
      return result;
    }
    if (command === 'captureResetSnapshot') {
      if (result.schemaVersion !== 1 || !record(result.operation) || !record(result.probes) ||
          Object.entries(context.operation).some(([key, value]) => result.operation[key] !== value)) {
        retain('native_snapshot_unverified'); throw fail('native_snapshot_unverified');
      }
      return result; // Controller evaluates every independently timestamped probe.
    }
    if (!freshReceipt(result, context, command)) {
      retain('native_scope_unverified'); throw fail('native_scope_unverified');
    }
    if (ROLE_COMMANDS.has(command) && (result.usersGroupSid !== 'S-1-5-32-545' ||
        result.usersMembershipVerified !== true || result.administratorsExcluded !== true ||
        result.groupEnumerationComplete !== true || result.standardAccountVerified !== true ||
        result.membershipProofKind !== 'raw-local-sid')) {
      retain('native_standard_account_unverified'); throw fail('native_standard_account_unverified');
    }
    if (command.startsWith('workflow-')) {
      if (result.status !== 'verified' || result.verified !== true ||
          result.step !== command.slice('workflow-'.length) ||
          result.registeredSid !== context.operation.accountSid || !sameProfile(result.registeredPath)) {
        retain('native_workflow_unverified'); throw fail('native_workflow_unverified');
      }
    }
    if (command === 'workflow-seal-credential') {
      const binding = result.binding;
      if (typeof result.ciphertext !== 'string' || !result.ciphertext ||
          Buffer.from(result.ciphertext, 'base64').toString('base64') !== result.ciphertext ||
          result.protection !== 'DPAPI-CurrentUser' || result.currentUserProtected !== true ||
          typeof result.operatorSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(result.operatorSid) ||
          result.operatorSid === context.operation.accountSid || typeof result.operatorProfilePath !== 'string' ||
          !/^[A-Za-z]:\\/.test(result.operatorProfilePath) || !record(binding) ||
          binding.operatorSid !== result.operatorSid || binding.operatorProfilePath !== result.operatorProfilePath ||
          binding.accountSid !== context.operation.accountSid || binding.operationId !== context.operation.id ||
          binding.generation !== context.operation.generation || binding.machineId !== context.operation.machineId ||
          binding.machineSid !== context.operation.machineSid || !sameProfile(binding.profilePath)) {
        retain('native_credential_unverified'); throw fail('native_credential_unverified');
      }
      currentSeal = { key: operationKey(context), accountSid: context.operation.accountSid,
        operatorSid: result.operatorSid, operatorProfilePath: result.operatorProfilePath,
        hash: crypto.createHash('sha256').update(Buffer.from(result.ciphertext, 'base64')).digest('hex') };
    }
    if (command === 'workflow-persist-credential') {
      const expectedPath = currentSeal && typeof currentSeal.operatorProfilePath === 'string'
        ? windowsPath.join(currentSeal.operatorProfilePath, 'AppData', 'Roaming', '1132 Fixer',
          'helper-credentials-v2', context.operation.id + '.json') : null;
      if (!currentSeal || !expectedPath || currentSeal.key !== operationKey(context) ||
          currentSeal.accountSid !== context.operation.accountSid || result.stored !== true ||
          result.readbackVerified !== true || result.storageProtected !== true || result.ownerVerified !== true ||
          result.formatVersion !== 2 || result.protection !== 'DPAPI-CurrentUser' || result.currentUserProtected !== true ||
          result.operatorSid !== currentSeal.operatorSid || result.operatorProfilePath !== currentSeal.operatorProfilePath ||
          result.ciphertextSha256 !== currentSeal.hash || typeof result.path !== 'string' ||
          result.path.toLowerCase() !== expectedPath.toLowerCase() || result.credentialPath !== result.path) {
        retain('native_storage_unverified'); throw fail('native_storage_unverified');
      }
    }
    if (command === 'createDisabledAccount') {
      currentContext = copyContext(context);
      currentContext.operation.accountSid = result.accountSid;
    }
    return result;
  }
  const adapters = { capabilities };
  adapters.onAuthorityLost = () => retain('caller_retained');
  for (const name of REQUIRED_ADAPTERS) {
    adapters[name] = context => SECRET_COMMANDS.has(name)
      ? withCredentialForCurrentOperation(context, password => request(name, context, password))
      : request(name, context);
  }
  async function runWorkflowStep(name, context, values = {}) {
    assertScope(context, expectedMachineId);
    const signal = context.signal;
    if (signal && signal.aborted) throw fail('operation_cancelled');
    if (!Object.hasOwn(WORKFLOW_COMMANDS, name) || !record(values) ||
        Object.keys(values).some(key => key !== 'zoomPath') ||
        (name !== 'launch-zoom' && Object.keys(values).length)) throw fail('context_invalid');
    if (!currentContext || operationKey(context) !== operationKey(currentContext) ||
        context.operation.accountSid !== currentContext.operation.accountSid) throw fail('context_invalid');
    if (name === 'persist-credential' && !currentSeal) throw fail('native_credential_unverified');
    const payload = copyContext(context);
    if (name === 'launch-zoom') {
      if (typeof values.zoomPath !== 'string' || !/^[A-Za-z]:\\/.test(values.zoomPath) ||
          /[\x00-\x1f"'<>|?*]/.test(values.zoomPath) || values.zoomPath.slice(2).includes(':')) {
        throw fail('zoom_untrusted');
      }
      payload.zoomPath = values.zoomPath;
    }
    const command = WORKFLOW_COMMANDS[name];
    const result = await (SECRET_COMMANDS.has(command)
      ? withCredentialForCurrentOperation(context, password => request(command, payload, password))
      : request(command, payload));
    if (signal && signal.aborted) {
      retain('caller_retained');
      throw fail('recovery_required');
    }
    return result;
  }
  async function close() {
    if (blocked()) throw fail('recovery_required');
    const result = await session.close();
    if (!result || result.ok !== true || result.completed !== true || !record(result.result) ||
        result.result.status !== 'closed' || result.result.complete !== true || result.result.leaseHeld !== false) {
      retain('native_close_unverified'); throw fail('native_close_unverified');
    }
    if (secretDigest) { secretDigest.fill(0); secretDigest = null; }
    return result;
  }
  return Object.freeze({
    adapters: Object.freeze(adapters),
    inspectRecovery: () => request('inspectRecovery', {}),
    runWorkflowStep,
    withCredentialForCurrentOperation,
    hasUnresolvedCustody: blocked,
    retainCustody: reason => retain(reason || 'caller_retained'),
    close,
    info: () => ({ protocolVersion: 1, machineId: info.machineId, scriptSha256: info.scriptSha256,
      shell: { ...info.shell }, storageProtected: info.storageProtected, capabilities: { ...capabilities } })
  });
}
module.exports = { createHelperResetWindows, WINDOWS_WORKER_SOURCE, WINDOWS_WORKER_SHA256,
  WORKFLOW_COMMANDS, DEFAULT_TIMEOUT_MS };
