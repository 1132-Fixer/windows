'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PROFILE_UNLOADED_GUARD, checkHelperProfileIdle } = require('../src/main/helper-profile-idle');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const sid = 'S-1-5-21-100-200-300-1001';
const receipt = 'FIXER_PROFILE_IDLE_V1=' + sid;
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; }

(async () => {
  let calls = 0;
  check((await checkHelperProfileIdle(async () => { calls++; }, '')).ok && calls === 0,
    'verified missing local account needs no guessed SID probe');
  for (const identity of [undefined, null, {}, 7, 'user1', 'S-1-5-18', sid + "';exit 0;#", sid + '\n']) {
    const result = await checkHelperProfileIdle(async () => { calls++; }, identity);
    check(!result.ok && calls === 0, 'invalid or non-local SID never reaches PowerShell');
  }
  const healthy = { code: 0, timedOut: false, stdout: receipt + '\r\n', stderr: '' };
  check((await checkHelperProfileIdle(async (script, options) => {
    calls++;
    check(script.includes(PROFILE_UNLOADED_GUARD) && script.includes(`-Sid '${sid}'`),
      'the production guard receives the exact validated SID');
    check(options.timeoutMs === 20000, 'idle proof has a bounded deadline');
    return healthy;
  }, sid)).ok && calls === 1, 'fresh exact-SID receipt permits continuation');

  for (const result of [null, {}, { ...healthy, timedOut: true }, { ...healthy, timedOut: undefined },
    { ...healthy, code: 1 }, { ...healthy, stdout: '' }, { ...healthy, stdout: receipt + '\nUNKNOWN' },
    { ...healthy, stdout: 'FIXER_PROFILE_IDLE_V1=S-1-5-21-100-200-300-9999' },
    { ...healthy, stderr: 'Access denied' }]) {
    check(!(await checkHelperProfileIdle(async () => result, sid)).ok, 'unknown, failed or mismatched proof blocks');
  }
  check(!(await checkHelperProfileIdle(async () => { throw new Error('CIM unavailable'); }, sid)).ok,
    'probe exception blocks');
  check(PROFILE_UNLOADED_GUARD.includes('$profile.Loaded -isnot [bool]') &&
    PROFILE_UNLOADED_GUARD.includes('$profile.Special -isnot [bool]') &&
    PROFILE_UNLOADED_GUARD.includes('$profile.Loaded -or $profile.Special'),
  'loaded, special and unknown profile states are refused');
  check(PROFILE_UNLOADED_GUARD.includes('$operator.User.Value -ieq $Sid'), 'operator SID is never a cleanup target');
  check(PROFILE_UNLOADED_GUARD.includes("($Sid + '_Classes')") &&
    PROFILE_UNLOADED_GUARD.includes('Registry::HKEY_USERS'), 'both live profile hives must be absent');
  check(!/\b(?:reg\.exe|Remove-Item|Stop-Process|Stop-Service|Restart-Service|logoff|quser)\b/i.test(PROFILE_UNLOADED_GUARD),
    'idle proof has no mutation or edition-specific session-tool fallback');

  const entry = main.indexOf('async function runFixFlow');
  const idle = main.indexOf('const helperIdle = await checkHelperProfileIdle', entry);
  const terminate = main.indexOf('const drain = await runPSCapture', entry);
  check(idle > entry && idle < terminate, 'idle proof precedes process termination');
  check(!main.includes('function Unload-UserHive') && !main.includes('Unload-UserHive -Sid'),
    'teardown has no forced registry-hive unload');
  check(main.includes('Assert-FixerProfileUnloaded -Sid $expectedSid') &&
    main.indexOf('const accountDeleteIdle = await checkHelperProfileIdle', entry) <
      main.indexOf('const del = await runPSScript(exactSidLocalUserDeleteScript', entry),
  'profile mutations and account deletion recheck idle state');

  const messages = require('../messages');
  check(/Close Zoom/.test(messages.friendlyError('helper_profile_busy_or_unverified')),
    'busy-profile failure tells the user which application to close');
  for (const code of ['helper_profile_busy_or_unverified', 'helper_profile_identity_unverified',
    'profile_services_unverified', 'profile_service_probe_failed', 'profile_service_probe_timeout']) {
    const text = messages.friendlyError(code);
    check(/Support Report/.test(text) && !/Nothing (?:else )?was changed/i.test(text),
      'uncertain repair explains recovery without claiming that no earlier step changed state');
  }

  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    const { PS_STDIN_ARGS } = require('../src/main/windows-tools');
    const { nativePowerShell7, prepareNativeScript } = require('./native-powershell');
    const fixture = `${PROFILE_UNLOADED_GUARD}
      function Get-CimInstance {
        [CmdletBinding()] param([string]$ClassName, [string]$Filter)
        if ($script:fixtureThrow) { throw 'fixture query unavailable' }
        return $script:fixtureProfiles
      }
      function Test-Path {
        [CmdletBinding()] param([string]$LiteralPath)
        if ($script:fixtureHive -eq 'user') { return $LiteralPath.EndsWith('${sid}') }
        if ($script:fixtureHive -eq 'classes') { return $LiteralPath.EndsWith('_Classes') }
        return $false
      }
      $cases = @(
        @{ name='idle'; loaded=$false; special=$false; expected=$true },
        @{ name='loaded'; loaded=$true; special=$false; expected=$false },
        @{ name='unknown-loaded'; loaded=$null; special=$false; expected=$false },
        @{ name='string-loaded'; loaded='False'; special=$false; expected=$false },
        @{ name='special'; loaded=$false; special=$true; expected=$false },
        @{ name='unknown-special'; loaded=$false; special=$null; expected=$false },
        @{ name='user-hive'; loaded=$false; special=$false; hive='user'; expected=$false },
        @{ name='classes-hive'; loaded=$false; special=$false; hive='classes'; expected=$false },
        @{ name='query-failed'; loaded=$false; special=$false; fail=$true; expected=$false },
        @{ name='operator'; loaded=$false; special=$false; operator=$true; expected=$false }
      )
      $records = @()
      foreach ($case in $cases) {
        $script:fixtureThrow = [bool]$case.fail
        $script:fixtureHive = [string]$case.hive
        $script:fixtureProfiles = @([pscustomobject]@{ SID='${sid}'; Loaded=$case.loaded; Special=$case.special })
        $target = '${sid}'
        if ($case.operator) { $target = [string][System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
        $allowed = $false
        try { Assert-FixerProfileUnloaded -Sid $target; $allowed = $true } catch {}
        $records += [pscustomobject]@{ name=$case.name; allowed=$allowed; expected=$case.expected }
      }
      ConvertTo-Json -InputObject @($records) -Compress
    `;
    const run = spawnSync(nativePowerShell7(), PS_STDIN_ARGS, {
      input: prepareNativeScript(fixture), encoding: 'utf8', windowsHide: true, timeout: 20000
    });
    check(run.status === 0 && !run.error, 'PowerShell 7 evaluates the actual guard without touching real profiles');
    const records = JSON.parse(String(run.stdout || '').trim());
    check(records.length === 10, 'all native guard fixtures return evidence');
    for (const record of records) check(record.allowed === record.expected, 'native guard: ' + record.name);
  } else {
    console.log('helper-profile-idle-smoke: native PowerShell 7 guard fixtures not-run (non-Windows host)');
  }

  console.log(`helper-profile-idle-smoke: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
