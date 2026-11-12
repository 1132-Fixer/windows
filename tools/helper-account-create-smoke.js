'use strict';

// Real generated account-create script, synthetic module only. No Windows
// account/group/credential API is invoked. All fixture state stays in memory.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const profileSafety = require('../profile-safety');
const { generateHelperPassword } = require('../helper-credential');
const windowsTools = require('../src/main/windows-tools');
const { nativePowerShell7, NATIVE_PS_STDIN_ARGS, prepareNativeScript } = require('./native-powershell');

let checks = 0;
function check(condition, name) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok  ${name}`);
}

const moduleSource = String.raw`
$script:mode = $env:FIXER_CREATE_SCENARIO
$script:reads = 0
$script:added = $false
$script:sid = 'S-1-5-21-100-200-300-1002'
$script:users = @()
if ($script:mode -eq 'existing' -or $script:mode -eq 'duplicate-existing') {
  $script:users = @([pscustomobject]@{Name='user1'; SID=[Security.Principal.SecurityIdentifier]::new('S-1-5-21-100-200-300-1001'); Enabled=$true})
  if ($script:mode -eq 'duplicate-existing') { $script:users += $script:users[0] }
}
if ($script:mode -eq 'sid-collision') {
  $script:users = @([pscustomobject]@{Name='unrelated'; SID=[Security.Principal.SecurityIdentifier]::new($script:sid); Enabled=$true})
}
function Get-LocalUser {
  [CmdletBinding()]param()
  $script:reads++
  if (($script:mode -eq 'replacement-before-groups' -and $script:reads -eq 2) -or
      ($script:mode -eq 'replacement-after-groups' -and $script:reads -eq 3)) {
    return [pscustomobject]@{Name='user1'; SID=[Security.Principal.SecurityIdentifier]::new('S-1-5-21-100-200-300-1003'); Enabled=$true}
  }
  return @($script:users)
}
function New-LocalUser {
  [CmdletBinding()]param([string]$Name, [Security.SecureString]$Password)
  [Console]::Out.WriteLine('FIXTURE_CALL=New-LocalUser')
  if ($Name -cne 'user1' -or -not $Password.IsReadOnly() -or $Password.Length -ne 24) { throw 'fixture credential contract failed' }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
  $bytes = $null
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
    $actual = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
    if ($actual -cne $env:FIXER_CREATE_PASSWORD_SHA256) { throw 'fixture secure credential differs' }
    if ($script:mode -eq 'secret-error') { throw $plain }
  } finally {
    $plain = $null
    if ($null -ne $bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
    $hash.Dispose()
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  if ($script:mode -eq 'create-error') { throw 'fixture account creation failed' }
  $sidValue = if ($script:mode -eq 'invalid-sid') { [pscustomobject]@{Value='unverified'} }
    else { [Security.Principal.SecurityIdentifier]::new($script:sid) }
  $created = [pscustomobject]@{Name=$Name; SID=$sidValue; Enabled=($script:mode -ne 'disabled-created')}
  $script:users += $created
  if ($script:mode -eq 'duplicate-created') { return @($created,$created) }
  return $created
}
function Add-LocalGroupMember {
  [CmdletBinding()]param([Security.Principal.SecurityIdentifier]$SID, [Security.Principal.SecurityIdentifier[]]$Member)
  [Console]::Out.WriteLine('FIXTURE_CALL=Add-LocalGroupMember')
  if ($SID.Value -cne 'S-1-5-32-545' -or $Member.Count -ne 1 -or $Member[0].Value -cne $script:sid) { throw 'fixture group identity differs' }
  if ($script:mode -eq 'add-error') { throw 'fixture membership failed' }
  $script:added = $true
}
function Get-LocalGroupMember {
  [CmdletBinding()]param([Security.Principal.SecurityIdentifier]$SID)
  if ($SID.Value -eq 'S-1-5-32-545') {
    if ($script:mode -eq 'users-unreadable') { return [pscustomobject]@{SID=$null} }
    if ($script:mode -eq 'users-missing') { return @() }
    if ($script:added -or $script:mode -eq 'already-users') {
      $member = [pscustomobject]@{SID=[Security.Principal.SecurityIdentifier]::new($script:sid)}
      if ($script:mode -eq 'duplicate-membership') { return @($member,$member) }
      return $member
    }
    return @()
  }
  if ($SID.Value -ne 'S-1-5-32-544') { throw 'fixture received non-target group' }
  if ($script:mode -eq 'admin-error') { throw 'fixture administrators unreadable' }
  if ($script:mode -eq 'admin-unreadable') { return [pscustomobject]@{SID=$null} }
  if ($script:mode -eq 'admin-member') { return [pscustomobject]@{SID=[Security.Principal.SecurityIdentifier]::new($script:sid)} }
  return @()
}
$exports = @('Get-LocalUser','Add-LocalGroupMember','Get-LocalGroupMember')
if ($script:mode -ne 'missing-command') { $exports += 'New-LocalUser' }
Export-ModuleMember -Function $exports
`;

async function main() {
  const password = generateHelperPassword();
  const script = profileSafety.accountCreateScript('user1', password);
  check(!/net\.exe|Start-Process|Process\]::Start/.test(script), 'production account-create script has no native descendant or plaintext-password fallback');
  check(script.includes("(Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.LocalAccounts')"),
    'production module root remains the trusted inbox PowerShell directory');
  check(script.includes('ExportedCommands[$name]') && script.includes('$command.Module.ModuleBase'),
    'every account/group command is bound to the imported manifest identity');
  check(!profileSafety.argvContainsSecret(process.argv, [password]), 'Node test argv carries no generated fixture credential');

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = mainSource.indexOf('async function runPSScript(');
  const end = mainSource.indexOf('\n}\n', start);
  check(start >= 0 && end > start, 'actual production stdin transport is available');
  const spawned = [];
  const transport = vm.createContext({ windowsTools, runProcess: async (...args) => { spawned.push(args); return { code: 0 }; } });
  vm.runInContext(mainSource.slice(start, end + 2), transport);
  await transport.runPSScript(script, () => {}, { timeoutMs: 60000 });
  check(spawned.length === 1 && spawned[0][0] === 'powershell.exe' &&
    !profileSafety.argvContainsSecret(Array.from(spawned[0][1]), [password]) &&
    spawned[0][3].stdin.endsWith(script) && spawned[0][3].stdin.includes(password),
  'actual production spawn carries the credential only through stdin, never child argv');

  if (process.platform !== 'win32') {
    console.log('helper-account-create-smoke: native synthetic-module checks NOT RUN (Windows PowerShell 7 required)');
    console.log(`helper-account-create-smoke: ${checks} Node checks passed`);
    return;
  }
  const exe = nativePowerShell7();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-account-create-'));
  const trustedRoot = path.join(fixtureRoot, 'trusted');
  const versionRoot = path.join(trustedRoot, '1.0.0.0');
  const manifestName = 'Microsoft.PowerShell.LocalAccounts.psd1';
  const manifest = "@{RootModule='Microsoft.PowerShell.LocalAccounts.psm1';ModuleVersion='1.0.0';GUID='45bcbb91-0905-4bdd-8cf9-fc7fa71e6729';FunctionsToExport=@('Get-LocalUser','New-LocalUser','Add-LocalGroupMember','Get-LocalGroupMember');CmdletsToExport=@();AliasesToExport=@();VariablesToExport=@()}";
  try {
    check(fs.realpathSync(fixtureRoot) === path.resolve(fixtureRoot), 'synthetic-module fixture is an owned physical directory');
    fs.mkdirSync(versionRoot, { recursive: true });
    fs.writeFileSync(path.join(versionRoot, manifestName), manifest);
    fs.writeFileSync(path.join(versionRoot, 'Microsoft.PowerShell.LocalAccounts.psm1'), moduleSource);
    function execute(mode, root = trustedRoot) {
      const fixtureScript = profileSafety.accountCreateScript('user1', password, root);
      const prefix = String.raw`
$ErrorActionPreference = 'Stop'
if ([Environment]::CommandLine.Contains(${profileSafety.psSingleQuote(password)})) { throw 'fixture credential appeared in argv' }
function global:Resolve-FixerTool { throw 'native child invocation is forbidden in this fixture' }
function global:Start-Process { throw 'native child invocation is forbidden in this fixture' }
function global:New-LocalUser { throw 'ambient account command is forbidden in this fixture' }
function global:Add-LocalGroupMember { throw 'ambient group command is forbidden in this fixture' }
$fixtureBody = ${profileSafety.psSingleQuote(fixtureScript)}
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($fixtureBody, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'account-create script did not parse' }
foreach ($commandAst in $ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]}, $true)) {
  $name = $commandAst.GetCommandName()
  if ($null -ne $name) {
    if ($name -notin @('Join-Path','Where-Object','Import-Module','Out-Null','Write-Output')) { throw 'unapproved static account-create command' }
  } elseif ($commandAst.CommandElements[0].Extent.Text -notin @('$getUser','$newUser','$addMember','$getMembers')) {
    throw 'unapproved dynamic account-create command'
  }
}
[Console]::Out.WriteLine('FIXTURE_AST=NO_NATIVE_CHILD')
& ([ScriptBlock]::Create($fixtureBody))
`;
      const result = spawnSync(exe, NATIVE_PS_STDIN_ARGS, {
        input: prepareNativeScript(prefix), encoding: 'utf8', windowsHide: true,
        timeout: 20000, maxBuffer: 1024 * 1024,
        env: { ...process.env, FIXER_CREATE_SCENARIO: mode,
          FIXER_CREATE_PASSWORD_SHA256: crypto.createHash('sha256').update(password).digest('hex') }
      });
      check(!result.error && result.signal === null, `${mode}: original PowerShell process completes within its bound`);
      check(!String(result.stdout || '').includes(password) && !String(result.stderr || '').includes(password),
        `${mode}: no fixture credential is printed, including failures`);
      check(String(result.stdout || '').includes('FIXTURE_AST=NO_NATIVE_CHILD'),
        `${mode}: production PowerShell AST permits only trusted-module commands and no native child`);
      return { status: result.status, text: String(result.stdout || '') };
    }
    for (const [mode, expected, creates, adds] of [
      ['valid',0,1,1], ['already-users',0,1,0], ['existing',1,0,0], ['duplicate-existing',1,0,0],
      ['create-error',1,1,0], ['secret-error',1,1,0], ['duplicate-created',1,1,0], ['invalid-sid',1,1,0],
      ['sid-collision',1,1,0], ['disabled-created',1,1,0], ['replacement-before-groups',1,1,0],
      ['replacement-after-groups',1,1,1], ['add-error',1,1,1], ['users-missing',1,1,1], ['users-unreadable',1,1,0],
      ['duplicate-membership',1,1,1], ['admin-member',1,1,1], ['admin-error',1,1,1],
      ['admin-unreadable',1,1,1], ['missing-command',1,0,0]
    ]) {
      const result = execute(mode);
      check(result.status === expected && (result.text.match(/FIXTURE_CALL=New-LocalUser/g) || []).length === creates &&
        (result.text.match(/FIXTURE_CALL=Add-LocalGroupMember/g) || []).length === adds,
      `${mode}: only the admitted exact-identity synthetic operations execute`);
      check(expected === 0 ? result.text.includes('ACCOUNT_CREATE=OK') :
        result.text.includes('ACCOUNT_CREATE=FAILED') && !result.text.includes('ACCOUNT_CREATE=OK') &&
        result.text.includes('partial changes may remain'), `${mode}: success or partial-failure outcome is truthful`);
    }
    const unavailable = execute('missing-module', path.join(fixtureRoot, 'absent'));
    check(unavailable.status === 1 && !unavailable.text.includes('FIXTURE_CALL='), 'missing trusted module fails before any synthetic account/group operation');
    const otherVersion = path.join(trustedRoot, '2.0.0.0');
    fs.mkdirSync(otherVersion);
    fs.writeFileSync(path.join(otherVersion, manifestName), manifest);
    const ambiguous = execute('ambiguous-module');
    check(ambiguous.status === 1 && !ambiguous.text.includes('FIXTURE_CALL='), 'ambiguous trusted module fails before account/group operations');
  } finally {
    assert.equal(fs.realpathSync(fixtureRoot), path.resolve(fixtureRoot), 'cleanup retains the original physical fixture root');
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(fixtureRoot), false, 'owned synthetic-module fixture is removed');
  }
  console.log(`helper-account-create-smoke: all ${checks} checks passed; real account/group operations: 0`);
}

main().catch(() => {
  // Do not print assertion payloads or PowerShell output that might contain
  // a generated credential if a regression defeats the producer's guard.
  console.error('helper-account-create-smoke: FAILED; no fixture credentials or raw child output printed');
  process.exitCode = 1;
});
