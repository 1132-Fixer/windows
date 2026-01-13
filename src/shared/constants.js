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
  'ZoomVDIPluginManagement',

  // Additional missing processes
  'ZoomChat',
  'ZoomNotes',
  'ZoomPhone',
  'ZoomWebexAgent',
  'ZoomWorkspace',
  'zTelemetry',
  'ZoomPresence',
  'ZoomClips',
  'ZoomWhiteboard',
  'ZoomMail',
  'ZoomCalendar',
  'ZoomScheduler',
  'ZoomOneTouch'
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
    // IM Provider registration
    'HKCU\\Software\\IM Providers\\Zoom',
    // Location consent (geolocation permission)
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location\\NonPackaged\\Zoom',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom',
    // VirtualStore (UAC redirected writes)
    'HKCU\\Software\\Classes\\VirtualStore\\Machine\\Software\\Zoom',
    'HKCU\\Software\\Classes\\VirtualStore\\Machine\\Software\\ZoomUMX',
    'HKCU\\Software\\Classes\\VirtualStore\\Machine\\Software\\zoom.us',
    'HKCU\\Software\\Classes\\VirtualStore\\Machine\\Software\\CptService',
    // URL Protocol Handlers
    'HKCU\\Software\\Classes\\zoom',
    'HKCU\\Software\\Classes\\zoommtg',
    'HKCU\\Software\\Classes\\zoomphonecall',
    'HKCU\\Software\\Classes\\zoomus',
    'HKCU\\Software\\Classes\\zoomrc',
    'HKCU\\Software\\Classes\\zoomrc.rooms',
    // Notification Settings
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\Zoom.Zoom',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\zoom.us.Zoom'
  ],

  // Local Machine
  HKLM: [
    'HKLM\\Software\\Zoom',
    // CRITICAL: Cryptographic secrets/device identity
    'HKLM\\Software\\Zoom\\Secrets',
    'HKLM\\Software\\ZoomUMX',
    'HKLM\\Software\\zoom.us',
    'HKLM\\Software\\Zoom Video Communications',
    'HKLM\\Software\\Zoom Workplace',
    'HKLM\\Software\\CptService',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ZoomCptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\zCSCptService',
    // URL Protocol Handlers (system-wide)
    'HKLM\\Software\\Classes\\zoom',
    'HKLM\\Software\\Classes\\zoommtg',
    'HKLM\\Software\\Classes\\zoomphonecall',
    'HKLM\\Software\\Classes\\zoomus',
    'HKLM\\Software\\Classes\\zoomrc',
    // Group Policy / Enterprise settings (CRITICAL for device fingerprinting)
    'HKLM\\Software\\Policies\\Zoom',
    'HKLM\\Software\\Policies\\Zoom\\Zoom Meetings',
    'HKLM\\Software\\Policies\\Zoom\\Zoom Meetings\\General',
    'HKLM\\Software\\Policies\\Zoom\\Zoom Meetings\\Meetings',
    'HKLM\\Software\\Policies\\Zoom\\Zoom Meetings\\Chat'
  ],

  // WOW6432Node (32-bit on 64-bit)
  WOW64: [
    'HKLM\\Software\\WOW6432Node\\Zoom',
    'HKLM\\Software\\WOW6432Node\\ZoomUMX',
    'HKLM\\Software\\WOW6432Node\\zoom.us',
    'HKLM\\Software\\WOW6432Node\\Zoom Video Communications',
    'HKLM\\Software\\WOW6432Node\\Zoom Workplace',
    'HKLM\\Software\\WOW6432Node\\CptService',
    // Group Policy WOW64
    'HKLM\\Software\\WOW6432Node\\Policies\\Zoom',
    'HKLM\\Software\\WOW6432Node\\Policies\\Zoom\\Zoom Meetings'
  ],

  // HKEY_CLASSES_ROOT (URL handlers & COM)
  HKCR: [
    'HKCR\\zoom',
    'HKCR\\zoommtg',
    'HKCR\\zoomphonecall',
    'HKCR\\zoomus',
    'HKCR\\zoomrc',
    'HKCR\\zoomrc.rooms'
  ]
};

/**
 * Registry paths that need value-by-value cleanup (search for zoom entries)
 * These contain mixed data - only remove zoom-related values
 */
const REGISTRY_CLEANUP_PATHS = {
  // User activity tracking - contains execution history
  userAssist: [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\\Count',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}\\Count'
  ],
  // Background/Desktop Activity Moderator - tracks EXE launches
  activityModerator: [
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\bam\\State\\UserSettings',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\dam\\State\\UserSettings'
  ],
  // Shell history - folder access, file dialogs
  shellHistory: [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RecentDocs',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32\\OpenSavePidlMRU',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32\\LastVisitedPidlMRU',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32\\LastVisitedPidlMRULegacy',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\TypedPaths'
  ],
  // MUI Cache - display names of executed programs
  muiCache: 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache',
  // App Compatibility
  appCompat: [
    'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
    'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Compatibility Assistant\\Store'
  ],
  // FeatureUsage - tracks feature usage per app
  featureUsage: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FeatureUsage\\AppSwitched'
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
  'zCSCptService',
  'Zoom Sharing Service',
  'ZoomRooms',
  'ZoomPresence'
];

