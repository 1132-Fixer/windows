/**
 * 1132 Remover - Preset Profiles
 * Predefined Zoom settings configurations
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const APPDATA = process.env.APPDATA;

/**
 * Zoom preferences file location
 */
const ZOOM_PREFS_PATH = path.join(APPDATA, 'Zoom', 'data', 'zoom.us.ini');

/**
 * Preset profiles for common use cases
 */
const PRESETS = {
  'quiet-meetings': {
    name: 'Quiet Meetings',
    description: 'Mute on join, no video, minimal notifications',
    settings: {
      'Audio': {
        'audioautoadjust': '0',
        'autoMuteWhenJoin': '1',
        'echoCancellation': '1'
      },
      'Video': {
        'autoTurnOffVideo': '1',
        'enableHDVideo': '0'
      },
      'General': {
        'showToast': '0',
        'PlaySoundForIM': '0'
      }
    }
  },

  'studio-audio': {
    name: 'Studio Audio',
    description: 'High quality audio for podcasting/streaming',
    settings: {
      'Audio': {
        'audioautoadjust': '0',
        'enableOriginalSound': '1',
        'enableStereoAudio': '1',
        'disableEchoCancelation': '1',
        'disableNoiseReduction': '1',
        'highFidelityMusic': '1',
        'autoMuteWhenJoin': '0'
      }
    }
  },

  'low-bandwidth': {
    name: 'Low Bandwidth',
    description: 'Optimized for slow/limited internet connections',
    settings: {
      'Video': {
        'autoTurnOffVideo': '1',
        'enableHDVideo': '0',
        'enableGalleryViewVideoOptimization': '1'
      },
      'General': {
        'enableCaptureVideo720P': '0'
      }
    }
  },

  'presentation': {
    name: 'Presentation Mode',
    description: 'Optimized for screen sharing and presentations',
    settings: {
      'Video': {
        'enableHDVideo': '1',
        'autoTurnOffVideo': '0'
      },
      'ShareScreen': {
        'shareSelectWin': '1',
        'enableShareSound': '1',
        'enableOptimizeForVideoClip': '1'
      },
      'General': {
        'showToast': '0'
      }
    }
  },

  'privacy': {
    name: 'Privacy Focused',
    description: 'Maximum privacy settings',
    settings: {
      'Video': {
        'autoTurnOffVideo': '1',
        'enableVirtualBackground': '0'
      },
      'General': {
        'enableAlwaysShowMeetingControl': '1',
        'showToast': '0',
        'enableSyncZoomClientService': '0'
      },
      'Chat': {
        'enableChatHistoryInMeeting': '0'
      }
    }
  }
};

/**
 * Read current Zoom preferences
 * @returns {Object} Current settings by section
 */
function readZoomPrefs() {
  if (!fs.existsSync(ZOOM_PREFS_PATH)) {
    logger.debug('Zoom preferences file not found');
    return null;
  }

  const content = fs.readFileSync(ZOOM_PREFS_PATH, 'utf-8');
  const sections = {};
  let currentSection = 'General';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Section header
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1);
      if (!sections[currentSection]) {
        sections[currentSection] = {};
      }
      continue;
    }

    // Key=Value
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex);
      const value = trimmed.substring(eqIndex + 1);
      if (!sections[currentSection]) {
        sections[currentSection] = {};
      }
      sections[currentSection][key] = value;
    }
  }

  return sections;
}

/**
 * Write Zoom preferences
 * @param {Object} sections - Settings by section
 */
function writeZoomPrefs(sections) {
  const dir = path.dirname(ZOOM_PREFS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let content = '';
  for (const [section, settings] of Object.entries(sections)) {
    content += `[${section}]\n`;
    for (const [key, value] of Object.entries(settings)) {
      content += `${key}=${value}\n`;
    }
    content += '\n';
  }

  fs.writeFileSync(ZOOM_PREFS_PATH, content);
}

/**
 * Apply a preset profile
 * @param {string} presetId - Preset ID (e.g., 'quiet-meetings')
 * @returns {{success: boolean, applied: string[]}}
 */
function applyPreset(presetId) {
  const preset = PRESETS[presetId];
  if (!preset) {
    logger.error('Unknown preset:', presetId);
    return { success: false, error: `Unknown preset: ${presetId}` };
  }

  logger.section(`Applying Preset: ${preset.name}`);
  logger.info('Description:', preset.description);

  // Read current settings
  let currentSettings = readZoomPrefs() || {};
  const appliedSettings = [];

  // Merge preset settings
  for (const [section, settings] of Object.entries(preset.settings)) {
    if (!currentSettings[section]) {
      currentSettings[section] = {};
    }
    for (const [key, value] of Object.entries(settings)) {
      currentSettings[section][key] = value;
      appliedSettings.push(`${section}.${key}=${value}`);
      logger.debug(`Set ${section}.${key} = ${value}`);
    }
  }

  // Write updated settings
  try {
    writeZoomPrefs(currentSettings);
    logger.ok(`Preset "${preset.name}" applied successfully`);
    return { success: true, applied: appliedSettings };
  } catch (e) {
    logger.error('Failed to write preferences:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * List all available presets
 * @returns {Object[]} List of preset info
 */
function listPresets() {
  return Object.entries(PRESETS).map(([id, preset]) => ({
    id,
    name: preset.name,
    description: preset.description
  }));
}

/**
 * Get details of a specific preset
 * @param {string} presetId - Preset ID
 * @returns {Object|null} Preset details or null
 */
function getPreset(presetId) {
  const preset = PRESETS[presetId];
  if (!preset) return null;
  return {
    id: presetId,
    ...preset
  };
}

/**
 * Export current Zoom settings as a custom preset
 * @param {string} name - Name for the preset
 * @returns {{success: boolean, preset?: Object}}
 */
function exportCurrentAsPreset(name) {
  const current = readZoomPrefs();
  if (!current) {
    return { success: false, error: 'Could not read current Zoom settings' };
  }

  const preset = {
    name,
    description: `Exported from current settings on ${new Date().toISOString()}`,
    settings: current
  };

  return { success: true, preset };
}

module.exports = {
  PRESETS,
  ZOOM_PREFS_PATH,
  readZoomPrefs,
  writeZoomPrefs,
  applyPreset,
  listPresets,
  getPreset,
  exportCurrentAsPreset
};
