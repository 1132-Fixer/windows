/**
 * Zoom Preferences Module
 * Complete system for version-aware Zoom preference management
 */

const defaults = require('./defaults');
const confUtils = require('./conf-utils');
const versionDetect = require('./version-detect');
const templates = require('./templates');
const mapping = require('./mapping');
const snapshots = require('./snapshots');

module.exports = {
  // Defaults and schema
  ZOOM_PREF_OPTIONS: defaults.ZOOM_PREF_OPTIONS,
  getDefaultPreferences: defaults.getDefaultPreferences,
  validatePreferences: defaults.validatePreferences,

  // Config file utilities
  ZOOM_CONF_PATH: confUtils.ZOOM_CONF_PATH,
  parseZoomConf: confUtils.parseZoomConf,
  renderZoomConf: confUtils.renderZoomConf,
  readZoomConf: confUtils.readZoomConf,
  writeZoomConf: confUtils.writeZoomConf,
  diffConfigs: confUtils.diffConfigs,
  hasChanges: confUtils.hasChanges,
  getDiffSummary: confUtils.getDiffSummary,
  getZoomConfPath: confUtils.getZoomConfPath,

  // Version detection
  findZoomExe: versionDetect.findZoomExe,
  getZoomExeVersion: versionDetect.getZoomExeVersion,
  parseVersion: versionDetect.parseVersion,
  detectZoomVersion: versionDetect.detectZoomVersion,
  versionMatches: versionDetect.versionMatches,
  compareVersions: versionDetect.compareVersions,

  // Templates
  BASE_TEMPLATE: templates.BASE_TEMPLATE,
  TEMPLATES: templates.TEMPLATES,
  selectTemplate: templates.selectTemplate,
  getTemplateById: templates.getTemplateById,
  listTemplates: templates.listTemplates,

  // UI <-> Conf mapping
  uiToConf: mapping.uiToConf,
  confToUi: mapping.confToUi,
  getMappedConfKeys: mapping.getMappedConfKeys,

  // Snapshots and diffs
  takeSnapshot: snapshots.takeSnapshot,
  loadSnapshot: snapshots.loadSnapshot,
  compareSnapshots: snapshots.compareSnapshots,
  saveDiff: snapshots.saveDiff,
  getDiffsForBuild: snapshots.getDiffsForBuild,
  getLatestDiff: snapshots.getLatestDiff,
  waitForFileSettle: snapshots.waitForFileSettle,
  cleanOldSnapshots: snapshots.cleanOldSnapshots
};