/**
 * Scheduled tasks to delete
 */
const ZOOM_SCHEDULED_TASKS = [
  'Zoom',
  'ZoomUpdateTaskMachine',
  'ZoomUpdateTaskUser',
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
    path.join(LOCALAPPDATA, 'Zoom', 'telemetrydata.db'),
    path.join(APPDATA, 'Zoom', 'data', 'zoomus.db'),
    path.join(LOCALAPPDATA, 'Zoom', 'data', 'zoomus.db'),
    path.join(APPDATA, 'Zoom', 'data', 'zoom.db'),
    path.join(LOCALAPPDATA, 'Zoom', 'data', 'zoom.db')
  ],

  // CptService - Screen sharing service with device ID
  cptServiceFolders: [
    path.join(PROGRAMDATA, 'CptService'),
    path.join(PROGRAMDATA, 'CptHost'),
    path.join(PROGRAMDATA, 'Zoom CptService'),
    path.join(PROGRAMDATA, 'zCSCptService')
  ],

  // Registry fingerprints
  registryFingerprints: [
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ZoomCptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\zCSCptService',
    'HKCU\\Software\\CptService',
    'HKLM\\Software\\CptService'
  ],

  // Prefetch files (Windows execution history)
  prefetchPatterns: [
    'C:\\Windows\\Prefetch\\*ZOOM*.pf',
    'C:\\Windows\\Prefetch\\*CPT*.pf',
    'C:\\Windows\\Prefetch\\*ZOOMUS*.pf',
    'C:\\Windows\\Prefetch\\*ZCS*.pf'
  ],

  // Amcache - Windows program execution history database
  amcache: [
    'C:\\Windows\\AppCompat\\Programs\\Amcache.hve',
    'C:\\Windows\\AppCompat\\Programs\\RecentFileCache.bcf'
  ],

  // SRUM - System Resource Usage Monitor (tracks app usage)
  srum: 'C:\\Windows\\System32\\sru\\SRUDB.dat'
};

/**
 * Additional system trace locations (deep clean)
 * These contain evidence of Zoom being run
 */
const SYSTEM_TRACE_LOCATIONS = {
  // Jump Lists - Recent items in taskbar
  jumpLists: [
    path.join(APPDATA, 'Microsoft', 'Windows', 'Recent'),
    path.join(APPDATA, 'Microsoft', 'Windows', 'Recent', 'AutomaticDestinations'),
    path.join(APPDATA, 'Microsoft', 'Windows', 'Recent', 'CustomDestinations')
  ],

  // VirtualStore - UAC redirected file writes
  virtualStore: [
    path.join(LOCALAPPDATA, 'VirtualStore', 'Program Files', 'Zoom'),
    path.join(LOCALAPPDATA, 'VirtualStore', 'Program Files (x86)', 'Zoom'),
    path.join(LOCALAPPDATA, 'VirtualStore', 'ProgramData', 'Zoom'),
    path.join(LOCALAPPDATA, 'VirtualStore', 'ProgramData', 'CptService')
  ],

  // Windows Error Reporting - Crash dumps
  crashDumps: [
    path.join(LOCALAPPDATA, 'CrashDumps'),
    path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
    path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER', 'ReportQueue')
  ],

  // Icon & Thumbnail Cache
  iconCache: [
    path.join(LOCALAPPDATA, 'IconCache.db'),
    path.join(LOCALAPPDATA, 'Microsoft', 'Windows', 'Explorer')
  ],

  // Windows Notifications database
  notifications: path.join(LOCALAPPDATA, 'Microsoft', 'Windows', 'Notifications'),

  // Additional temp locations
  tempLocations: [
    path.join(LOCALAPPDATA, 'Temp'),
    path.join(TEMP, 'Zoom'),
    path.join(TEMP, 'zoomus'),
    path.join(TEMP, 'zoom_installer'),
    path.join(TEMP, 'ZoomInstaller'),
    'C:\\Windows\\Temp'
  ],

  // Recycle bin pattern
  recycleBin: 'C:\\$Recycle.Bin',

  // Outlook integration cache
  outlookCache: [
    path.join(LOCALAPPDATA, 'Microsoft', 'Outlook', 'RoamCache')
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
  REGISTRY_CLEANUP_PATHS,
  REGISTRY_RUN_VALUES,
  ZOOM_SERVICES,
  ZOOM_SCHEDULED_TASKS,
  ZOOM_CREDENTIALS,
  FINGERPRINT_LOCATIONS,
  SYSTEM_TRACE_LOCATIONS,
  ZOOM_INSTALLER,
  ZOOM_EXECUTABLE_PATHS,
  ZOOM_UNINSTALLER_PATHS
};
