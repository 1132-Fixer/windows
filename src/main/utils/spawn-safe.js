/**
 * 1132 Remover - Safe Process Spawning
 * Wrapper around child_process.spawn with timeout and error handling
 */

const { spawn } = require('child_process');

/**
 * Spawn a process with timeout and proper error handling
 * @param {string} command - The command to run
 * @param {string[]} args - Command arguments
 * @param {Object} options - Options
 * @param {number} options.timeout - Timeout in ms (default: 30000)
 * @param {boolean} options.windowsHide - Hide window (default: true)
 * @param {boolean} options.shell - Use shell (default: false)
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
function spawnSafe(command, args = [], options = {}) {
  const timeout = options.timeout || 30000;
  const windowsHide = options.windowsHide !== false;
  const shell = options.shell || false;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(command, args, {
      windowsHide,
      shell,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    // Capture stdout
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    // Capture stderr
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    // Process completed
    proc.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`Timeout after ${timeout}ms: ${command} ${args.join(' ')}`));
        return;
      }

      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        success: code === 0
      });
    });

    // Process error (e.g., command not found)
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });
  });
}

/**
 * Run a PowerShell command with timeout
 * Uses stdin to avoid escaping issues with complex scripts
 * @param {string} script - PowerShell script to run
 * @param {Object} options - Options
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function runPowerShell(script, options = {}) {
  const timeout = options.timeout || 30000; // Reduced default timeout
  const rejectOnError = options.rejectOnError !== false;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', '-'  // Read from stdin
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    // Capture stdout
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    // Capture stderr
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Write script to stdin and close
    proc.stdin.write(script);
    proc.stdin.end();

    // Process completed
    proc.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`PowerShell timeout after ${timeout}ms`));
        return;
      }

      const result = {
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        success: code === 0
      };

      // Reject on non-zero exit code if option enabled
      if (rejectOnError && code !== 0) {
        const error = new Error(`PowerShell failed (exit ${code}): ${stderr || stdout || 'No output'}`);
        error.result = result;
        reject(error);
        return;
      }

      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn PowerShell: ${err.message}`));
    });
  });
}

/**
 * Run a command and return true if exit code is 0
 * @param {string} command - Command to run
 * @param {string[]} args - Arguments
 * @param {Object} options - Options
 * @returns {Promise<boolean>}
 */
