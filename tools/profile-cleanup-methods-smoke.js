'use strict';

// Production native handles operate only on owned scratch trees. The ACL,
// account and profile-service adapters are synthetic; no live state changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { PROFILE_UNLOADED_GUARD } = require('../src/main/helper-profile-idle');
const { NATIVE_PS_STDIN_ARGS, nativePowerShell7, prepareNativeScript } = require('./native-powershell');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function template(name) {
  const start = main.indexOf(`const ${name} = `);
  assert.notEqual(start, -1);
  const body = main.indexOf('`', start);
  const end = main.indexOf('`;', body + 1);
  assert.notEqual(end, -1);
  return vm.runInNewContext(main.slice(start + `const ${name} = `.length, end + 1), { PROFILE_UNLOADED_GUARD });
}
const cleanup = template('PS_REMOVE_PROFILE_HELPER');
const identity = template('PS_PROFILE_PATH_IDENTITY_HELPER');
assert.ok(!/cmd\.exe|\brd\s+\/|Directory\]::(?:Set|Get)AccessControl/.test(cleanup),
  'cleanup has no command-shell or Desktop-only ACL fallback');
assert.ok(!/Remove-Item|\[IO\.(?:Directory|File)\]::Delete|takeown[^\r\n]*['"]\/R|icacls[^\r\n]*['"]\/T/.test(cleanup),
  'cleanup never deletes descendants by path or applies recursive ownership');
assert.ok(cleanup.includes('Set-Acl -LiteralPath $Path') && cleanup.includes('Get-Acl -LiteralPath $Path') &&
  cleanup.includes('$Lease.DeleteEmpty()') && cleanup.includes('Assert-FixerProfileUnloaded -Sid $Sid'),
  'private ACL, loaded-profile guard and handle-owned final deletion remain');
assert.ok(identity.includes('RootDirectory = parent.DangerousGetHandle()') &&
  identity.includes('FILE_SHARE_READ, out status') && cleanup.includes('$frame.entry.OpenChild($name)') &&
  cleanup.includes('$maximumEntries = 100000') && cleanup.includes('$maximumDepth = 128') &&
  cleanup.includes('$maximumMilliseconds = 120000') && cleanup.includes('$owned[$index].Dispose()'),
  'relative no-follow acquisition, retained ancestors and bounded cleanup remain');

if (process.platform !== 'win32') {
  console.log('profile-cleanup-methods-smoke: 4 source checks passed; native fixtures not-run (non-Windows host)');
  process.exit(0);
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-cleanup-methods-ü [literal]-'));
const fixtureParent = fs.realpathSync(path.dirname(fixtureRoot));
const quoted = value => value.replace(/'/g, "''");
const cases = ['clear', 'loaded', 'enumeration', 'acl', 'identity', 'escape', 'lease', 'writer', 'readonly', 'swap', 'writer-setup-failure'];
const nested = 'nested ü [literal]';
for (const name of cases) {
  const profile = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(profile, nested), { recursive: true });
  fs.writeFileSync(path.join(profile, '[literal].txt'), 'literal');
  fs.writeFileSync(path.join(profile, nested, 'owned.txt'), 'owned');
}
fs.mkdirSync(path.join(fixtureRoot, 'outside'));
fs.writeFileSync(path.join(fixtureRoot, 'outside', 'sentinel.txt'), 'outside');
const junction = path.join(fixtureRoot, 'clear', 'outside-link');
fs.symlinkSync(path.join(fixtureRoot, 'outside'), junction, 'junction');

try {
  const fixture = `
    $ErrorActionPreference = 'Stop'
    ${identity}
    ${cleanup}
    function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)]$Object) }
    $fixtureRoot = '${quoted(fixtureRoot)}'
    $nested = '${nested}'
    $script:acl = [Security.AccessControl.DirectorySecurity]::new()
    $script:acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    $script:validAcl = $script:acl
    $script:aclFails = $false
    $script:loaded = $false
    $script:identityFails = ''
    $script:disposed = $false
    $script:ownershipArguments = @()
    $script:aclWrites = 0
    $script:swapAttempted = $false
    $script:swapBlocked = $false
    $script:swapNativeCode = $null
    function Start-Process {
      [CmdletBinding()] param([string]$FilePath,[string[]]$ArgumentList,[switch]$Wait,[string]$WindowStyle,[switch]$PassThru)
      if (-not $FilePath.EndsWith('takeown.exe') -or -not $Wait -or -not $PassThru -or $WindowStyle -ne 'Hidden') {
        throw 'unexpected native fixture command'
      }
      $script:ownershipArguments = @($ArgumentList)
      $process = [pscustomobject]@{ ExitCode = 0 }
      $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposed = $true }
      return $process
    }
    function Set-Acl {
      [CmdletBinding()] param([string]$LiteralPath,[object]$AclObject)
      if ($LiteralPath -cne (Join-Path $fixtureRoot 'clear')) { throw 'unexpected ACL target' }
      $script:aclWrites++
      $script:acl = $AclObject
    }
    function Get-Acl {
      [CmdletBinding()] param([string]$LiteralPath)
      if ($script:aclFails) { throw 'fixture ACL unavailable' }
      return $script:acl
    }
    function Assert-FixerProfileUnloaded { param([string]$Sid) if ($script:loaded) { throw 'fixture profile loaded' } }
    $script:originalIdentityAssert = (Get-Command Assert-FixerProfilePathIdentity).ScriptBlock
    function Assert-FixerProfilePathIdentity {
      [CmdletBinding()] param([string]$Path,[bool]$ExpectedExists,[string]$ExpectedIdentity,[string]$ExpectedResolvedPath)
      if ($script:identityFails -and $Path -ieq $script:identityFails) { throw 'fixture directory identity drift' }
      & $script:originalIdentityAssert @PSBoundParameters
    }
    function Get-FixtureFailure {
      param([Management.Automation.ErrorRecord]$Record,[string]$Stage)
      $exception = $Record.Exception
      $parameterName = ''
      while ($null -ne $exception) {
        if ($exception.PSObject.Properties['ParameterName'] -and
            [string]$exception.ParameterName -match '^[A-Za-z][A-Za-z0-9_]{0,63}$') {
          $parameterName = [string]$exception.ParameterName
        }
        if ($null -eq $exception.InnerException) { break }
        $exception = $exception.InnerException
      }
      $errorId = [string]$Record.FullyQualifiedErrorId
      if ($errorId.Length -gt 200 -or $errorId -notmatch '^[A-Za-z_][A-Za-z0-9_.+,-]*$') { $errorId = 'unclassified' }
      [pscustomobject]@{
        stage = $Stage; exceptionClass = $exception.GetType().FullName
        nativeCode = if ($exception -is [ComponentModel.Win32Exception]) { $exception.NativeErrorCode } else { $null }
        api = if ($exception.Message -match '^(GetFileInformationByHandleEx:FileAttributeTagInfo|GetFileInformationByHandleEx:FileIdInfo|GetFinalPathNameByHandleW)$') { $exception.Message } else { '' }
        errorId = $errorId; parameterName = $parameterName
        scriptLine = [int]$Record.InvocationInfo.ScriptLineNumber
      }
    }
    $phase = 'acl-write'
    try {
      Protect-FixerProfileQuarantineRoot -Path (Join-Path $fixtureRoot 'clear')
      $aclTransport = ($script:aclWrites -eq 1 -and $script:disposed -and
        ($script:ownershipArguments -join '|') -ceq ('/F|"' + (Join-Path $fixtureRoot 'clear') + '"|/A'))
      $phase = 'acl-negative'
      $script:acl = [Security.AccessControl.DirectorySecurity]::new()
      $script:acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;WD)')
      $foreignAclBlocked = $false
      try { Assert-FixerProfilePrivateAcl -Path (Join-Path $fixtureRoot 'clear') } catch { $foreignAclBlocked = $true }
      $script:acl = $script:validAcl
      $records = @()
      foreach ($name in @('${cases.join("','")}')) {
        $phase = $name
        $profile = Join-Path $fixtureRoot $name
        $native = $null
        $writer = $null
        $lease = $null
        $quarantine = ''
        $completed = $false
        $failure = $null
        $stage = 'profile-identity'
        try {
          if ($name -eq 'writer-setup-failure') { throw [ComponentModel.Win32Exception]::new(123, 'fixture-setup') }
          $profileIdentity = Get-FixerProfilePathIdentity -Path $profile
          $stage = 'acquire-lease'
          $native = [FixerProfileIdentityV1]::AcquireQuarantineLease($profile, $profileIdentity.stableIdentity, $profileIdentity.resolvedPath)
          $stage = 'quarantine'
          $quarantine = $native.Quarantine()
          $script:loaded = ($name -eq 'loaded')
          $script:aclFails = ($name -eq 'acl')
          $script:identityFails = if ($name -eq 'identity') { $quarantine } else { '' }
          if ($name -in @('writer', 'writer-setup-failure')) {
            $stage = 'open-writer'
            $writer = [IO.FileStream]::new((Join-Path $quarantine '[literal].txt'), [IO.FileMode]::Open,
              [IO.FileAccess]::Write, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
          }
          if ($name -eq 'readonly') { $stage = 'set-readonly'; [IO.File]::SetAttributes((Join-Path $quarantine '[literal].txt'), [IO.FileAttributes]::ReadOnly) }
          $stage = 'fixture-adapters'
          $lease = [pscustomobject]@{ QuarantinePath = $quarantine; Native = $native; Case = $name; DeleteProved = $false; rootWasEmpty = $false; RootChildren = [Collections.Generic.List[object]]::new() }
          $lease | Add-Member -MemberType ScriptMethod -Name ReadChildren -Value {
            param([int]$Maximum)
            if ($this.Case -eq 'enumeration') { throw 'fixture enumeration unavailable' }
            $names = @($this.Native.ReadChildren($Maximum))
            if ($this.Case -eq 'escape') { $names += '..\\outside\\sentinel.txt' }
            return $names
          }
          $lease | Add-Member -MemberType ScriptMethod -Name OpenChild -Value {
            param([string]$Name)
            $entry = $this.Native.OpenChild($Name)
            $this.RootChildren.Add($entry)
            if ($this.Case -eq 'swap' -and $Name -ceq $nested) {
              $script:swapAttempted = $true
              try {
                [IO.Directory]::Move($entry.Path, ($entry.Path + '-moved'))
                New-Item -ItemType Junction -Path $entry.Path -Target (Join-Path $fixtureRoot 'outside') -ErrorAction Stop | Out-Null
              } catch [IO.IOException] {
                $script:swapBlocked = $true
                $script:swapNativeCode = $_.Exception.HResult -band 0xffff
              }
            }
            return $entry
          }
          $lease | Add-Member -MemberType ScriptMethod -Name DeleteEmpty -Value {
            $this.rootWasEmpty = (@($this.Native.ReadChildren(1)).Count -eq 0)
            if (-not $this.rootWasEmpty) { throw 'fixture root must be empty before final deletion' }
            $this.Native.DeleteEmpty()
            $this.DeleteProved = $this.Native.DeleteProved
          }
          if ($name -eq 'lease') { $lease.QuarantinePath = Join-Path $fixtureRoot 'outside' }
          $stage = 'cleanup'
          Remove-ProfileFolder -Path $quarantine -Sid 'S-1-5-21-1-2-3-1001' -ExpectedIdentity $profileIdentity.stableIdentity -ExpectedResolvedPath $quarantine -Lease $lease
          $completed = $true
        } catch {
          $failure = Get-FixtureFailure -Record $_ -Stage $stage
        } finally { if ($null -ne $writer) { $writer.Dispose() }; if ($null -ne $native) { $native.Dispose() } }
        $allCapturedDisposed = $true
        if ($null -ne $lease) { foreach ($entry in $lease.RootChildren) { if (-not $entry.IsDisposed) { $allCapturedDisposed = $false } } }
        $records += [pscustomobject]@{
          name = $name; completed = $completed; leaseDeleted = [bool]$lease.DeleteProved
          rootWasEmpty = [bool]$lease.rootWasEmpty
          rootPresent = [IO.Directory]::Exists($quarantine)
          originalPresent = [IO.Directory]::Exists($profile)
          capturedHandlesDisposed = $allCapturedDisposed
          writerFilePreserved = if (($name -in @('writer', 'readonly', 'writer-setup-failure')) -and $quarantine) { [IO.File]::Exists([IO.Path]::Combine($quarantine, '[literal].txt')) } else { $null }
          quarantined = [bool]$quarantine
          failure = $failure
        }
      }
      [pscustomobject]@{
        aclTransport = $aclTransport; foreignAclBlocked = $foreignAclBlocked
        outsidePreserved = ([IO.File]::ReadAllText((Join-Path $fixtureRoot 'outside\\sentinel.txt')) -ceq 'outside')
        swapAttempted = $script:swapAttempted; swapBlocked = $script:swapBlocked; swapNativeCode = $script:swapNativeCode
        records = @($records)
      } | ConvertTo-Json -Compress -Depth 5
    } catch {
      [pscustomobject]@{ phase = $phase; failure = (Get-FixtureFailure -Record $_ -Stage 'fixture-harness') } | ConvertTo-Json -Compress -Depth 4
      exit 1
    }
  `;
  const result = spawnSync(nativePowerShell7(), NATIVE_PS_STDIN_ARGS, {
    input: prepareNativeScript(fixture), encoding: 'utf8', windowsHide: true, timeout: 45000
  });
  assert.equal(result.status, 0, String(result.stdout || result.stderr || result.error?.code || 'native cleanup fixture failed'));
  assert.equal(String(result.stderr || '').trim(), '');
  const report = JSON.parse(String(result.stdout || '').trim());
  assert.equal(report.records.length, cases.length);
  assert.equal(report.records.every(record => record.quarantined === (record.name !== 'writer-setup-failure')), true,
    `all fixture setups preserve their original result; ${JSON.stringify(report.records)}`);
  assert.equal(report.aclTransport, true, 'private ACL writes use the literal path and dispose the owned process');
  assert.equal(report.foreignAclBlocked, true, 'an additional Everyone grant is refused');
  assert.equal(report.outsidePreserved, true, 'junction targets and escaped names remain untouched');
  assert.equal(report.swapAttempted, true, 'the fixture attempts replacement after the directory is inspected and held');
  assert.equal(report.swapBlocked, true, 'a held directory cannot be renamed and replaced with an outside junction');
  assert.equal(report.swapNativeCode, 32, 'the retained parent blocks replacement with a sharing violation');
  for (const record of report.records) {
    const success = ['clear', 'swap'].includes(record.name);
    const setupFailure = record.name === 'writer-setup-failure';
    assert.equal(record.quarantined, !setupFailure, `${record.name}: fixture setup completed; ${JSON.stringify(record)}`);
    assert.equal(record.completed, success, `${record.name}: expected cleanup outcome; ${JSON.stringify(record)}`);
    assert.equal(record.leaseDeleted, success, `${record.name}: uncertain cleanup never reaches root deletion`);
    assert.equal(record.rootPresent, !success && !setupFailure, `${record.name}: root remains until handle deletion`);
    assert.equal(record.originalPresent, setupFailure, `${record.name}: original name remains absent after quarantine`);
    assert.equal(record.capturedHandlesDisposed, true, `${record.name}: child handles close on every exit`);
    if (success) assert.equal(record.rootWasEmpty, true, 'root lease receives an empty retained directory');
    if (['writer', 'readonly'].includes(record.name)) assert.equal(record.writerFilePreserved, true, 'blocked target remains');
    if (record.name === 'writer') assert.equal(record.failure?.nativeCode, 32, 'a pre-existing writer causes a sharing violation');
    if (record.name === 'readonly') assert.equal(record.failure?.nativeCode, 5, 'readonly deletion fails with access denied');
    if (setupFailure) {
      assert.equal(record.writerFilePreserved, null, 'an unavailable quarantine path is never passed to a diagnostic path command');
      assert.equal(record.failure?.stage, 'profile-identity', 'early setup failure retains the original stage');
      assert.equal(record.failure?.exceptionClass, 'System.ComponentModel.Win32Exception', 'early setup failure is not replaced by a parameter error');
      assert.equal(record.failure?.nativeCode, 123, 'early setup failure retains the original native code');
      assert.ok(record.failure?.scriptLine > 0, 'native diagnostics identify a script line without printing source');
    }
  }
  console.log(`profile-cleanup-methods-smoke: 4 source checks and ${cases.length} native scenarios passed (owned Unicode scratch trees; synthetic profile/ACL adapters)`);
} finally {
  assert.equal(fs.realpathSync(path.dirname(fixtureRoot)), fixtureParent);
  assert.equal(fixtureParent, fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(fixtureRoot).startsWith('fixer-cleanup-methods-'));
  if (fs.existsSync(junction) && fs.lstatSync(junction).isSymbolicLink()) fs.unlinkSync(junction);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
