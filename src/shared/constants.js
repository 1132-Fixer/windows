/**
 * 1132 Remover - Shared Constants
 * All Zoom-related paths, processes, registry keys, and fingerprint locations
 */

const path = require('path');

// Environment paths
const APPDATA = process.env.APPDATA;
const LOCALAPPDATA = process.env.LOCALAPPDATA;
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData';
const USERPROFILE = process.env.USERPROFILE;
const TEMP = process.env.TEMP;

/**
 * All Zoom process names that need to be killed
 * Comprehensive list covering all Zoom variants
 */
const ZOOM_PROCESSES = [
  // Main Zoom Workplace
  'Zoom',
  'Zoomus',
  'Zoom_launcher',
  'ZoomHybridConf',
  'zSafeChecker',

  // Screen Sharing / Companion (CptService)
  'CptHost',
  'CptService',
  'CptControl',
  'CptInstall',

  // SDK Renamed Variants
  'zcscpthost',
  'zCSCptService',
  'zcsairhost',

  // Audio/Video Optimization
  'aomhost',
  'aomhost64',
  'airhost',

  // Crash Reporting
  'zCrashReport',
  'zCrashReport64',

  // Outlook Integration
  'ZoomOutlookIMPlugin',
  'ZoomOutlookMAPI',
  'ZoomOutlookMAPI64',

  // Document/Media Processing
  'ZoomDocConverter',
  'zTscoder',

  // Updater/Installer
  'zUpdater',
  'ZoomInstaller',
  'Installer',

  // Web/CEF Components
  'ZoomWebHost',
  'zWebview2Agent',
  'zCefAgent',
  'msedgewebview2',

  // SDK/Messenger
  'ZoomSDKMessenger',

  // Zoom Rooms
  'ZoomRooms',
  'zrshell',
  'Controller',
  'DigitalSignage',
  'zrairhost',
  'zrcpthost',
  'bcairhost',
  'conmon_server',
  'mDNSResponder',
  'ptp',
  'ZAAPI',
  'zCECHelper',
  'zJob',
  'zPrinterAgent',
  'ZR3rdHW',
  'zrusplayer',
  'apec3',
  'notification_helper',

  // VDI
  'ZoomVDITool',
  'zWspExtension',
  'ZoomVDIPluginManagement'
];

/**
 * Zoom data folder locations
 * All paths where Zoom stores user data
 */
const ZOOM_DATA_PATHS = [
  // AppData Roaming
  path.join(APPDATA, 'Zoom'),
  path.join(APPDATA, 'Zoom Meetings'),
  path.join(APPDATA, 'zoomus'),
  path.join(APPDATA, 'ZoomLogs'),
  path.join(APPDATA, 'ZoomUMX'),
  path.join(APPDATA, 'zoom.us'),
  path.join(APPDATA, 'Zoom Workplace'),
  path.join(APPDATA, 'ZoomOutlookPlugin'),
  path.join(APPDATA, 'ZoomGifCollector'),
  path.join(APPDATA, 'Zoom VDI'),

  // LocalAppData
  path.join(LOCALAPPDATA, 'Zoom'),
  path.join(LOCALAPPDATA, 'zoomus'),
  path.join(LOCALAPPDATA, 'ZoomLogs'),
  path.join(LOCALAPPDATA, 'ZoomUMX'),
  path.join(LOCALAPPDATA, 'zoom.us'),
  path.join(LOCALAPPDATA, 'Zoom Workplace'),
  path.join(LOCALAPPDATA, 'ZoomOutlookPlugin'),
  path.join(LOCALAPPDATA, 'ZoomGifCollector'),
  path.join(LOCALAPPDATA, 'Zoom VDI'),
  path.join(LOCALAPPDATA, 'Programs', 'Zoom'),
  path.join(LOCALAPPDATA, 'Programs', 'zoom.us'),

  // ProgramData (system-wide device identifiers)
  path.join(PROGRAMDATA, 'Zoom'),
  path.join(PROGRAMDATA, 'ZoomVideo'),
  path.join(PROGRAMDATA, 'Zoom Video Communications'),
  path.join(PROGRAMDATA, 'CptService'),
  path.join(PROGRAMDATA, 'CptHost'),
  path.join(PROGRAMDATA, 'Zoom CptService'),
  path.join(PROGRAMDATA, 'Zoom VDI'),

  // User profile locations
  path.join(USERPROFILE, 'Documents', 'Zoom'),
  path.join(USERPROFILE, 'AppData', 'LocalLow', 'Zoom'),

  // Temp folders
  path.join(TEMP, 'Zoom'),
  path.join(TEMP, 'zoomus'),
  path.join(TEMP, 'zoom_installer'),

  // Program Files
  'C:\\Program Files\\Zoom',
  'C:\\Program Files (x86)\\Zoom',
  'C:\\Program Files\\Zoom Workplace',
  'C:\\Program Files (x86)\\Zoom Workplace',
  'C:\\Program Files\\Common Files\\Zoom',
  'C:\\Program Files (x86)\\Common Files\\Zoom',
  'C:\\Program Files\\Common Files\\zoom.us',
  'C:\\Program Files (x86)\\Common Files\\zoom.us'
];

/**
 * Registry keys to delete
 * Complete list of Zoom registry entries
 */
