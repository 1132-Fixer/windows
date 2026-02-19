/**
 * Zoom Preference Options - Single Source of Truth
 * Defines all user-configurable Zoom preferences with labels, defaults, and choices
 */

const ZOOM_PREF_OPTIONS = {
  appearance: {
    darkMode: {
      label: 'Dark mode',
      description: 'Use dark theme in Zoom',
      default: true,
      type: 'boolean'
    }
  },

  audio: {
    muteOnJoin: {
      label: 'Mute mic on join',
      description: 'Automatically mute microphone when joining meetings',
      default: true,
      type: 'boolean'
    },
    autoMic: {
      label: 'Auto-adjust mic volume',
      description: 'Let Zoom automatically adjust microphone volume',
      default: false,
      type: 'boolean'
    },
    noiseSuppression: {
      label: 'Noise suppression',
      description: 'Background noise reduction level',
      default: 'high',
      type: 'choice',
      choices: [
        { value: 'off', label: 'Off' },
        { value: 'auto', label: 'Auto' },
        { value: 'high', label: 'High' }
      ]
    },
    originalSound: {
      label: 'Original sound',
      description: 'Enable original sound for musicians (disables processing)',
      default: false,
      type: 'boolean'
    },
    stereoAudio: {
      label: 'Stereo audio',
      description: 'Enable stereo audio (requires original sound)',
      default: false,
      type: 'boolean'
    }
  },

  video: {
    hd: {
      label: 'HD video',
      description: 'Enable high-definition video',
      default: true,
      type: 'boolean'
    },
    mirror: {
      label: 'Mirror my video',
      description: 'Mirror self-view (does not affect what others see)',
      default: false,
      type: 'boolean'
    },
    turnOffOnJoin: {
      label: 'Turn off video on join',
      description: 'Start meetings with video off',
      default: false,
      type: 'boolean'
    },
    virtualBackground: {
      label: 'Virtual background',
      description: 'Enable virtual background feature',
      default: true,
      type: 'boolean'
    }
  },

  general: {
    dualMonitor: {
      label: 'Dual monitor mode',
      description: 'Use dual monitor layout for meetings',
      default: false,
      type: 'boolean'
    },
    copyInviteLink: {
      label: 'Copy invite link on join',
      description: 'Automatically copy meeting link when starting',
      default: false,
      type: 'boolean'
    },
    showConnectedTime: {
      label: 'Show connected time',
      description: 'Display meeting duration in the interface',
      default: true,
      type: 'boolean'
    }
  },

  notifications: {
    playSound: {
      label: 'Play sound for notifications',
      description: 'Audio alerts for chat and other events',
      default: true,
      type: 'boolean'
    },
    showToast: {
      label: 'Show notification toasts',
      description: 'Display popup notifications',
      default: true,
      type: 'boolean'
    }
  }
};

/**
 * Get default preferences object from schema
 * @returns {Object} Default preferences
 */
function getDefaultPreferences() {
  const defaults = {};

  for (const [category, options] of Object.entries(ZOOM_PREF_OPTIONS)) {
    defaults[category] = {};
    for (const [key, config] of Object.entries(options)) {
      defaults[category][key] = config.default;
    }
  }

  return defaults;
}

/**
 * Validate preferences against schema
 * @param {Object} prefs - Preferences to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePreferences(prefs) {
  const errors = [];

  for (const [category, options] of Object.entries(ZOOM_PREF_OPTIONS)) {
    if (!prefs[category]) continue;

    for (const [key, config] of Object.entries(options)) {
      const value = prefs[category]?.[key];
      if (value === undefined) continue;

      if (config.type === 'boolean' && typeof value !== 'boolean') {
        errors.push(`${category}.${key} must be boolean`);
      }

      if (config.type === 'choice') {
        const validValues = config.choices.map(c => c.value);
        if (!validValues.includes(value)) {
          errors.push(`${category}.${key} must be one of: ${validValues.join(', ')}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ZOOM_PREF_OPTIONS,
  getDefaultPreferences,
  validatePreferences
};
