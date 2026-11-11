'use strict';

// Read-only guard, shared by the initial probe and each destructive profile
// script. Windows Home does not need quser/logoff for this proof. Never try
// to make a loaded profile look idle by unloading its hive or killing its
// session. A busy or unknown profile requires a separate, safe recovery.
const PROFILE_UNLOADED_GUARD = String.raw`
function Assert-FixerProfileUnloaded {
    param([Parameter(Mandatory=$true)][string]$Sid)
    $ErrorActionPreference = 'Stop'
    if ($Sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'helper SID is invalid' }
    $operator = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        if ($null -eq $operator.User -or [string]$operator.User.Value -ieq $Sid) {
            throw 'the current operator cannot be a cleanup target'
        }
    } finally { if ($null -ne $operator) { $operator.Dispose() } }
    $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='" + $Sid + "'") -ErrorAction Stop)
    if ($profiles.Count -gt 1) { throw 'helper profile inventory is ambiguous' }
    foreach ($profile in $profiles) {
        if ([string]$profile.SID -ine $Sid -or $profile.Loaded -isnot [bool] -or
            $profile.Special -isnot [bool] -or $profile.Loaded -or $profile.Special) {
            throw 'helper profile is loaded, special, or unverified'
        }
    }
    foreach ($hive in @($Sid, ($Sid + '_Classes'))) {
        if (Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $hive) -ErrorAction Stop) {
            throw 'helper profile registry hive is still loaded'
        }
    }
}
`;

const LOCAL_SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;

async function checkHelperProfileIdle(runCapture, sid) {
  // The caller has independently proved that no old local helper exists.
  // With no SID the cleanup plan must stay empty; never guess one by name.
  if (sid === '') return { ok: true, code: null };
  if (typeof sid !== 'string' || !LOCAL_SID.test(sid)) {
    return { ok: false, code: 'helper_profile_identity_unverified' };
  }
  const receipt = `FIXER_PROFILE_IDLE_V1=${sid}`;
  try {
    const result = await runCapture(`${PROFILE_UNLOADED_GUARD}\nAssert-FixerProfileUnloaded -Sid '${sid}'\nWrite-Output '${receipt}'`,
      { timeoutMs: 20000 });
    if (result && result.code === 0 && result.timedOut === false &&
        String(result.stdout || '').trim() === receipt && String(result.stderr || '').trim() === '') {
      return { ok: true, code: null };
    }
  } catch (_) { /* unavailable proof blocks cleanup */ }
  return { ok: false, code: 'helper_profile_busy_or_unverified' };
}

module.exports = { PROFILE_UNLOADED_GUARD, checkHelperProfileIdle };