async function runCommand(command, args = [], options = {}) {
  try {
    const result = await spawnSafe(command, args, options);
    return result.exitCode === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Check if a process is running (FAST - uses tasklist instead of PowerShell)
 * @param {string} processName - Process name (without .exe)
 * @returns {Promise<boolean>}
 */
async function isProcessRunning(processName) {
  try {
    // tasklist is MUCH faster than PowerShell Get-Process
    const result = await spawnSafe('tasklist', ['/FI', `IMAGENAME eq ${processName}.exe`, '/NH'], {
      timeout: 3000
    });
    const output = result.stdout || '';
    return output.toLowerCase().includes(processName.toLowerCase());
  } catch (e) {
    return false;
  }
}

/**
 * Check if a registry key exists
 * @param {string} keyPath - Registry key path (e.g., "HKCU\\Software\\Zoom")
 * @returns {Promise<boolean>}
 */
async function registryKeyExists(keyPath) {
  try {
    const result = await spawnSafe('reg', ['query', keyPath], { timeout: 5000 });
    return result.exitCode === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Delete a registry key
 * Handles DENY ACLs (from previous postInstallScrub runs) by removing them first
 * @param {string} keyPath - Registry key path
 * @returns {Promise<{success: boolean, existed: boolean}>}
 */
async function deleteRegistryKey(keyPath) {
  const existed = await registryKeyExists(keyPath);

  if (!existed) {
    return { success: true, existed: false };
  }

  try {
    // Attempt 1: Plain reg delete
    await spawnSafe('reg', ['delete', keyPath, '/f'], { timeout: 10000 });
    const gone = !(await registryKeyExists(keyPath));
    if (gone) return { success: true, existed: true, deleted: true };

    // Attempt 2: Remove DENY ACLs (from previous fixer runs) then retry
    // Convert reg path to PowerShell path format (HKCU\\ -> HKCU:\\ etc.)
    const psPath = keyPath.replace(/^(HKCU|HKLM|HKCR)\\/, '$1:\\');
    await runPowerShell(`
      $path = '${psPath.replace(/'/g, "''")}'
      if (Test-Path $path) {
        try {
          $acl = Get-Acl $path
          $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
          # Remove all Deny rules for current user
          $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
            $acl.RemoveAccessRule($_) | Out-Null
          }
          Set-Acl $path $acl -ErrorAction SilentlyContinue
        } catch {}
        # Also do it recursively for subkeys
        Get-ChildItem $path -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
          try {
            $subAcl = Get-Acl $_.PSPath
            $subAcl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
              $subAcl.RemoveAccessRule($_) | Out-Null
            }
            Set-Acl $_.PSPath $subAcl -ErrorAction SilentlyContinue
          } catch {}
        }
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
      }
    `, { timeout: 15000 }).catch(() => {});

    // Also retry with reg.exe
    await spawnSafe('reg', ['delete', keyPath, '/f'], { timeout: 5000 }).catch(() => {});
    let stillExists = await registryKeyExists(keyPath);
    if (!stillExists) return { success: true, existed: true, deleted: true };

    // Attempt 3: .NET TakeOwnership privilege escalation (for Everyone DENY ACLs)
    // The DENY covers ReadPermissions so Get-Acl fails. Must bypass DACL entirely.
    const isHKLM = keyPath.startsWith('HKLM\\');
    const subKeyPath = keyPath.replace(/^(HKCU|HKLM)\\/, '');
    const hive = isHKLM ? 'LocalMachine' : 'CurrentUser';
    await runPowerShell(`
      $privType = @'
using System; using System.Runtime.InteropServices;
public class DelPriv {
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool AdjustTokenPrivileges(IntPtr h, bool d, ref TP n, int b, IntPtr p, IntPtr r);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Auto)]
    static extern bool LookupPrivilegeValue(string s, string n, out LUID l);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [StructLayout(LayoutKind.Sequential)] public struct TP { public uint C; public LUID L; public uint A; }
    [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Lo; public int Hi; }
    public static void Enable(string p) {
        IntPtr t; OpenProcessToken(GetCurrentProcess(), 0x28, out t);
        TP tp; tp.C = 1; tp.A = 2; LookupPrivilegeValue(null, p, out tp.L);
        AdjustTokenPrivileges(t, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    }
}
'@
      try { Add-Type $privType -EA SilentlyContinue } catch {}
      try { [DelPriv]::Enable('SeTakeOwnershipPrivilege') } catch {}
      try { [DelPriv]::Enable('SeRestorePrivilege') } catch {}
      $adminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
      $subKeyPath = '${subKeyPath.replace(/'/g, "''").replace(/\\/g, '\\\\')}'
      try {
        $key = [Microsoft.Win32.Registry]::${hive}.OpenSubKey($subKeyPath,
          [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
          [System.Security.AccessControl.RegistryRights]::TakeOwnership)
        if ($key) {
          $acl = $key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::None)
          $acl.SetOwner($adminSid)
          $key.SetAccessControl($acl)
          $key.Close()
          $key = [Microsoft.Win32.Registry]::${hive}.OpenSubKey($subKeyPath,
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
            [System.Security.AccessControl.RegistryRights]::ChangePermissions)
          if ($key) {
            $acl = $key.GetAccessControl()
            $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
              $acl.RemoveAccessRule($_) | Out-Null
            }
            $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule(
              $adminSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
            $key.SetAccessControl($acl)
            $key.Close()
          }
        }
      } catch {}
      $psPath = '${psPath.replace(/'/g, "''")}'
      Remove-Item $psPath -Recurse -Force -EA SilentlyContinue
    `, { timeout: 20000 }).catch(() => {});

    await spawnSafe('reg', ['delete', keyPath, '/f'], { timeout: 5000 }).catch(() => {});
    stillExists = await registryKeyExists(keyPath);

    return {
      success: !stillExists,
      existed: true,
      deleted: !stillExists
    };
  } catch (e) {
    return { success: false, existed: true, error: e.message };
  }
}

/**
 * Delete a registry value
 * @param {string} keyPath - Registry key path
 * @param {string} valueName - Value name to delete
 * @returns {Promise<{success: boolean}>}
 */
async function deleteRegistryValue(keyPath, valueName) {
  try {
    const result = await spawnSafe('reg', ['delete', keyPath, '/v', valueName, '/f'], { timeout: 5000 });
    return { success: result.exitCode === 0 };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  spawnSafe,
  runPowerShell,
  runCommand,
  isProcessRunning,
  registryKeyExists,
  deleteRegistryKey,
  deleteRegistryValue
};
