# Product Requirements Document: Forensic Remediation Platform

**Product Name:** 1132-Remover Evolution → **WinPurge** (working title)
**Version:** 2.0 Architecture
**Target:** Personal/Home Use
**Base:** Evolving from 1132-Remover codebase

---

## Executive Summary

Transform the current Zoom-specific 1132-Remover into a **forensic-grade Windows remediation platform** that can detect, correlate, remove, verify, and prevent reinfection of malware and unwanted software on personal Windows systems.

### Product Contract (Definition of Done)

**Clean State** = All of the following verified:
- No malicious code executing
- No persistence mechanisms remaining
- No suspicious artifacts unresolved
- System integrity attested
- Monitoring baseline established (optional)

### What We Promise

| Promise | Guarantee |
|---------|-----------|
| **Eradication** | Remove all *known and discovered* threat components |
| **Proof** | Verifiable checks with reproducible outcomes |
| **Hardening** | Prevent re-establishment of removed threats |
| **Monitoring** | Detect "relapse" behaviors post-clean |
| **Honesty** | Clear reporting of what we can/cannot verify |

---

## Table of Contents

1. [Product Vision & Goals](#1-product-vision--goals)
2. [User Stories & Personas](#2-user-stories--personas)
3. [System Architecture](#3-system-architecture)
4. [Module Specifications](#4-module-specifications)
5. [Data Model & Graph Relationships](#5-data-model--graph-relationships)
6. [Detection Engines](#6-detection-engines)
7. [Threat Scoring Rubric](#7-threat-scoring-rubric)
8. [Complete Persistence Checklist](#8-complete-persistence-checklist)
9. [Remediation Engine](#9-remediation-engine)
10. [Verification Engine](#10-verification-engine)
11. [Clean Attestation Report Format](#11-clean-attestation-report-format)
12. [Hardening & Monitoring](#12-hardening--monitoring)
13. [Anti-Evasion Precautions](#13-anti-evasion-precautions)
14. [Safety & Abuse Prevention](#14-safety--abuse-prevention)
15. [Migration Path from 1132-Remover](#15-migration-path-from-1132-remover)
16. [Testing Strategy](#16-testing-strategy)

---

## 1. Product Vision & Goals

### Vision Statement

Enable home users to **confidently remediate** compromised Windows systems with forensic-grade thoroughness, **prove** the system is clean, and **prevent** reinfection—without requiring security expertise.

### Core Goals

| Goal | Success Metric |
|------|----------------|
| **Comprehensive Detection** | Cover 95%+ of known Windows persistence mechanisms |
| **Accurate Classification** | < 1% false positive rate on common software |
| **Complete Removal** | 0% relapse rate for detected threats after reboot |
| **Verifiable Clean** | Independent verification confirms all remediation |
| **User Trust** | Clear explanations for every detection and action |

### Non-Goals (Explicitly Out of Scope)

- Real-time protection (this is remediation, not AV)
- Enterprise management console
- Network-wide scanning
- Mobile/macOS/Linux support
- Competing with commercial EDR products

---

## 2. User Stories & Personas

### Primary Persona: "Alex" - Tech-Savvy Home User

**Background:** Comfortable with computers, runs into occasional malware issues, wants to fix problems without reformatting.

**User Stories:**

```
As Alex, I want to...
- Scan my PC and see exactly what's suspicious, so I understand the threat
- See relationships between suspicious items (what created what), so I can trust the detection
- Remove threats in a safe order, so I don't break my system
- Verify the threat is actually gone, so I have confidence
- Get alerted if something comes back, so I catch reinfection early
- Keep a log of what was done, so I have proof/records
```

### Secondary Persona: "Jordan" - Family IT Support

**Background:** Helps family members clean infected PCs, needs a tool that's thorough but explainable.

**User Stories:**

```
As Jordan, I want to...
- Run a scan on a family member's PC remotely/in-person
- Generate a report I can explain to non-technical users
- Have confidence the cleanup is complete before returning the PC
- Optionally set up monitoring so they can alert me if reinfected
```

### Tertiary Persona: "Sam" - Privacy-Conscious User

**Background:** Wants to remove specific software completely (like the original Zoom use case) and ensure no traces remain.

**User Stories:**

```
As Sam, I want to...
- Target specific software for complete removal
- See every trace that will be removed before confirming
- Verify no fingerprints or tracking data remains
- Optionally purge execution history artifacts
```

---

## 3. System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACE LAYER                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │   Scan UI   │  │  Graph View │  │ Remediation │  │   Reports   │   │
│  │             │  │  (Threat    │  │   Wizard    │  │   & Logs    │   │
│  │             │  │   Map)      │  │             │  │             │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ IPC (Electron)
┌────────────────────────────────┴────────────────────────────────────────┐
│                          ORCHESTRATION LAYER                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      Session Controller                          │   │
│  │   - Scan orchestration                                           │   │
│  │   - Remediation state machine                                    │   │
│  │   - Verification coordinator                                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                         ACQUISITION LAYER                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │FileSystem│ │ Registry │ │ Process  │ │Persistence│ │ Network  │     │
│  │ Scanner  │ │ Scanner  │ │ Scanner  │ │ Scanner   │ │ Scanner  │     │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘     │
│       └────────────┴────────────┴────────────┴────────────┘            │
│                                 │                                       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              Redundant Collection Engine                         │   │
│  │   (API-based + Raw enumeration for cross-validation)             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                        NORMALIZATION LAYER                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Unified Artifact Model                        │   │
│  │   - Entity definitions (Process, File, RegKey, Service, etc.)    │   │
│  │   - Relationship tracking (spawned, wrote, persists_via, etc.)   │   │
│  │   - Temporal ordering (when did each artifact appear)            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                        CORRELATION ENGINE                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      Graph Database                              │   │
│  │   - Build entity relationships                                   │   │
│  │   - Trace causality chains                                       │   │
│  │   - Identify threat clusters                                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                         DETECTION LAYER                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │Signature │ │Reputation│ │Heuristic │ │ Behavior │ │ Integrity│     │
│  │ Engine   │ │ Engine   │ │ Engine   │ │ Engine   │ │ Engine   │     │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘     │
│       └────────────┴────────────┴────────────┴────────────┘            │
│                                 │                                       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Threat Scoring Engine                         │   │
│  │   - Confidence scoring                                           │   │
│  │   - Impact assessment                                            │   │
│  │   - Persistence strength                                         │   │
│  │   - Stealth rating                                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                        REMEDIATION LAYER                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                 Staged Remediation Engine                        │   │
│  │                                                                   │   │
│  │   Stage 1: Quarantine & Contain                                  │   │
│  │   Stage 2: Neutralize Execution                                  │   │
│  │   Stage 3: Remove Persistence                                    │   │
│  │   Stage 4: Remove Payloads                                       │   │
│  │   Stage 5: Repair & Restore                                      │   │
│  │   Stage 6: Credential Safety                                     │   │
│  │                                                                   │   │
│  │   + Transaction Log (before/action/after/rollback)               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                       VERIFICATION LAYER                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │               Independent Verification Engine                    │   │
│  │   - Fresh enumeration (no cached data)                           │   │
│  │   - Re-creation monitoring                                       │   │
│  │   - Post-reboot verification                                     │   │
│  │   - Integrity attestation                                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                     HARDENING & MONITORING LAYER                        │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐   │
│  │     Baseline Snapshot        │  │    Change Monitor            │   │
│  │   - Known-good state         │  │   - Persistence changes      │   │
│  │   - Hash inventory           │  │   - Policy tampering         │   │
│  │   - Config backup            │  │   - Suspicious activity      │   │
│  └──────────────────────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Core Design Principles

1. **Map First, Delete Later** - Never delete without understanding the full threat picture
2. **Staged Operations** - Contain → Neutralize → Remove → Verify
3. **Redundant Collection** - Cross-validate findings using multiple methods
4. **Independent Verification** - Re-check from scratch, don't trust cached results
5. **Transactional Remediation** - Every action logged with rollback capability
6. **Honest Reporting** - Clearly state what was verified vs. what couldn't be proven

---

## 4. Module Specifications

### 4.1 Acquisition Modules

#### 4.1.1 FileSystem Scanner (`src/main/acquisition/filesystem-scanner.js`)

**Responsibilities:**
- Enumerate files in target directories
- Detect alternate data streams (ADS)
- Identify junctions, symlinks, hardlinks
- Calculate file hashes (SHA256)
- Measure file entropy (packed/encrypted detection)
- Validate digital signatures
- Handle locked files gracefully

**Inputs:**
- List of target directories
- File type filters (optional)
- Depth limit (optional)

**Outputs:**
```javascript
{
  type: 'file',
  path: 'C:\\path\\to\\file.exe',
  name: 'file.exe',
  size: 123456,
  created: '2024-01-15T10:30:00Z',
  modified: '2024-01-15T10:30:00Z',
  accessed: '2024-01-16T08:00:00Z',
  sha256: 'abc123...',
  entropy: 7.2,
  signature: {
    valid: true,
    signer: 'Microsoft Corporation',
    trusted: true
  },
  ads: ['Zone.Identifier'],
  attributes: ['hidden', 'system'],
  isLocked: false
}
```

**Methods:**
```javascript
scanDirectory(path, options) → FileArtifact[]
scanFile(path) → FileArtifact
calculateEntropy(path) → number
validateSignature(path) → SignatureInfo
enumerateADS(path) → string[]
resolveLinks(path) → ResolvedPath
```

---

#### 4.1.2 Registry Scanner (`src/main/acquisition/registry-scanner.js`)

**Responsibilities:**
- Enumerate registry keys and values
- Decode binary/REG_BINARY data
- Expand environment variables in paths
- Identify registry-based persistence
- Track last-write timestamps
- Handle permission-denied gracefully

**Inputs:**
- List of registry paths to scan
- Value type filters (optional)
- Recursion depth (optional)

**Outputs:**
```javascript
{
  type: 'registryKey',
  path: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
  name: 'MalwareLoader',
  valueType: 'REG_SZ',
  value: 'C:\\malware\\loader.exe',
  expandedValue: 'C:\\malware\\loader.exe',
  lastWriteTime: '2024-01-15T10:30:00Z',
  owner: 'SYSTEM',
  persistenceType: 'autorun'
}
```

**Methods:**
```javascript
scanKey(keyPath, options) → RegistryArtifact[]
getValue(keyPath, valueName) → RegistryArtifact
enumerateSubkeys(keyPath) → string[]
getLastWriteTime(keyPath) → Date
decodeValue(rawValue, type) → any
```

---

#### 4.1.3 Process Scanner (`src/main/acquisition/process-scanner.js`)

**Responsibilities:**
- Enumerate running processes
- Capture command-line arguments
- Build parent-child process trees
- Enumerate loaded modules
- Identify suspicious memory regions
- Detect process hollowing indicators
- Cross-reference with on-disk files

**Outputs:**
```javascript
{
  type: 'process',
  pid: 1234,
  name: 'svchost.exe',
  path: 'C:\\Windows\\System32\\svchost.exe',
  commandLine: 'svchost.exe -k netsvcs',
  parentPid: 456,
  parentName: 'services.exe',
  user: 'NT AUTHORITY\\SYSTEM',
  startTime: '2024-01-16T08:00:00Z',
  modules: [...],
  memoryRegions: [...],
  integrity: 'System',
  isElevated: true,
  signature: {...},
  anomalies: ['unbacked_rwx_region']
}
```

**Methods:**
```javascript
enumerateProcesses() → ProcessArtifact[]
getProcessTree() → ProcessTree
getModules(pid) → ModuleArtifact[]
getMemoryRegions(pid) → MemoryRegion[]
detectAnomalies(pid) → Anomaly[]
```

---

#### 4.1.4 Persistence Scanner (`src/main/acquisition/persistence-scanner.js`)

**Responsibilities:**
- Enumerate ALL Windows persistence mechanisms
- Parse scheduled task XML
- Decode WMI subscription bindings
- Enumerate services and drivers
- Check boot configuration
- Identify COM hijacks
- Detect LSA/authentication hooks

**Outputs:**
```javascript
{
  type: 'persistence',
  mechanism: 'scheduled_task',
  name: 'MalwareUpdate',
  path: '\\Microsoft\\Windows\\MalwareUpdate',
  target: 'C:\\malware\\update.exe',
  trigger: 'at_logon',
  runAs: 'SYSTEM',
  enabled: true,
  lastRun: '2024-01-15T10:30:00Z',
  nextRun: '2024-01-16T10:30:00Z',
  created: '2024-01-10T08:00:00Z',
  rawXml: '...'
}
```

**Methods:**
```javascript
scanAllPersistence() → PersistenceArtifact[]
scanScheduledTasks() → TaskArtifact[]
scanServices() → ServiceArtifact[]
scanDrivers() → DriverArtifact[]
scanWmiSubscriptions() → WmiArtifact[]
scanComHijacks() → ComArtifact[]
scanLsaProviders() → LsaArtifact[]
scanBootConfig() → BootArtifact[]
```

---

#### 4.1.5 Network Scanner (`src/main/acquisition/network-scanner.js`)

**Responsibilities:**
- Enumerate active connections
- Check DNS configuration
- Inspect hosts file
- Enumerate proxy settings
- Check firewall rules
- Enumerate installed certificates
- Detect rogue root CAs

**Outputs:**
```javascript
{
  type: 'network_config',
  category: 'dns',
  current: ['8.8.8.8', '8.8.4.4'],
  isDefault: false,
  modifiedBy: 'unknown',
  suspiciousIndicators: ['non_standard_dns']
}
```

**Methods:**
```javascript
getActiveConnections() → ConnectionArtifact[]
getDnsConfig() → DnsConfig
getHostsFile() → HostsEntry[]
getProxySettings() → ProxyConfig
getFirewallRules() → FirewallRule[]
getCertificates(store) → CertArtifact[]
detectRogueCAs() → CertArtifact[]
```

---

#### 4.1.6 Credential Scanner (`src/main/acquisition/credential-scanner.js`)

**Responsibilities:**
- Enumerate Credential Manager entries
- Identify browser session tokens
- Detect saved RDP credentials
- Find SSH keys (if present)
- Identify vault entries
- **Never extract actual credentials** - only metadata

**Outputs:**
```javascript
{
  type: 'credential',
  store: 'windows_credential_manager',
  target: 'MicrosoftAccount:user@example.com',
  type: 'generic',
  persistence: 'local_machine',
  lastWritten: '2024-01-15T10:30:00Z',
  // Note: actual credential value is NEVER captured
}
```

**Methods:**
```javascript
enumerateCredentials() → CredentialMetadata[]
enumerateBrowserSessions() → SessionMetadata[]
enumerateSshKeys() → SshKeyMetadata[]
assessCredentialRisk() → RiskAssessment
```

---

### 4.2 Normalization Module (`src/main/normalization/artifact-model.js`)

**Responsibilities:**
- Convert scanner outputs to unified artifact format
- Assign unique artifact IDs
- Track artifact provenance (which scanner found it)
- Handle duplicate detection
- Maintain temporal ordering

**Unified Artifact Schema:**
```javascript
{
  id: 'artifact_abc123',
  type: 'file|registry|process|persistence|network|credential',
  subtype: 'specific_subtype',
  name: 'human_readable_name',
  path: 'full_path_or_identifier',

  // Temporal
  firstSeen: '2024-01-15T10:30:00Z',
  lastSeen: '2024-01-16T08:00:00Z',
  created: '2024-01-10T00:00:00Z',

  // Provenance
  source: 'filesystem_scanner',
  collectionMethod: 'api|raw|both',
  confidence: 0.95,

  // Classification (added by detection layer)
  threat: {
    detected: true,
    score: 85,
    engines: ['signature', 'heuristic'],
    category: 'trojan',
    family: 'emotet'
  },

  // Relationships (added by correlation layer)
  relationships: [
    { type: 'spawned_by', targetId: 'artifact_xyz789' },
    { type: 'wrote', targetId: 'artifact_def456' },
    { type: 'persists_via', targetId: 'artifact_ghi012' }
  ],

  // Raw data (for expert view)
  raw: { ... }
}
```

---

### 4.3 Correlation Module (`src/main/correlation/graph-engine.js`)

**Responsibilities:**
- Build relationship graph between artifacts
- Trace causality chains (what created what)
- Identify threat clusters
- Calculate "blast radius" of threats
- Answer lineage queries

**Graph Node Types:**
- Process, Thread, Module
- File, Directory, AlternateStream
- RegistryKey, RegistryValue
- Service, Driver, ScheduledTask
- WmiConsumer, WmiFilter, WmiBinding
- NetworkConnection, DnsQuery
- Credential, Certificate

**Edge Types:**
```javascript
const EDGE_TYPES = {
  // Process relationships
  SPAWNED: 'spawned',           // Process → Process
  INJECTED_INTO: 'injected_into', // Process → Process

  // File relationships
  WROTE: 'wrote',               // Process → File
  READ: 'read',                 // Process → File
  EXECUTED: 'executed',         // Process → File
  DROPPED: 'dropped',           // File → File

  // Persistence relationships
  PERSISTS_VIA: 'persists_via', // File → Persistence
  POINTS_TO: 'points_to',       // Registry → File
  LOADS: 'loads',               // Service → Driver

  // Network relationships
  CONNECTED_TO: 'connected_to', // Process → IP/Domain
  RESOLVED: 'resolved',         // DNS → IP

  // Temporal
  PRECEDED: 'preceded',         // Any → Any (time-based)
};
```

**Methods:**
```javascript
addNode(artifact) → void
addEdge(sourceId, targetId, edgeType, metadata) → void
getRelated(artifactId, edgeTypes) → Artifact[]
traceLineage(artifactId) → LineageChain
findClusters() → ThreatCluster[]
getBlastRadius(artifactId) → Artifact[]
query(graphQuery) → QueryResult
exportGraph() → GraphData
```

---

## 5. Data Model & Graph Relationships

### Entity-Relationship Diagram

```
┌─────────────┐     spawned      ┌─────────────┐
│   Process   │─────────────────▶│   Process   │
└──────┬──────┘                  └─────────────┘
       │
       │ wrote/executed
       ▼
┌─────────────┐     points_to    ┌─────────────┐
│    File     │◀─────────────────│ RegistryKey │
└──────┬──────┘                  └─────────────┘
       │
       │ persists_via
       ▼
┌─────────────────────────────────────────────┐
│              Persistence                     │
│  ┌─────────┐ ┌─────────┐ ┌───────────────┐ │
│  │ Service │ │  Task   │ │ WMI Consumer  │ │
│  └─────────┘ └─────────┘ └───────────────┘ │
└─────────────────────────────────────────────┘
       │
       │ loads (for drivers)
       ▼
┌─────────────┐
│   Driver    │
└─────────────┘

┌─────────────┐   connected_to   ┌─────────────┐
│   Process   │─────────────────▶│  IP/Domain  │
└─────────────┘                  └─────────────┘
```

### Example Threat Cluster

```
                    ┌─────────────────────┐
                    │   malware.exe       │
                    │   (Initial Dropper) │
                    └──────────┬──────────┘
                               │ dropped
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌──────────┐     ┌──────────┐     ┌──────────┐
       │loader.dll│     │config.dat│     │ Task XML │
       └────┬─────┘     └──────────┘     └────┬─────┘
            │                                  │
            │ loaded_by                        │ triggers
            ▼                                  ▼
       ┌──────────┐                      ┌──────────┐
       │svchost   │                      │ payload  │
       │(injected)│                      │  .exe    │
       └────┬─────┘                      └────┬─────┘
            │                                  │
            │ connected_to                     │ persists_via
            ▼                                  ▼
       ┌──────────┐                      ┌──────────┐
       │ C2 Server│                      │ Run Key  │
       │1.2.3.4   │                      │(Registry)│
       └──────────┘                      └──────────┘
```

---

## 6. Detection Engines

### 6.1 Signature Engine (`src/main/detection/signature-engine.js`)

**Purpose:** Fast matching against known malware hashes and patterns.

**Data Sources:**
- SHA256 hash database (local)
- YARA-like pattern rules
- Fuzzy hash (ssdeep) for variants

**Methods:**
```javascript
checkHash(sha256) → SignatureMatch | null
scanWithRules(artifact) → RuleMatch[]
loadRules(rulePath) → void
updateDatabase(signatures) → void
```

---

### 6.2 Reputation Engine (`src/main/detection/reputation-engine.js`)

**Purpose:** Assess trustworthiness based on publisher, prevalence, age.

**Factors:**
- Digital signature validity
- Publisher reputation (Microsoft, known vendors, unknown)
- File prevalence (rare vs. common)
- File age (brand new = suspicious)
- Download source (if known)

**Output:**
```javascript
{
  reputation: 'trusted|suspicious|unknown|malicious',
  score: 75,  // 0-100
  factors: [
    { factor: 'valid_signature', impact: +30 },
    { factor: 'unknown_publisher', impact: -20 },
    { factor: 'first_seen_24h', impact: -15 },
    { factor: 'low_prevalence', impact: -10 }
  ]
}
```

---

### 6.3 Heuristic Engine (`src/main/detection/heuristic-engine.js`)

**Purpose:** Detect suspicious characteristics without known signatures.

**Heuristics:**
```javascript
const HEURISTICS = {
  // File-based
  HIGH_ENTROPY: { threshold: 7.5, weight: 20 },
  PACKED_EXECUTABLE: { indicators: ['UPX', 'Themida'], weight: 30 },
  SUSPICIOUS_LOCATION: { paths: ['%TEMP%', '%APPDATA%\\*.exe'], weight: 25 },
  DOUBLE_EXTENSION: { pattern: /\.(jpg|pdf|doc)\.(exe|scr|bat)$/i, weight: 40 },
  HIDDEN_EXECUTABLE: { attributes: ['hidden'], extension: '.exe', weight: 35 },

  // Process-based
  SUSPICIOUS_PARENT: { parent: 'explorer.exe', child: 'cmd.exe', weight: 15 },
  UNUSUAL_PATH: { process: 'svchost.exe', notIn: 'System32', weight: 50 },

  // Persistence-based
  RECENT_AUTORUN: { ageHours: 24, weight: 25 },
  OBFUSCATED_COMMAND: { patterns: ['^', 'cmd /c', 'powershell -e'], weight: 35 },
};
```

---

### 6.4 Behavior Engine (`src/main/detection/behavior-engine.js`)

**Purpose:** Detect malicious patterns from process chains and system activity.

**Behavioral Patterns:**
```javascript
const BEHAVIORS = {
  LIVING_OFF_THE_LAND: {
    description: 'Abuse of legitimate tools',
    patterns: [
      { parent: 'word.exe', child: 'powershell.exe' },
      { parent: 'excel.exe', child: 'mshta.exe' },
      { parent: 'outlook.exe', child: 'wscript.exe' }
    ],
    severity: 'high'
  },

  DEFENSE_EVASION: {
    description: 'Attempts to disable security',
    patterns: [
      { command: /Set-MpPreference.*-DisableRealtimeMonitoring/i },
      { command: /netsh.*firewall.*disable/i },
      { registry: /SOFTWARE\\Policies\\Microsoft\\Windows Defender/i }
    ],
    severity: 'critical'
  },

  PERSISTENCE_ESTABLISHMENT: {
    description: 'Creating persistence mechanisms',
    patterns: [
      { command: /schtasks.*\/create/i },
      { registry: /CurrentVersion\\Run/i, recentWrite: true }
    ],
    severity: 'high'
  }
};
```

---

### 6.5 Integrity Engine (`src/main/detection/integrity-engine.js`)

**Purpose:** Detect tampering with security features and system policies.

**Checks:**
```javascript
const INTEGRITY_CHECKS = {
  DEFENDER_STATUS: {
    check: 'Windows Defender enabled and running',
    registry: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender',
    expectedDisabled: false
  },

  UAC_STATUS: {
    check: 'UAC enabled',
    registry: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
    value: 'EnableLUA',
    expected: 1
  },

  FIREWALL_STATUS: {
    check: 'Windows Firewall enabled',
    profiles: ['Domain', 'Private', 'Public'],
    expectedEnabled: true
  },

  HOSTS_FILE: {
    check: 'Hosts file not hijacked',
    path: '%SystemRoot%\\System32\\drivers\\etc\\hosts',
    maxEntries: 10,
    blockedDomains: ['windowsupdate.com', 'microsoft.com']
  },

  SECURE_BOOT: {
    check: 'Secure Boot enabled (if supported)',
    firmware: true
  }
};
```

---

## 7. Threat Scoring Rubric

### Scoring Dimensions

Each threat is scored across four dimensions:

| Dimension | Description | Scale |
|-----------|-------------|-------|
| **Confidence** | How certain are we this is malicious? | 0-100 |
| **Impact** | How much damage can this cause? | Low/Medium/High/Critical |
| **Persistence** | How hard is it to remove permanently? | Weak/Moderate/Strong/Boot-level |
| **Stealth** | How hidden/evasive is this threat? | Visible/Hidden/Rootkit-like |

### Confidence Scoring Matrix

| Detection Method | Base Confidence |
|-----------------|-----------------|
| Known malware hash | 95 |
| YARA rule match | 85 |
| Behavioral pattern (2+ matches) | 75 |
| Heuristic (3+ triggers) | 60 |
| Single heuristic | 40 |
| Anomaly only | 25 |

**Modifiers:**
- +15: Correlated with other threats
- +10: Multiple detection engines agree
- +5: Unsigned in sensitive location
- -10: Valid signature from known vendor
- -20: Common/prevalent file

### Impact Classification

| Level | Criteria | Examples |
|-------|----------|----------|
| **Critical** | System compromise, credential theft, ransomware | Keylogger, RAT, ransomware |
| **High** | Persistence, data exfil, security bypass | Trojans, backdoors, rootkits |
| **Medium** | Unwanted behavior, privacy violation | Adware, PUPs, trackers |
| **Low** | Nuisance, minor policy violation | Toolbars, homepage hijacks |

### Persistence Strength

| Level | Criteria |
|-------|----------|
| **Boot-level** | MBR/VBR, bootkit, firmware |
| **Strong** | Driver, LSA provider, WMI permanent |
| **Moderate** | Service, scheduled task, Run key |
| **Weak** | Startup folder, browser extension |

### Stealth Rating

| Level | Criteria |
|-------|----------|
| **Rootkit-like** | Hidden processes/files, API hooking |
| **Hidden** | Hidden attributes, ADS, unusual locations |
| **Visible** | Normal file in unusual location |

### Composite Threat Score Formula

```javascript
function calculateThreatScore(threat) {
  const confidenceWeight = 0.35;
  const impactWeight = 0.30;
  const persistenceWeight = 0.20;
  const stealthWeight = 0.15;

  const impactScores = { critical: 100, high: 75, medium: 50, low: 25 };
  const persistenceScores = { boot: 100, strong: 75, moderate: 50, weak: 25 };
  const stealthScores = { rootkit: 100, hidden: 60, visible: 20 };

  return Math.round(
    threat.confidence * confidenceWeight +
    impactScores[threat.impact] * impactWeight +
    persistenceScores[threat.persistence] * persistenceWeight +
    stealthScores[threat.stealth] * stealthWeight
  );
}
```

### Threat Score Interpretation

| Score | Classification | Recommended Action |
|-------|----------------|-------------------|
| 80-100 | **Critical** | Immediate remediation required |
| 60-79 | **High** | Remediate before next reboot |
| 40-59 | **Medium** | Review and remediate |
| 20-39 | **Low** | User decision |
| 0-19 | **Suspicious** | Monitor only |

---

## 8. Complete Persistence Checklist

### Autorun Locations (Registry)

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnceEx
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunServices
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunServicesOnce
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Userinit
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Taskman
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows\AppInit_DLLs
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows\LoadAppInit_DLLs
HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\BootExecute
HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\SetupExecute
HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Execute
HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs

HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\RunServices
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\RunServicesOnce
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run
HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows\Load
HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows\Run
HKCU\Environment\UserInitMprLogonScript

# WOW64 variants (32-bit on 64-bit)
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce
```

### Services & Drivers

```
HKLM\SYSTEM\CurrentControlSet\Services\*
  - Start: 0=Boot, 1=System, 2=Auto, 3=Manual, 4=Disabled
  - Type: 1=Kernel, 2=FileSystem, 16=Service, 32=SharedService
  - ImagePath: executable path
  - ServiceDll: for svchost-hosted services

# Service DLL hijacking
HKLM\SYSTEM\CurrentControlSet\Services\<service>\Parameters\ServiceDll
```

### Scheduled Tasks

```
C:\Windows\System32\Tasks\*
C:\Windows\Tasks\*
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tasks\*
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tree\*
```

### WMI Event Subscriptions (Fileless Persistence)

```
root\subscription namespace:
  - __EventFilter
  - __EventConsumer (CommandLineEventConsumer, ActiveScriptEventConsumer)
  - __FilterToConsumerBinding

# Query: SELECT * FROM __FilterToConsumerBinding
```

### COM Object Hijacking

```
HKLM\SOFTWARE\Classes\CLSID\{GUID}\InprocServer32
HKLM\SOFTWARE\Classes\CLSID\{GUID}\LocalServer32
HKCU\SOFTWARE\Classes\CLSID\{GUID}\InprocServer32
HKCU\SOFTWARE\Classes\CLSID\{GUID}\LocalServer32

# Specific hijackable CLSIDs:
{C08AFD90-F2A1-11D1-8455-00A0C91F3880}  # Shell extension
{AB8902B4-09CA-4BB6-B78D-A8F59079A8D5}  # Thumbnail handler
{B4F3A835-0E21-4959-BA22-42B3008E02FF}  # MMC snap-in
```

### Image File Execution Options (IFEO)

```
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\<exe>\Debugger
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\<exe>\Debugger

# SilentProcessExit monitoring abuse
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SilentProcessExit\<exe>\MonitorProcess
```

### AppCert DLLs & AppInit DLLs

```
HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\AppCertDlls
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows\AppInit_DLLs
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows\LoadAppInit_DLLs
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Windows\AppInit_DLLs
```

### Security Provider Hijacking

```
HKLM\SYSTEM\CurrentControlSet\Control\SecurityProviders\SecurityProviders
HKLM\SYSTEM\CurrentControlSet\Control\Lsa\Security Packages
HKLM\SYSTEM\CurrentControlSet\Control\Lsa\Authentication Packages
HKLM\SYSTEM\CurrentControlSet\Control\Lsa\Notification Packages
HKLM\SYSTEM\CurrentControlSet\Control\NetworkProvider\Order\ProviderOrder
```

### Print Monitor DLLs

```
HKLM\SYSTEM\CurrentControlSet\Control\Print\Monitors\*\Driver
```

### Netsh Helper DLLs

```
HKLM\SOFTWARE\Microsoft\NetSh
```

### Browser Extensions & Plugins

```
# Chrome
%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\*
HKLM\SOFTWARE\Google\Chrome\Extensions\*
HKCU\SOFTWARE\Google\Chrome\Extensions\*

# Firefox
%APPDATA%\Mozilla\Firefox\Profiles\*\extensions\*

# Edge
%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Extensions\*

# IE/Legacy
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Browser Helper Objects\*
HKLM\SOFTWARE\Microsoft\Internet Explorer\Extensions\*
```

### Office Add-ins

```
HKCU\SOFTWARE\Microsoft\Office\*\*\Addins\*
HKLM\SOFTWARE\Microsoft\Office\*\*\Addins\*
%APPDATA%\Microsoft\Word\STARTUP\*
%APPDATA%\Microsoft\Excel\XLSTART\*
```

### Startup Folders

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\*
%ALLUSERSPROFILE%\Microsoft\Windows\Start Menu\Programs\Startup\*
```

### Screensaver

```
HKCU\Control Panel\Desktop\SCRNSAVE.EXE
```

### Protocol Handlers

```
HKLM\SOFTWARE\Classes\*\shell\open\command
HKCU\SOFTWARE\Classes\*\shell\open\command
```

### Boot Configuration (BCD)

```
# Query via bcdedit /enum
bootmgr
osloader
resume
```

### Group Policy Scripts

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Startup
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Shutdown
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Logon
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Logoff

%SystemRoot%\System32\GroupPolicy\Machine\Scripts\*
%SystemRoot%\System32\GroupPolicy\User\Scripts\*
```

### Terminal Services

```
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\Install\Software\Microsoft\Windows\CurrentVersion\Run
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\Install\Software\Microsoft\Windows\CurrentVersion\RunOnce
HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp\InitialProgram
```

### Active Setup

```
HKLM\SOFTWARE\Microsoft\Active Setup\Installed Components\*\StubPath
HKCU\SOFTWARE\Microsoft\Active Setup\Installed Components\*\StubPath
```

### Explorer Shell Extensions

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\ShellServiceObjectDelayLoad
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers
HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers
```

### Time Providers

```
HKLM\SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\*
```

### Font Drivers

```
HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Font Drivers
```

---

## 9. Remediation Engine

### 9.1 Remediation Stages

```
┌─────────────────────────────────────────────────────────────┐
│                    REMEDIATION PIPELINE                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ STAGE 1: QUARANTINE & CONTAIN                       │   │
│  │                                                      │   │
│  │ • Block outbound connections (optional)             │   │
│  │ • Disable suspicious autoruns (don't delete yet)    │   │
│  │ • Snapshot current state                            │   │
│  │ • Begin transaction log                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ STAGE 2: NEUTRALIZE EXECUTION                       │   │
│  │                                                      │   │
│  │ • Stop malicious services                           │   │
│  │ • Terminate malicious processes                     │   │
│  │ • Unload malicious drivers (when safe)              │   │
│  │ • Wait for file handles to release                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ STAGE 3: REMOVE PERSISTENCE                         │   │
│  │                                                      │   │
│  │ • Delete scheduled tasks                            │   │
│  │ • Delete services                                   │   │
│  │ • Remove WMI bindings                               │   │
│  │ • Clean autorun registry keys                       │   │
│  │ • Remove COM hijacks                                │   │
│  │ • Delete browser extensions                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ STAGE 4: REMOVE PAYLOADS                            │   │
│  │                                                      │   │
│  │ • Delete malware files (with retry logic)           │   │
│  │ • Remove dropped files                              │   │
│  │ • Clean alternate data streams                      │   │
│  │ • Remove rogue certificates                         │   │
│  │ • Clean browser modifications                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ STAGE 5: REPAIR & RESTORE                           │   │
│  │                                                      │   │
│  │ • Re-enable security features                       │   │
│  │ • Reset tampered policies                           │   │
│  │ • Repair network configuration                      │   │
│  │ • Restore hosts file                                │   │
│  │ • Reset proxy settings                              │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ STAGE 6: CREDENTIAL SAFETY                          │   │
│  │                                                      │   │
│  │ • Warn about potential credential theft             │   │
│  │ • Guide browser session reset                       │   │
│  │ • Recommend password changes                        │   │
│  │ • Clear cached credentials (with consent)           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 Transaction Log Format

Every remediation action is logged in a structured format:

```javascript
{
  transactionId: 'tx_abc123',
  timestamp: '2024-01-16T10:30:00Z',
  stage: 3,
  stageName: 'remove_persistence',

  action: {
    type: 'delete_registry_value',
    target: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run\\MalwareLoader',

    before: {
      exists: true,
      valueType: 'REG_SZ',
      value: 'C:\\malware\\loader.exe',
      owner: 'SYSTEM',
      lastWriteTime: '2024-01-15T10:30:00Z'
    },

    after: {
      exists: false
    },

    success: true,
    error: null
  },

  rollback: {
    possible: true,
    command: 'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" /v MalwareLoader /t REG_SZ /d "C:\\malware\\loader.exe"',
    backupPath: 'C:\\WinPurge\\quarantine\\registry\\tx_abc123.reg'
  },

  verification: {
    performed: true,
    success: true,
    method: 'registry_key_not_exists'
  }
}
```

### 9.3 Rollback Mechanism

```javascript
// Rollback registry deletion
async function rollbackRegistryDeletion(transaction) {
  if (transaction.rollback.backupPath) {
    await spawnSafe('reg', ['import', transaction.rollback.backupPath]);
  }
}

// Rollback file deletion (from quarantine)
async function rollbackFileDeletion(transaction) {
  const quarantinePath = transaction.rollback.backupPath;
  const originalPath = transaction.action.target;
  await fs.copyFile(quarantinePath, originalPath);
}

// Master rollback
async function rollbackTransaction(transactionId) {
  const transaction = await loadTransaction(transactionId);

  switch (transaction.action.type) {
    case 'delete_registry_value':
    case 'delete_registry_key':
      return rollbackRegistryDeletion(transaction);
    case 'delete_file':
    case 'quarantine_file':
      return rollbackFileDeletion(transaction);
    // ... other types
  }
}
```

---

## 10. Verification Engine

### 10.1 Verification Principles

1. **Fresh Enumeration** - Re-scan from scratch, never trust cached data
2. **Independent Methods** - Use different collection techniques than initial scan
3. **Re-creation Detection** - Monitor for immediate re-writes
4. **Post-Reboot Check** - Verify after system restart
5. **Attestation** - Generate cryptographic proof of clean state

### 10.2 Verification Checks

```javascript
const VERIFICATION_CHECKS = {
  // Persistence verification
  PERSISTENCE_REMOVED: {
    name: 'All persistence mechanisms removed',
    check: async () => {
      const persistence = await scanAllPersistence();
      const remainingThreats = persistence.filter(p =>
        threatDatabase.isKnownThreat(p)
      );
      return remainingThreats.length === 0;
    }
  },

  // Process verification
  NO_MALICIOUS_PROCESSES: {
    name: 'No malicious processes running',
    check: async () => {
      const processes = await enumerateProcesses();
      const malicious = processes.filter(p =>
        threatDatabase.isKnownThreat(p.sha256) ||
        threatDatabase.isKnownThreat(p.name)
      );
      return malicious.length === 0;
    }
  },

  // File verification
  FILES_REMOVED: {
    name: 'All malicious files removed',
    check: async (removedFiles) => {
      for (const file of removedFiles) {
        if (await fileExists(file.path)) {
          return false;
        }
      }
      return true;
    }
  },

  // Registry verification
  REGISTRY_CLEAN: {
    name: 'All malicious registry entries removed',
    check: async (removedKeys) => {
      for (const key of removedKeys) {
        if (await registryKeyExists(key.path)) {
          return false;
        }
      }
      return true;
    }
  },

  // Integrity verification
  SECURITY_RESTORED: {
    name: 'Security features restored',
    check: async () => {
      const defender = await checkDefenderStatus();
      const firewall = await checkFirewallStatus();
      const uac = await checkUacStatus();
      return defender.enabled && firewall.enabled && uac.enabled;
    }
  },

  // Re-creation detection
  NO_RECREATION: {
    name: 'No artifacts re-created within monitoring window',
    check: async (removedArtifacts, monitorDurationMs = 30000) => {
      const startTime = Date.now();
      while (Date.now() - startTime < monitorDurationMs) {
        for (const artifact of removedArtifacts) {
          if (await artifactExists(artifact)) {
            return {
              passed: false,
              recreated: artifact,
              afterMs: Date.now() - startTime
            };
          }
        }
        await sleep(1000);
      }
      return { passed: true };
    }
  }
};
```

### 10.3 Post-Reboot Verification

The app schedules a verification task to run after the next reboot:

```javascript
async function schedulePostRebootVerification(sessionId) {
  // Create a scheduled task that runs once at next logon
  const taskXml = generateVerificationTaskXml(sessionId);
  await createScheduledTask('WinPurge-PostRebootVerify', taskXml);

  // Store verification checklist
  await saveVerificationManifest(sessionId, {
    removedFiles: [...],
    removedRegistry: [...],
    removedPersistence: [...],
    expectedSecurityState: {...}
  });
}

async function runPostRebootVerification(sessionId) {
  const manifest = await loadVerificationManifest(sessionId);
  const results = await runVerificationChecks(manifest);

  // Generate verification report
  const report = generateVerificationReport(sessionId, results);

  // Notify user
  if (!results.allPassed) {
    await showNotification('WinPurge: Post-reboot verification failed', {
      body: 'Some threats may have returned. Click to review.',
      action: () => launchApp({ sessionId })
    });
  }

  // Clean up task
  await deleteScheduledTask('WinPurge-PostRebootVerify');
}
```

---

## 11. Clean Attestation Report Format

### Report Structure

```javascript
{
  report: {
    version: '2.0',
    type: 'clean_attestation',
    generated: '2024-01-16T12:00:00Z',

    system: {
      hostname: 'DESKTOP-ABC123',
      os: 'Windows 11 Pro 23H2',
      build: '22631.3085',
      architecture: 'x64',
      lastBoot: '2024-01-16T08:00:00Z'
    },

    session: {
      id: 'session_xyz789',
      startTime: '2024-01-16T10:00:00Z',
      endTime: '2024-01-16T11:30:00Z',
      mode: 'full_remediation',
      initiatedBy: 'user'
    },

    threats: {
      detected: 5,
      remediated: 5,
      remaining: 0,

      details: [
        {
          id: 'threat_001',
          name: 'Trojan.GenericKD.12345',
          category: 'trojan',
          severity: 'high',
          score: 85,

          artifacts: [
            { type: 'file', path: 'C:\\malware\\loader.exe', action: 'quarantined' },
            { type: 'registry', path: 'HKLM\\...\\Run\\Loader', action: 'deleted' },
            { type: 'task', name: 'LoaderUpdate', action: 'deleted' }
          ],

          detectionEngines: ['signature', 'heuristic'],
          remediationStatus: 'complete'
        }
        // ... more threats
      ]
    },

    actions: {
      total: 23,
      successful: 23,
      failed: 0,

      byCategory: {
        process_termination: 3,
        service_stop: 2,
        file_quarantine: 5,
        file_deletion: 3,
        registry_deletion: 8,
        task_deletion: 2
      }
    },

    verification: {
      preReboot: {
        performed: true,
        timestamp: '2024-01-16T11:25:00Z',
        allPassed: true,

        checks: [
          { name: 'persistence_removed', passed: true },
          { name: 'files_removed', passed: true },
          { name: 'registry_clean', passed: true },
          { name: 'no_malicious_processes', passed: true },
          { name: 'security_restored', passed: true },
          { name: 'no_recreation_30s', passed: true }
        ]
      },

      postReboot: {
        performed: true,
        timestamp: '2024-01-16T12:00:00Z',
        allPassed: true,

        checks: [
          { name: 'persistence_still_clean', passed: true },
          { name: 'files_still_removed', passed: true },
          { name: 'no_new_threats', passed: true }
        ]
      }
    },

    integrity: {
      defenderStatus: 'enabled',
      firewallStatus: 'enabled',
      uacStatus: 'enabled',
      secureBootStatus: 'enabled',
      tamperProtection: 'enabled'
    },

    attestation: {
      status: 'CLEAN',
      confidence: 'high',

      statement: 'System has been verified clean of detected threats. All persistence mechanisms removed. Security features operational. Post-reboot verification passed.',

      caveats: [
        'Cannot guarantee absence of unknown/zero-day threats',
        'Memory-only threats cleared by reboot, not directly verified',
        'Firmware/UEFI integrity not verified'
      ],

      recommendations: [
        'Change passwords for accounts used on this system',
        'Enable monitoring mode to detect re-infection',
        'Review recent browser downloads for potential re-infection vectors'
      ]
    },

    artifacts: {
      logFile: 'C:\\WinPurge\\logs\\session_xyz789.log',
      quarantineFolder: 'C:\\WinPurge\\quarantine\\session_xyz789\\',
      transactionLog: 'C:\\WinPurge\\transactions\\session_xyz789.json'
    }
  },

  signature: {
    algorithm: 'sha256',
    hash: 'abc123def456...',
    signedAt: '2024-01-16T12:00:00Z'
  }
}
```

### Report Summary View (Human-Readable)

```
╔══════════════════════════════════════════════════════════════════════╗
║                    WINPURGE CLEAN ATTESTATION REPORT                 ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  System: DESKTOP-ABC123                                              ║
║  OS: Windows 11 Pro 23H2 (Build 22631.3085)                         ║
║  Session: 2024-01-16 10:00 - 11:30                                  ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                           THREAT SUMMARY                             ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  Detected: 5 threats                                                 ║
║  Remediated: 5 threats                                               ║
║  Remaining: 0 threats                                                ║
║                                                                      ║
║  ┌────────────────────────────────────────────────────────────────┐ ║
║  │ THREAT                        │ SEVERITY │ STATUS              │ ║
║  ├────────────────────────────────────────────────────────────────┤ ║
║  │ Trojan.GenericKD.12345        │ HIGH     │ ✓ Remediated        │ ║
║  │ PUP.Adware.BrowserHijack      │ MEDIUM   │ ✓ Remediated        │ ║
║  │ Persistence.SuspiciousTask    │ MEDIUM   │ ✓ Remediated        │ ║
║  │ Trojan.AgentTesla.variant     │ HIGH     │ ✓ Remediated        │ ║
║  │ PolicyTamper.DefenderDisable  │ HIGH     │ ✓ Repaired          │ ║
║  └────────────────────────────────────────────────────────────────┘ ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                          VERIFICATION STATUS                         ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  Pre-Reboot Verification:  ✓ PASSED (6/6 checks)                    ║
║  Post-Reboot Verification: ✓ PASSED (3/3 checks)                    ║
║                                                                      ║
║  System Integrity:                                                   ║
║    Windows Defender:    ✓ Enabled                                   ║
║    Windows Firewall:    ✓ Enabled                                   ║
║    UAC:                 ✓ Enabled                                   ║
║    Secure Boot:         ✓ Enabled                                   ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                          ATTESTATION STATUS                          ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  ████████████████████████████████████████████████████████████████   ║
║  ██                                                              ██   ║
║  ██              ✓ SYSTEM VERIFIED CLEAN                        ██   ║
║  ██                                                              ██   ║
║  ██  Confidence: HIGH                                           ██   ║
║  ██                                                              ██   ║
║  ████████████████████████████████████████████████████████████████   ║
║                                                                      ║
║  Statement:                                                          ║
║  System has been verified clean of detected threats. All             ║
║  persistence mechanisms removed. Security features operational.      ║
║  Post-reboot verification passed.                                    ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                          RECOMMENDATIONS                             ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  1. Change passwords for accounts used on this system               ║
║  2. Enable monitoring mode to detect re-infection                   ║
║  3. Review recent browser downloads for potential re-infection      ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                             CAVEATS                                  ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  • Cannot guarantee absence of unknown/zero-day threats             ║
║  • Memory-only threats cleared by reboot, not directly verified     ║
║  • Firmware/UEFI integrity not verified                             ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

Report Hash: abc123def456...
Generated: 2024-01-16 12:00:00 UTC
```

---

## 12. Hardening & Monitoring

### 12.1 Baseline Snapshot

After successful remediation and verification, capture a "known-good" baseline:

```javascript
const baseline = {
  timestamp: '2024-01-16T12:00:00Z',
  sessionId: 'session_xyz789',

  persistence: {
    // All current autoruns, services, tasks (considered clean)
    autoruns: [...],
    services: [...],
    scheduledTasks: [...],
    wmiSubscriptions: [...],
    drivers: [...]
  },

  configuration: {
    // Security settings
    defenderConfig: {...},
    firewallRules: [...],
    uacLevel: 'default',

    // Network settings
    dnsServers: [...],
    proxySettings: null,
    hostsFileHash: 'abc123...',

    // Certificates
    trustedRootCAs: [...]
  },

  fileHashes: {
    // Critical system files
    'C:\\Windows\\System32\\cmd.exe': 'hash...',
    'C:\\Windows\\System32\\powershell.exe': 'hash...',
    // ... other critical files
  }
};
```

### 12.2 Change Monitor

Background service that watches for deviations from baseline:

```javascript
const MONITOR_EVENTS = {
  NEW_AUTORUN: {
    severity: 'high',
    action: 'alert_user',
    check: () => compareAutoruns(baseline.persistence.autoruns)
  },

  NEW_SERVICE: {
    severity: 'high',
    action: 'alert_user',
    check: () => compareServices(baseline.persistence.services)
  },

  NEW_SCHEDULED_TASK: {
    severity: 'medium',
    action: 'alert_user',
    check: () => compareTasks(baseline.persistence.scheduledTasks)
  },

  NEW_DRIVER: {
    severity: 'critical',
    action: 'alert_user_immediate',
    check: () => compareDrivers(baseline.persistence.drivers)
  },

  SECURITY_POLICY_CHANGE: {
    severity: 'high',
    action: 'alert_user',
    check: () => compareSecurityConfig(baseline.configuration)
  },

  DNS_CHANGE: {
    severity: 'medium',
    action: 'alert_user',
    check: () => compareDns(baseline.configuration.dnsServers)
  },

  NEW_ROOT_CA: {
    severity: 'critical',
    action: 'alert_user_immediate',
    check: () => compareCertificates(baseline.configuration.trustedRootCAs)
  },

  HOSTS_FILE_MODIFIED: {
    severity: 'medium',
    action: 'alert_user',
    check: () => compareHostsFile(baseline.configuration.hostsFileHash)
  }
};
```

### 12.3 Alert UI

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️  WinPurge Alert: New Persistence Detected                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ A new autorun entry was added since your last baseline:     │
│                                                             │
│ Location: HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run│
│ Name: SuspiciousApp                                         │
│ Value: C:\Users\Alex\AppData\Local\Temp\suspicious.exe      │
│                                                             │
│ First seen: 2024-01-17 14:30:00                            │
│ File signature: Unsigned                                    │
│ File reputation: Unknown                                    │
│                                                             │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐│
│ │ Investigate │ │   Ignore    │ │ Add to Baseline (Trust) ││
│ └─────────────┘ └─────────────┘ └─────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## 13. Anti-Evasion Precautions

### 13.1 Collection Redundancy

For critical checks, use multiple collection methods:

```javascript
async function getProcessListRedundant() {
  const results = {
    wmi: await getProcessesViaWmi(),
    psapi: await getProcessesViaPsapi(),
    ntquery: await getProcessesViaNtQuery(),
    tasklist: await getProcessesViaTasklist()
  };

  // Cross-validate
  const allPids = new Set([
    ...results.wmi.map(p => p.pid),
    ...results.psapi.map(p => p.pid),
    ...results.ntquery.map(p => p.pid),
    ...results.tasklist.map(p => p.pid)
  ]);

  // Flag discrepancies (potential hidden processes)
  const discrepancies = [];
  for (const pid of allPids) {
    const seenIn = [];
    if (results.wmi.find(p => p.pid === pid)) seenIn.push('wmi');
    if (results.psapi.find(p => p.pid === pid)) seenIn.push('psapi');
    if (results.ntquery.find(p => p.pid === pid)) seenIn.push('ntquery');
    if (results.tasklist.find(p => p.pid === pid)) seenIn.push('tasklist');

    if (seenIn.length < 4) {
      discrepancies.push({ pid, seenIn, notSeenIn: ['wmi', 'psapi', 'ntquery', 'tasklist'].filter(m => !seenIn.includes(m)) });
    }
  }

  return { processes: mergeProcessLists(results), discrepancies };
}
```

### 13.2 Integrity Self-Check

On startup, verify app integrity:

```javascript
async function verifySelfIntegrity() {
  const checks = {
    // Verify our own binaries haven't been tampered
    binaryIntegrity: await verifyBinaryHashes(),

    // Check we're not being debugged
    debuggerPresent: await checkDebuggerPresent(),

    // Verify our config hasn't been tampered
    configIntegrity: await verifyConfigSignature(),

    // Check our process isn't hooked
    importTableIntegrity: await verifyImportTable()
  };

  if (!checks.binaryIntegrity) {
    throw new Error('App binaries have been modified. Please reinstall.');
  }

  if (checks.debuggerPresent) {
    logger.warn('Debugger detected. Some checks may be affected.');
  }

  return checks;
}
```

### 13.3 Offline Mode Trigger

Automatically recommend offline mode when indicators suggest rootkit:

```javascript
const OFFLINE_MODE_TRIGGERS = [
  'hidden_process_detected',
  'api_hooking_detected',
  'driver_load_blocked',
  'file_delete_fails_repeatedly',
  'registry_delete_recreates_immediately'
];

function shouldRecommendOfflineMode(findings) {
  const triggers = findings.filter(f =>
    OFFLINE_MODE_TRIGGERS.includes(f.indicator)
  );

  if (triggers.length >= 2) {
    return {
      recommend: true,
      reason: 'Multiple indicators suggest advanced threat that may evade live-mode remediation',
      triggers: triggers
    };
  }

  return { recommend: false };
}
```

---

## 14. Safety & Abuse Prevention

### 14.1 User Consent Requirements

```javascript
const CONSENT_REQUIREMENTS = {
  // Requires explicit user consent
  HIGH_IMPACT: [
    'delete_system_file',
    'modify_boot_config',
    'clear_all_credentials',
    'disable_security_feature',
    'modify_firewall'
  ],

  // Requires confirmation
  MEDIUM_IMPACT: [
    'quarantine_file',
    'delete_registry_key',
    'stop_service',
    'delete_scheduled_task'
  ],

  // Can proceed with session consent
  LOW_IMPACT: [
    'terminate_process',
    'disable_autorun'
  ]
};
```

### 14.2 Pre-Action Review

Before any destructive action, show user exactly what will happen:

```
┌─────────────────────────────────────────────────────────────┐
│               REVIEW REMEDIATION ACTIONS                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ The following actions will be taken:                        │
│                                                             │
│ ⚠️  HIGH IMPACT (requires your approval):                   │
│    None                                                     │
│                                                             │
│ 🟡 MEDIUM IMPACT:                                           │
│    • Quarantine: C:\malware\loader.exe                     │
│    • Delete registry: HKLM\...\Run\MalwareLoader           │
│    • Delete task: \MalwareUpdate                           │
│                                                             │
│ 🟢 LOW IMPACT:                                              │
│    • Terminate process: loader.exe (PID 1234)              │
│    • Disable autorun: HKCU\...\Run\Suspicious              │
│                                                             │
│ Files will be quarantined to:                              │
│ C:\WinPurge\quarantine\session_xyz789\                      │
│                                                             │
│ A transaction log will be created for rollback if needed.   │
│                                                             │
│ ┌────────────────────────┐ ┌──────────────────────────────┐│
│ │ Proceed with Cleanup   │ │ Cancel and Review Detections ││
│ └────────────────────────┘ └──────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 14.3 Audit Log Protection

```javascript
// Audit logs are append-only and protected
const auditLog = {
  path: 'C:\\WinPurge\\audit\\audit.log',

  // Cryptographic chain
  previousHash: null,

  append: async function(entry) {
    entry.timestamp = new Date().toISOString();
    entry.previousHash = this.previousHash;
    entry.hash = sha256(JSON.stringify(entry));

    await fs.appendFile(this.path, JSON.stringify(entry) + '\n');
    this.previousHash = entry.hash;
  },

  // Verify integrity
  verifyChain: async function() {
    const lines = await fs.readFile(this.path, 'utf8');
    const entries = lines.split('\n').filter(Boolean).map(JSON.parse);

    let expectedPrevHash = null;
    for (const entry of entries) {
      if (entry.previousHash !== expectedPrevHash) {
        return { valid: false, brokenAt: entry };
      }
      expectedPrevHash = entry.hash;
    }
    return { valid: true };
  }
};
```

---

## 15. Migration Path from 1132-Remover

### Phase 1: Foundation (4-6 weeks)

**Goal:** Refactor existing code into new architecture while maintaining Zoom cleanup functionality.

**Tasks:**
1. Create acquisition layer abstraction
2. Migrate `process-killer.js` → `acquisition/process-scanner.js`
3. Migrate `registry.js` → `acquisition/registry-scanner.js`
4. Migrate `folders.js` → `acquisition/filesystem-scanner.js`
5. Implement unified artifact model
6. Add transaction logging to remediation
7. Implement verification engine

**Deliverable:** v2.0-alpha - Zoom cleanup with new architecture

### Phase 2: Expansion (4-6 weeks)

**Goal:** Expand beyond Zoom to general threat detection.

**Tasks:**
1. Implement full persistence scanner (all mechanisms)
2. Implement detection engines (signature, heuristic, behavior)
3. Build correlation/graph engine
4. Add threat scoring
5. Implement staged remediation pipeline
6. Add pre-action review UI

**Deliverable:** v2.0-beta - General remediation capability

### Phase 3: Hardening (3-4 weeks)

**Goal:** Add verification, monitoring, and safety features.

**Tasks:**
1. Implement post-reboot verification
2. Add baseline snapshot feature
3. Implement change monitor
4. Add collection redundancy (anti-evasion)
5. Implement self-integrity checks
6. Add clean attestation report

**Deliverable:** v2.0-rc - Feature complete

### Phase 4: Polish (2-3 weeks)

**Goal:** Quality, documentation, release prep.

**Tasks:**
1. Comprehensive testing
2. False positive tuning
3. UI/UX polish
4. Documentation
5. Installer/updater
6. Release

**Deliverable:** v2.0 - Production release

---

## 16. Testing Strategy

### 16.1 Test Categories

| Category | Description | Tools |
|----------|-------------|-------|
| **Unit** | Individual function testing | Jest |
| **Integration** | Module interaction | Jest + Windows VMs |
| **Detection** | False positive/negative rates | Benign samples + malware zoo |
| **Remediation** | Cleanup completeness | Simulated persistence |
| **Regression** | Prevent bug recurrence | Automated suite |
| **Performance** | Scan speed, memory usage | Benchmarks |

### 16.2 Detection Testing Matrix

```
┌─────────────────────────────────────────────────────────────┐
│                 DETECTION TEST MATRIX                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Persistence Type          │ Simulated │ Detected │ Removed │
│ ─────────────────────────────────────────────────────────── │
│ Run key (HKLM)            │    ✓      │    ✓     │    ✓    │
│ Run key (HKCU)            │    ✓      │    ✓     │    ✓    │
│ RunOnce                   │    ✓      │    ✓     │    ✓    │
│ Scheduled Task            │    ✓      │    ✓     │    ✓    │
│ Service                   │    ✓      │    ✓     │    ✓    │
│ WMI Subscription          │    ✓      │    ✓     │    ✓    │
│ COM Hijack                │    ✓      │    ✓     │    ✓    │
│ AppInit DLL               │    ✓      │    ✓     │    ✓    │
│ IFEO Debugger             │    ✓      │    ✓     │    ✓    │
│ Startup Folder            │    ✓      │    ✓     │    ✓    │
│ Browser Extension         │    ✓      │    ✓     │    ✓    │
│ ...                       │    ...    │    ...   │    ...  │
│ ─────────────────────────────────────────────────────────── │
│ Coverage: 47/50 mechanisms (94%)                           │
└─────────────────────────────────────────────────────────────┘
```

### 16.3 Quality Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| False Positive Rate | < 1% | % of benign software flagged |
| False Negative Rate | < 5% | % of known threats missed |
| Remediation Success | > 99% | % of threats fully removed |
| Post-Reboot Relapse | 0% | % of threats returning after reboot |
| Scan Performance | < 5 min | Full system scan time |
| Memory Usage | < 200 MB | Peak during scan |

---

## Appendix A: File Structure

```
src/
├── main/
│   ├── index.js                    # Entry point
│   ├── ipc-handlers.js             # IPC communication
│   │
│   ├── acquisition/                # Data collection layer
│   │   ├── filesystem-scanner.js
│   │   ├── registry-scanner.js
│   │   ├── process-scanner.js
│   │   ├── persistence-scanner.js
│   │   ├── network-scanner.js
│   │   └── credential-scanner.js
│   │
│   ├── normalization/              # Unified data model
│   │   └── artifact-model.js
│   │
│   ├── correlation/                # Graph engine
│   │   └── graph-engine.js
│   │
│   ├── detection/                  # Threat detection
│   │   ├── signature-engine.js
│   │   ├── reputation-engine.js
│   │   ├── heuristic-engine.js
│   │   ├── behavior-engine.js
│   │   ├── integrity-engine.js
│   │   └── threat-scorer.js
│   │
│   ├── remediation/                # Cleanup engine
│   │   ├── remediation-engine.js
│   │   ├── transaction-log.js
│   │   └── rollback-manager.js
│   │
│   ├── verification/               # Verification engine
│   │   ├── verification-engine.js
│   │   ├── post-reboot-verifier.js
│   │   └── attestation-generator.js
│   │
│   ├── hardening/                  # Protection layer
│   │   ├── baseline-manager.js
│   │   └── change-monitor.js
│   │
│   ├── operations/                 # Legacy (migrate gradually)
│   │   ├── process-killer.js
│   │   ├── registry.js
│   │   ├── folders.js
│   │   ├── services.js
│   │   ├── fingerprint.js
│   │   ├── uninstaller.js
│   │   ├── installer.js
│   │   └── pref-manager.js
│   │
│   └── utils/
│       ├── spawn-safe.js
│       ├── logger.js
│       └── self-integrity.js
│
├── renderer/                       # UI layer
│   ├── index.html
│   ├── styles/
│   └── scripts/
│
├── shared/
│   └── constants.js                # Shared configuration
│
└── data/
    ├── signatures/                 # Threat signatures
    ├── rules/                      # Detection rules
    └── baselines/                  # User baselines
```

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **Artifact** | Any observable item (file, registry key, process, etc.) |
| **Persistence** | Mechanism that survives reboot |
| **Remediation** | Process of removing threats |
| **Verification** | Independent confirmation of remediation success |
| **Attestation** | Formal statement of system cleanliness |
| **Baseline** | Known-good system state snapshot |
| **Quarantine** | Isolated storage for suspicious files |
| **Relapse** | Threat returning after remediation |

---

*End of PRD*
