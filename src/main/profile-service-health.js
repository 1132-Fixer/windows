'use strict';

// A helper-account repair must not stop services used by the operator's
// desktop. This probe only reads status. A timeout or missing result blocks
// the repair; it never triggers a service restart or a broader reset.
const PROFILE_SERVICE_PROBE = `
$ErrorActionPreference = 'Stop'
$services = @(Get-Service -Name ProfSvc, UserManager -ErrorAction Stop)
if ($services.Count -ne 2 -or @($services | Where-Object { $_.Status -ne 'Running' }).Count -gt 0) {
    Write-Output 'PROFILE_SERVICES=UNHEALTHY'
    exit 1
}
Write-Output 'PROFILE_SERVICES=RUNNING'
`;

async function checkProfileServiceHealth(runCapture) {
  let result;
  try {
    result = await runCapture(PROFILE_SERVICE_PROBE, { timeoutMs: 20000 });
  } catch (_) {
    return { ok: false, code: 'profile_service_probe_failed' };
  }
  if (!result || result.timedOut !== false) {
    return { ok: false, code: result ? 'profile_service_probe_timeout' : 'profile_service_probe_failed' };
  }
  if (result.code !== 0 || String(result.stdout || '').trim() !== 'PROFILE_SERVICES=RUNNING' ||
      String(result.stderr || '').trim() !== '') {
    return { ok: false, code: 'profile_services_unverified' };
  }
  return { ok: true, code: null };
}

module.exports = { PROFILE_SERVICE_PROBE, checkProfileServiceHealth };