const REGISTRY_KEYS = {
  // Current User
  HKCU: [
    'HKCU\\Software\\Zoom',
    'HKCU\\Software\\ZoomUMX',
    'HKCU\\Software\\zoom.us',
    'HKCU\\Software\\Zoom Video Communications',
    'HKCU\\Software\\Zoom Workplace',
    'HKCU\\Software\\ZoomGifCollector',
    'HKCU\\Software\\CptService',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom'
  ],

  // Local Machine
  HKLM: [
    'HKLM\\Software\\Zoom',
    'HKLM\\Software\\ZoomUMX',
    'HKLM\\Software\\zoom.us',
    'HKLM\\Software\\Zoom Video Communications',
    'HKLM\\Software\\Zoom Workplace',
    'HKLM\\Software\\CptService',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ZoomCptService'
  ],

  // WOW6432Node (32-bit on 64-bit)
  WOW64: [
    'HKLM\\Software\\WOW6432Node\\Zoom',
    'HKLM\\Software\\WOW6432Node\\ZoomUMX',
    'HKLM\\Software\\WOW6432Node\\zoom.us'
  ]
};

/**
 * Registry Run entries (auto-start)
 */
const REGISTRY_RUN_VALUES = [
  { key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', value: 'Zoom' },
  { key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', value: 'ZoomUMX' }
];

/**
 * Windows Services to stop and delete
 */
const ZOOM_SERVICES = [
  'CptService',
  'ZoomCptService',
  'Zoom Sharing Service'
];

/**
 * Scheduled tasks to delete
 */
const ZOOM_SCHEDULED_TASKS = [
  'Zoom',
  'ZoomUpdateTaskMachine',
  'ZoomInstallUpdate',
  'ZoomGifCollector',
  'ZoomCleaner',
  'ZoomAutoUpdate'
];

/**
 * Windows Credentials to delete
 */
const ZOOM_CREDENTIALS = [
  'zoom.us',
  'Zoom',
  'ZoomVideo',
  'ZoomUMX',
  'ZoomWorkplace'
];

/**
 * Device fingerprint locations (CRITICAL for 1132 bypass)
 * These are the files/folders that identify the device to Zoom
 */
const FINGERPRINT_LOCATIONS = {
  // Telemetry databases - primary device identifiers
  telemetryDatabases: [
    path.join(APPDATA, 'Zoom', 'data', 'telemetrydata.db'),
    path.join(LOCALAPPDATA, 'Zoom', 'data', 'telemetrydata.db'),
    path.join(APPDATA, 'Zoom', 'telemetrydata.db'),
    path.join(LOCALAPPDATA, 'Zoom', 'telemetrydata.db')
  ],

  // CptService - Screen sharing service with device ID
  cptServiceFolders: [
    path.join(PROGRAMDATA, 'CptService'),
    path.join(PROGRAMDATA, 'CptHost'),
    path.join(PROGRAMDATA, 'Zoom CptService')
  ],

  // Registry fingerprints
  registryFingerprints: [
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ZoomCptService',
    'HKCU\\Software\\CptService'
  ],

  // Prefetch files (Windows execution history)
  prefetchPatterns: [
    'C:\\Windows\\Prefetch\\*ZOOM*.pf',
    'C:\\Windows\\Prefetch\\*CPT*.pf'
  ]
};

/**
 * Zoom installer configuration
 */
const ZOOM_INSTALLER = {
  url: 'https://zoom.us/client/latest/ZoomInstallerFull.msi',
  fallbackUrl: 'https://zoom.us/client/latest/ZoomInstaller.exe',
  downloadPath: path.join(TEMP, 'ZoomInstallerFull.msi'),
  installArgs: ['/i', '%PATH%', '/qn', '/norestart', 'ALLUSERS=1'],
  timeout: 300000 // 5 minutes
};

/**
 * Zoom executable paths for launching
 */
const ZOOM_EXECUTABLE_PATHS = [
  'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
  'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe',
  path.join(APPDATA, 'Zoom', 'bin', 'Zoom.exe'),
  path.join(LOCALAPPDATA, 'Zoom', 'bin', 'Zoom.exe'),
  path.join(LOCALAPPDATA, 'Programs', 'Zoom', 'Zoom.exe')
];

/**
 * Zoom uninstaller paths
 */
const ZOOM_UNINSTALLER_PATHS = [
  'C:\\Program Files\\Zoom\\bin\\Installer.exe',
  'C:\\Program Files (x86)\\Zoom\\bin\\Installer.exe',
  path.join(LOCALAPPDATA, 'Programs', 'Zoom', 'Installer.exe'),
  path.join(APPDATA, 'Zoom', 'bin', 'Installer.exe')
];

module.exports = {
  ZOOM_PROCESSES,
  ZOOM_DATA_PATHS,
  REGISTRY_KEYS,
  REGISTRY_RUN_VALUES,
  ZOOM_SERVICES,
  ZOOM_SCHEDULED_TASKS,
  ZOOM_CREDENTIALS,
  FINGERPRINT_LOCATIONS,
  ZOOM_INSTALLER,
  ZOOM_EXECUTABLE_PATHS,
  ZOOM_UNINSTALLER_PATHS
};
