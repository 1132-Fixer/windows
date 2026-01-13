/**
 * Zoom Preference Templates
 * Version-aware configuration templates
 */

const { versionMatches } = require('./version-detect');

/**
 * Base template - keys stable across most versions
 */
const BASE_TEMPLATE = {
  id: 'base',
  match: null, // Matches all versions as fallback
  conf: {
    // Appearance
    enableDarkMode: '1',
    enableUIV2: '1',

    // Audio - most requested
    muteMicOnJoin: '1',
    audioAutomaticallyAdjustMicVolume: '0',
    audioEchoCancellation: '1',
    audioNoiseSuppression: '2', // 0=off, 1=auto, 2=high

    // Video
    videoMirrorEffect: '0',
    videoHD: '1',
    videoTurnOffOnJoin: '0',
    videoAlwaysShowControls: '1',

    // Behavior
    autoFullScreenWhenJoin: '0',
    autoStartMeetingWhenJoinURL: '0',

    // Privacy
    disableFeedback: '1',
    disableTracking: '1'
  },
  notes: [
    'Base template for all versions',
    'Contains keys stable since Zoom 5.x'
  ]
};

/**
 * Zoom 6.5.x template
 */
const TEMPLATE_6_5 = {
  id: 'zoom-prefs-6.5',
  match: { major: 6, minor: 5 },
  conf: {
    ...BASE_TEMPLATE.conf,
    // 6.5 specific overrides
    audioNoiseSuppression: '2',
    enableAutoLightAdjust: '1'
  },
  notes: [
    '6.5 introduced new light adjustment',
    'Noise suppression uses 0/1/2 scale'
  ]
};

/**
 * Zoom 6.6.x template
 */
const TEMPLATE_6_6 = {
  id: 'zoom-prefs-6.6',
  match: { major: 6, minor: 6 },
  conf: {
    ...BASE_TEMPLATE.conf,
    // 6.6 specific
    audioNoiseSuppression: '2',
    enableAutoLightAdjust: '1',
    enableFaceBeautyEffect: '0'
  },
  notes: [
    '6.6 uses audioNoiseSuppression 0/1/2',
    'Added face beauty effect toggle'
  ]
};

/**
 * Zoom 6.7.x template (current latest)
 */
const TEMPLATE_6_7 = {
  id: 'zoom-prefs-6.7',
  match: { major: 6, minor: 7 },
  conf: {
    ...BASE_TEMPLATE.conf,
    // 6.7 specific
    audioNoiseSuppression: '2',
    enableAutoLightAdjust: '1',
    enableFaceBeautyEffect: '0',
    // New in 6.7
    enableHardwareAcceleration: '1'
  },
  notes: [
    '6.7 added hardware acceleration toggle',
    'Some analytics keys may have changed'
  ]
};

/**
 * Zoom 6.x fallback (any 6.x not specifically matched)
 */
const TEMPLATE_6_X = {
  id: 'zoom-prefs-6.x',
  match: { major: 6 },
  conf: {
    ...BASE_TEMPLATE.conf,
    audioNoiseSuppression: '2',
    enableAutoLightAdjust: '1',
    enableFaceBeautyEffect: '0'
  },
  notes: [
    'Fallback for Zoom 6.x versions',
    'Uses conservative settings'
  ]
};

/**
 * All templates in priority order (most specific first)
 */
const TEMPLATES = [
  TEMPLATE_6_7,
  TEMPLATE_6_6,
  TEMPLATE_6_5,
  TEMPLATE_6_X,
  BASE_TEMPLATE
];

/**
 * Select the best matching template for a version
 * @param {Object} version - Parsed version object
 * @returns {Object} Best matching template
 */
function selectTemplate(version) {
  if (!version) {
    return BASE_TEMPLATE;
  }

  // Try exact minor version match first
  for (const template of TEMPLATES) {
    if (template.match && template.match.minor !== undefined) {
      if (versionMatches(version, template.match)) {
        return template;
      }
    }
  }

  // Try major version match
  for (const template of TEMPLATES) {
    if (template.match && template.match.minor === undefined) {
      if (versionMatches(version, template.match)) {
        return template;
      }
    }
  }

  // Fallback to base
  return BASE_TEMPLATE;
}

/**
 * Get template by ID
 * @param {string} id - Template ID
 * @returns {Object|null}
 */
function getTemplateById(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

/**
 * List all available templates
 * @returns {Array}
 */
function listTemplates() {
  return TEMPLATES.map(t => ({
    id: t.id,
    match: t.match,
    keyCount: Object.keys(t.conf).length,
    notes: t.notes
  }));
}

module.exports = {
  BASE_TEMPLATE,
  TEMPLATES,
  selectTemplate,
  getTemplateById,
  listTemplates
};
