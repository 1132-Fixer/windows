'use strict';

// Elevation can use a different administrator account in the signed-in user's
// session. Resolve that session's user, not the physical console or environment.
// No names leave the probe, and an unavailable or changing identity blocks work.
const OPERATOR_IDENTITY_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class FixerOperatorIdentityV1 {
    [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Query(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);

    [DllImport("wtsapi32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern void WTSFreeMemory(IntPtr buffer);

    private static string ReadField(int session, int infoClass) {
        IntPtr buffer = IntPtr.Zero;
        int bytes = 0;
        try {
            if (!Query(IntPtr.Zero, session, infoClass, out buffer, out bytes) ||
                buffer == IntPtr.Zero || bytes < 4 || bytes > 1026 || bytes % 2 != 0) {
                throw new InvalidOperationException();
            }
            string value = Marshal.PtrToStringUni(buffer, bytes / 2);
            if (value == null || value[value.Length - 1] != '\0' ||
                value.IndexOf('\0') != value.Length - 1) throw new InvalidOperationException();
            value = value.Substring(0, value.Length - 1);
            if (String.IsNullOrWhiteSpace(value) || value != value.Trim() || value.IndexOf('\\') >= 0) {
                throw new InvalidOperationException();
            }
            foreach (char c in value) if (Char.IsControl(c)) throw new InvalidOperationException();
            return value;
        } finally {
            if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
        }
    }

    public static string ReadReceipt() {
        using (Process process = Process.GetCurrentProcess()) {
            int session = process.SessionId;
            if (session <= 0) throw new InvalidOperationException();
            string user = ReadField(session, 5); // WTSUserName
            string domain = ReadField(session, 7); // WTSDomainName
            using (WindowsIdentity token = WindowsIdentity.GetCurrent()) {
                if (token.User == null) throw new InvalidOperationException();
                SecurityIdentifier sessionUser = (SecurityIdentifier)new NTAccount(domain, user)
                    .Translate(typeof(SecurityIdentifier));
                if (process.SessionId != session ||
                    !String.Equals(user, ReadField(session, 5), StringComparison.Ordinal) ||
                    !String.Equals(domain, ReadField(session, 7), StringComparison.Ordinal)) {
                    throw new InvalidOperationException();
                }
                return "FIXER_OPERATOR_IDENTITY_V1|" + session.ToString(CultureInfo.InvariantCulture) +
                    "|" + token.User.Value + "|" + sessionUser.Value;
            }
        }
    }
}
'@ -ErrorAction Stop
    Write-Output ([FixerOperatorIdentityV1]::ReadReceipt())
} catch {
    Write-Output 'FIXER_OPERATOR_IDENTITY_V1=UNVERIFIED'
    exit 1
}
`;

function isUserSid(value) {
  if (typeof value !== 'string' ||
      !/^S-1-(?:5-21-\d+-\d+-\d+-\d+|12-1-\d+-\d+-\d+-\d+)$/.test(value)) return false;
  return value.split('-').slice(2).every(part =>
    /^(?:0|[1-9]\d{0,9})$/.test(part) && Number(part) <= 0xffffffff);
}

function helperSidOption(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const helperSid = options.helperSid === undefined ? '' : options.helperSid;
  return helperSid === '' || isUserSid(helperSid) ? helperSid : null;
}

function validateOperatorIdentity(result, options = {}) {
  const fail = code => ({ ok: false, code });
  const helperSid = helperSidOption(options);
  if (helperSid === null || !result || result.code !== 0 || result.timedOut !== false ||
      typeof result.stdout !== 'string' || result.stdout.length > 512 || result.stderr !== '') {
    return fail('operator_identity_unverified');
  }
  const line = result.stdout.replace(/\r?\n$/, '');
  const match = /^FIXER_OPERATOR_IDENTITY_V1\|([1-9]\d{0,9})\|(S-1-[0-9-]+)\|(S-1-[0-9-]+)$/.exec(line);
  if (!match || match[0] !== line || Number(match[1]) > 0x7fffffff ||
      !isUserSid(match[2]) || !isUserSid(match[3])) return fail('operator_identity_unverified');
  if (helperSid && (match[2] === helperSid || match[3] === helperSid)) return fail('operator_is_helper');
  if (match[2] !== match[3]) return fail('operator_identity_mismatch');
  return { ok: true, code: null, sessionId: Number(match[1]), tokenSid: match[2], sessionUserSid: match[3] };
}

async function checkOperatorIdentity(runCapture, options = {}) {
  if (typeof runCapture !== 'function' || helperSidOption(options) === null) {
    return { ok: false, code: 'operator_identity_unverified' };
  }
  try {
    return validateOperatorIdentity(await runCapture(OPERATOR_IDENTITY_PROBE, { timeoutMs: 20000 }), options);
  } catch (_) {
    return { ok: false, code: 'operator_identity_unverified' };
  }
}

module.exports = { OPERATOR_IDENTITY_PROBE, validateOperatorIdentity, checkOperatorIdentity };
