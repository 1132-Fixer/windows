/**
 * Zoom Settings Restore via Registry Policies
 *
 * Uses Zoom's official Group Policy registry path to enforce user
 * settings after reinstall. These policies are read by Zoom on
 * every launch and override client-side defaults.
 *
 * Path: HKLM\SOFTWARE\Policies\Zoom\Zoom Meetings\{subkey}
 *
 * The purge deletes this registry path, so policies are re-written
 * AFTER reinstall during the post-install hardening phase.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { runPowerShell } = require('../utils/spawn-safe');

const APPDATA = process.env.APPDATA;
const ZOOM_DATA_DIR = path.join(APPDATA, 'Zoom', 'data');

/**
 * All Zoom settings to enforce via registry policies.
 * Grouped by registry sub-key under HKLM\SOFTWARE\Policies\Zoom\Zoom Meetings\
 *
 * Source: Zoom ADMX Group Policy template (KB0065466, KB0064484)
 */
const ZOOM_POLICIES = {
  // HKLM\SOFTWARE\Policies\Zoom\Zoom Meetings\Meetings
  Meetings: {
    // Audio
    MuteVoIPWhenJoinMeeting: 1,       // Mute mic on join
    AudioAutoAdjust: 1,                // Auto-adjust mic volume
    EnableOriginalSound: 1,            // Original sound (enables hi-fi, stereo, echo sub-toggles)
    SetUseSystemDefaultSpeakerForVOIP: 1, // Use Windows default speaker
    SetUseSystemDefaultMicForVOIP: 1,     // Use Windows default mic

    // Video
    EnableMirrorEffect: 0,             // Mirror video preview OFF
    AutoEnableDualMonitor: 0,          // Dual monitors OFF
    DisableReceiveVideo: 1,            // Stop incoming video

    // Meeting behavior
    EnterFullScreenWhenJoinMeeting: 0, // No auto fullscreen
    AlwaysShowMeetingControls: 1,      // Keep controls visible
    AlwaysShowConnectedTime: 1,        // Show meeting timer
  },

  // HKLM\SOFTWARE\Policies\Zoom\Zoom Meetings\General
  General: {
    // Hardware acceleration
    EnableHardwareAccForVideoSend: 1,
    EnableHardwareAccForVideoReceive: 1,
    EnableGPUComputeUtilization: 1,    // HW accel for video processing
  },

  // HKLM\SOFTWARE\Policies\Zoom\Zoom Meetings\AU2
  AU2: {
    AU2_EnableAutoUpdate: 0,           // Disable auto-update
  }
};

/**
 * Write Zoom.us.ini settings that aren't covered by registry policies.
 * These are written directly to the INI file after Zoom creates it.
 */
const INI_SETTINGS = {
  'com.zoom.client.theme.mode': '2',           // Dark mode
  'com.disable.connection.pk.status': 'false',  // Outlook sync OFF
};

/**
 * Apply all Zoom registry policies via PowerShell
 * @returns {Promise<{success: boolean, policiesSet: number}>}
 */
async function restoreZoomSettings() {
  logger.info('Applying Zoom settings via registry policies...');

  let totalSet = 0;

  try {
    // Build PowerShell script to set all policies
    const lines = ['$count = 0'];

    for (const [subkey, values] of Object.entries(ZOOM_POLICIES)) {
      const regPath = `HKLM:\\SOFTWARE\\Policies\\Zoom\\Zoom Meetings\\${subkey}`;
      lines.push(`New-Item -Path '${regPath}' -Force -ErrorAction SilentlyContinue | Out-Null`);

      for (const [name, value] of Object.entries(values)) {
        lines.push(
          `New-ItemProperty -Path '${regPath}' -Name '${name}' -PropertyType DWord -Value ${value} -Force -ErrorAction SilentlyContinue | Out-Null`,
          '$count++'
        );
      }
    }

    lines.push('Write-Output $count');

    const result = await runPowerShell(lines.join('\n'), { timeout: 15000 });
    totalSet = parseInt(result.stdout, 10) || 0;

    logger.ok(`Registry policies set: ${totalSet}`);

    // Also write INI settings
    const iniResult = writeIniSettings();
    if (iniResult.written > 0) {
      logger.ok(`INI settings written: ${iniResult.written}`);
    }

    return {
      success: true,
      policiesSet: totalSet,
      iniWritten: iniResult.written
    };
  } catch (e) {
    logger.error('Failed to apply Zoom settings', { error: e.message });
    return { success: false, error: e.message, policiesSet: totalSet };
  }
}

/**
 * Write settings to Zoom.us.ini for things not covered by policies
 * @returns {{written: number}}
 */
function writeIniSettings() {
  let written = 0;

  const iniPath = path.join(ZOOM_DATA_DIR, 'Zoom.us.ini');

  // Read existing INI or start fresh
  let content = '';
  if (fs.existsSync(iniPath)) {
    content = fs.readFileSync(iniPath, 'utf-8');
  } else {
    // Ensure directory exists
    if (!fs.existsSync(ZOOM_DATA_DIR)) {
      fs.mkdirSync(ZOOM_DATA_DIR, { recursive: true });
    }
    content = '[ZoomChat]\n';
  }

  for (const [key, value] of Object.entries(INI_SETTINGS)) {
    const regex = new RegExp(`^${key.replace(/\./g, '\\.')}=.*$`, 'm');
    const line = `${key}=${value}`;

    if (regex.test(content)) {
      // Update existing key
      content = content.replace(regex, line);
    } else {
      // Add under [ZoomChat] section
      const sectionEnd = content.indexOf('\n[', content.indexOf('[ZoomChat]') + 1);
      if (sectionEnd !== -1) {
        content = content.slice(0, sectionEnd) + '\n' + line + content.slice(sectionEnd);
      } else {
        content = content.trimEnd() + '\n' + line + '\n';
      }
    }
    written++;
  }

  try {
    fs.writeFileSync(iniPath, content);
    logger.debug(`INI written: ${iniPath}`);
  } catch (e) {
    logger.debug(`Failed to write INI: ${e.message}`);
    written = 0;
  }

  return { written };
}

/**
 * Save is now a no-op — policies are defined in code, not backed up from files.
 * Kept for API compatibility with the reset flow.
 */
function saveZoomSettings() {
  logger.debug('Settings save: using registry policies (no file backup needed)');
  return { success: true, method: 'registry-policies' };
}

/**
 * Check if policies are defined (always true now)
 */
function hasBackup() {
  return true;
}

function clearBackup() {
  // No-op — policies are code-defined
}

module.exports = {
  saveZoomSettings,
  restoreZoomSettings,
  hasBackup,
  clearBackup
};
