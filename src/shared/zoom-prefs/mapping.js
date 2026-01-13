/**
 * Zoom Preference Mapping
 * Maps UI preferences to zoomus.conf keys
 */

/**
 * Map UI preferences to conf keys using template as base
 * @param {Object} ui - User preferences from UI
 * @param {Object} template - Version-specific template
 * @returns {Object} Config object ready to write
 */
function uiToConf(ui, template) {
  // Start with template defaults
  const conf = { ...template.conf };

  // Appearance
  if (ui.appearance) {
    if (ui.appearance.darkMode !== undefined) {
      conf.enableDarkMode = ui.appearance.darkMode ? '1' : '0';
    }
  }

  // Audio
  if (ui.audio) {
    if (ui.audio.muteOnJoin !== undefined) {
      conf.muteMicOnJoin = ui.audio.muteOnJoin ? '1' : '0';
    }

    if (ui.audio.autoMic !== undefined) {
      conf.audioAutomaticallyAdjustMicVolume = ui.audio.autoMic ? '1' : '0';
    }

    if (ui.audio.noiseSuppression !== undefined) {
      const ns = ui.audio.noiseSuppression;
      conf.audioNoiseSuppression = (ns === 'off') ? '0' : (ns === 'auto') ? '1' : '2';
    }

    if (ui.audio.originalSound !== undefined) {
      conf.audioEnableOriginalSound = ui.audio.originalSound ? '1' : '0';
      conf.audioHighQualityMusicMode = ui.audio.originalSound ? '1' : '0';
    }

    if (ui.audio.stereoAudio !== undefined) {
      conf.audioEnableStereo = ui.audio.stereoAudio ? '1' : '0';
    }
  }

  // Video
  if (ui.video) {
    if (ui.video.hd !== undefined) {
      conf.videoHD = ui.video.hd ? '1' : '0';
    }

    if (ui.video.mirror !== undefined) {
      conf.videoMirrorEffect = ui.video.mirror ? '1' : '0';
    }

    if (ui.video.turnOffOnJoin !== undefined) {
      conf.videoTurnOffOnJoin = ui.video.turnOffOnJoin ? '1' : '0';
    }

    if (ui.video.virtualBackground !== undefined) {
      conf.enableVirtualBackground = ui.video.virtualBackground ? '1' : '0';
    }
  }

  // General
  if (ui.general) {
    if (ui.general.dualMonitor !== undefined) {
      conf.enableDualMonitor = ui.general.dualMonitor ? '1' : '0';
    }

    if (ui.general.showConnectedTime !== undefined) {
      conf.showConnectedTime = ui.general.showConnectedTime ? '1' : '0';
    }
  }

  // Notifications
  if (ui.notifications) {
    if (ui.notifications.playSound !== undefined) {
      conf.PlaySoundForIM = ui.notifications.playSound ? '1' : '0';
    }

    if (ui.notifications.showToast !== undefined) {
      conf.showToast = ui.notifications.showToast ? '1' : '0';
    }
  }

  return conf;
}

/**
 * Map conf keys back to UI preferences
 * @param {Object} conf - Config object from zoomus.conf
 * @returns {Object} UI preferences object
 */
function confToUi(conf) {
  const ui = {
    appearance: {},
    audio: {},
    video: {},
    general: {},
    notifications: {}
  };

  // Appearance
  if (conf.enableDarkMode !== undefined) {
    ui.appearance.darkMode = conf.enableDarkMode === '1';
  }

  // Audio
  if (conf.muteMicOnJoin !== undefined) {
    ui.audio.muteOnJoin = conf.muteMicOnJoin === '1';
  }
  if (conf.audioAutomaticallyAdjustMicVolume !== undefined) {
    ui.audio.autoMic = conf.audioAutomaticallyAdjustMicVolume === '1';
  }
  if (conf.audioNoiseSuppression !== undefined) {
    const ns = conf.audioNoiseSuppression;
    ui.audio.noiseSuppression = (ns === '0') ? 'off' : (ns === '1') ? 'auto' : 'high';
  }
  if (conf.audioEnableOriginalSound !== undefined) {
    ui.audio.originalSound = conf.audioEnableOriginalSound === '1';
  }
  if (conf.audioEnableStereo !== undefined) {
    ui.audio.stereoAudio = conf.audioEnableStereo === '1';
  }

  // Video
  if (conf.videoHD !== undefined) {
    ui.video.hd = conf.videoHD === '1';
  }
  if (conf.videoMirrorEffect !== undefined) {
    ui.video.mirror = conf.videoMirrorEffect === '1';
  }
  if (conf.videoTurnOffOnJoin !== undefined) {
    ui.video.turnOffOnJoin = conf.videoTurnOffOnJoin === '1';
  }
  if (conf.enableVirtualBackground !== undefined) {
    ui.video.virtualBackground = conf.enableVirtualBackground === '1';
  }

  // General
  if (conf.enableDualMonitor !== undefined) {
    ui.general.dualMonitor = conf.enableDualMonitor === '1';
  }
  if (conf.showConnectedTime !== undefined) {
    ui.general.showConnectedTime = conf.showConnectedTime === '1';
  }

  // Notifications
  if (conf.PlaySoundForIM !== undefined) {
    ui.notifications.playSound = conf.PlaySoundForIM === '1';
  }
  if (conf.showToast !== undefined) {
    ui.notifications.showToast = conf.showToast === '1';
  }

  return ui;
}

/**
 * Get list of conf keys that are mapped to UI
 * @returns {string[]}
 */
function getMappedConfKeys() {
  return [
    'enableDarkMode',
    'muteMicOnJoin',
    'audioAutomaticallyAdjustMicVolume',
    'audioNoiseSuppression',
    'audioEnableOriginalSound',
    'audioHighQualityMusicMode',
    'audioEnableStereo',
    'videoHD',
    'videoMirrorEffect',
    'videoTurnOffOnJoin',
    'enableVirtualBackground',
    'enableDualMonitor',
    'showConnectedTime',
    'PlaySoundForIM',
    'showToast'
  ];
}

module.exports = {
  uiToConf,
  confToUi,
  getMappedConfKeys
};
