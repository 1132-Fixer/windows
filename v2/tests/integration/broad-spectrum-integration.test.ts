/**
 * Broad-Spectrum Scanners Integration Tests
 *
 * End-to-end tests for the scanner ecosystem.
 * Tests real system scanning and data correlation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { ProductDefinition, ScanContext } from '../../src/main/core/acquisition/types';
import {
  createAllScanners,
  createVendorScanners,
  createSystemScanners,
} from '../../src/main/core/acquisition/scanners';

// Zoom-like product definition for realistic testing
const zoomProduct: ProductDefinition = {
  id: 'zoom',
  vendor: 'Zoom Video Communications',
  displayName: 'Zoom',
  paths: {
    install: [
      '%APPDATA%\\Zoom',
      '%LOCALAPPDATA%\\Zoom',
      '%PROGRAMFILES%\\Zoom',
      '%PROGRAMFILES(X86)%\\Zoom',
    ],
    appData: [
      '%APPDATA%\\Zoom',
      '%LOCALAPPDATA%\\Zoom',
    ],
    programData: [
      '%PROGRAMDATA%\\Zoom',
    ],
    logs: [],
    temp: [],
  },
  registry: {
    software: [
      'HKCU\\SOFTWARE\\Zoom',
      'HKLM\\SOFTWARE\\Zoom',
    ],
    uninstall: [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom',
    ],
    services: [],
    other: [],
  },
  processes: ['Zoom.exe', 'ZoomWebHost.exe', 'ZoomOutlookIMPlugin.exe'],
  services: ['ZoomCptService'],
  tasks: ['\\Zoom\\'],
};

const zoomContext: ScanContext = {
  product: zoomProduct,
  includeAllUsers: false,
  now: Date.now(),
};

describe('Broad-Spectrum Scanner Integration', () => {
  describe('Scanner Factory Functions', () => {
    it('should create all vendor scanners', () => {
      const scanners = createVendorScanners();

      expect(scanners).toHaveProperty('filesystem');
      expect(scanners).toHaveProperty('registry');
      expect(scanners).toHaveProperty('process');
      expect(scanners).toHaveProperty('service');
      expect(scanners).toHaveProperty('task');
      expect(scanners).toHaveProperty('wmi');
    });

    it('should create all system scanners', () => {
      const scanners = createSystemScanners();

      expect(scanners).toHaveProperty('network');
      expect(scanners).toHaveProperty('defender');
    });

    it('should create all scanners', () => {
      const scanners = createAllScanners();

      expect(Object.keys(scanners)).toHaveLength(8);
      expect(scanners).toHaveProperty('filesystem');
      expect(scanners).toHaveProperty('registry');
      expect(scanners).toHaveProperty('process');
      expect(scanners).toHaveProperty('service');
      expect(scanners).toHaveProperty('task');
      expect(scanners).toHaveProperty('wmi');
      expect(scanners).toHaveProperty('network');
      expect(scanners).toHaveProperty('defender');
    });
  });

  describe('Full System Scan', () => {
    it('should run all scanners concurrently', async () => {
      const scanners = createAllScanners();

      const startTime = Date.now();

      // Run all scans in parallel
      const [
        processArtifacts,
        serviceArtifacts,
        taskArtifacts,
        wmiArtifacts,
        networkArtifacts,
        defenderArtifacts,
      ] = await Promise.all([
        scanners.process.scan(zoomContext),
        scanners.service.scan(zoomContext),
        scanners.task.scan(zoomContext),
        scanners.wmi.scan(zoomContext),
        scanners.network.scan(zoomContext),
        scanners.defender.scan(zoomContext),
      ]);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // All should return arrays
      expect(Array.isArray(processArtifacts)).toBe(true);
      expect(Array.isArray(serviceArtifacts)).toBe(true);
      expect(Array.isArray(taskArtifacts)).toBe(true);
      expect(Array.isArray(wmiArtifacts)).toBe(true);
      expect(Array.isArray(networkArtifacts)).toBe(true);
      expect(Array.isArray(defenderArtifacts)).toBe(true);

      // Defender should always return exactly one artifact
      expect(defenderArtifacts).toHaveLength(1);

      // Log scan duration for performance monitoring
      console.log(`Full scan completed in ${duration}ms`);
      console.log(`- Processes: ${processArtifacts.length} matching`);
      console.log(`- Services: ${serviceArtifacts.length} matching`);
      console.log(`- Tasks: ${taskArtifacts.length} matching`);
      console.log(`- WMI: ${wmiArtifacts.length} matching`);
      console.log(`- Network: ${networkArtifacts.length} configs`);
      console.log(`- Defender: ${defenderArtifacts[0]?.metadata?.overallStatus || 'unknown'}`);
    });
  });

  describe('Process-Service-Task Correlation', () => {
    it('should find related artifacts by path', async () => {
      const scanners = createVendorScanners();

      // Get all potential artifacts
      const processes = await scanners.process.getProcessTree();
      const services = await scanners.service.getAllServices();
      const tasks = await scanners.task.getAllTasks();

      // Find common paths (simplified correlation)
      const processPaths = new Set(
        processes
          .filter(p => p.executablePath)
          .map(p => p.executablePath!.toLowerCase())
      );

      const servicePaths = new Set(
        services
          .filter(s => s.binaryPath)
          .map(s => {
            // Extract executable from service binary path
            let path = s.binaryPath;
            if (path.startsWith('"')) {
              path = path.slice(1, path.indexOf('"', 1));
            }
            return path.toLowerCase();
          })
      );

      const taskPaths = new Set(
        tasks
          .flatMap(t => t.actions)
          .filter(a => a.path)
          .map(a => a.path!.toLowerCase())
      );

      // Verify we can extract paths
      expect(processPaths.size).toBeGreaterThan(0);
      // Services may or may not exist for the test product

      // This demonstrates the correlation capability
      console.log(`Found ${processPaths.size} unique process paths`);
      console.log(`Found ${servicePaths.size} unique service paths`);
      console.log(`Found ${taskPaths.size} unique task action paths`);
    });
  });

  describe('Security State Assessment', () => {
    it('should detect Defender state', async () => {
      const scanner = createSystemScanners().defender;
      const state = await scanner.getFullState();

      // Log current security state
      console.log('Defender State:');
      console.log(`- Real-time Protection: ${state.realTimeProtectionEnabled}`);
      console.log(`- Behavior Monitor: ${state.behaviorMonitorEnabled}`);
      console.log(`- Antivirus: ${state.antivirusEnabled}`);
      console.log(`- Tamper Protection: ${state.tamperProtectionEnabled}`);
      console.log(`- Exclusions: ${state.exclusions.length}`);
      console.log(`- Recent Threats: ${state.threatCount}`);
      console.log(`- Suspicious Indicators: ${state.suspiciousIndicators.length}`);

      // Verify structure
      expect(typeof state.realTimeProtectionEnabled).toBe('boolean');
      expect(Array.isArray(state.exclusions)).toBe(true);
      expect(Array.isArray(state.suspiciousIndicators)).toBe(true);
    });

    it('should detect network configuration', async () => {
      const scanner = createSystemScanners().network;
      const config = await scanner.getFullConfiguration();

      console.log('Network Configuration:');
      console.log(`- Proxy configurations: ${config.proxies.length}`);
      console.log(`- DNS configurations: ${config.dnsSettings.length}`);
      console.log(`- Non-standard hosts entries: ${config.hostsEntries.length}`);
      console.log(`- Suspicious Indicators: ${config.suspiciousIndicators.length}`);

      if (config.suspiciousIndicators.length > 0) {
        console.log('Suspicious indicators found:');
        config.suspiciousIndicators.forEach(i => console.log(`  - ${i}`));
      }

      // Verify structure
      expect(Array.isArray(config.proxies)).toBe(true);
      expect(Array.isArray(config.dnsSettings)).toBe(true);
      expect(Array.isArray(config.hostsEntries)).toBe(true);
    });

    it('should detect WMI persistence', async () => {
      const scanner = createVendorScanners().wmi;
      const subs = await scanner.getAllSubscriptions();

      console.log('WMI Subscriptions:');
      console.log(`- Event Filters: ${subs.filters.length}`);
      console.log(`- Event Consumers: ${subs.consumers.length}`);
      console.log(`- Filter-Consumer Bindings: ${subs.bindings.length}`);

      // On a clean system, these should typically be empty
      // Presence of unexpected subscriptions is suspicious
      if (subs.filters.length > 0 || subs.consumers.length > 0) {
        console.log('WMI subscriptions detected (may need investigation):');
        subs.filters.forEach(f => console.log(`  Filter: ${f.name}`));
        subs.consumers.forEach(c => console.log(`  Consumer: ${c.name} (${c.consumerType})`));
      }

      // Verify structure
      expect(Array.isArray(subs.filters)).toBe(true);
      expect(Array.isArray(subs.consumers)).toBe(true);
      expect(Array.isArray(subs.bindings)).toBe(true);
    });
  });

  describe('Artifact Schema Compliance', () => {
    it('process artifacts should have required fields', async () => {
      const scanner = createVendorScanners().process;
      const artifacts = await scanner.scan(zoomContext);

      for (const artifact of artifacts) {
        expect(artifact).toHaveProperty('id');
        expect(artifact).toHaveProperty('type');
        expect(artifact).toHaveProperty('owner');
        expect(artifact).toHaveProperty('metadata');
        expect(artifact).toHaveProperty('observedAt');
        expect(artifact).toHaveProperty('source');

        expect(artifact.type).toBe('process');
        expect(artifact.source).toBe('process');
        expect(artifact.owner).toHaveProperty('vendor');
        expect(artifact.owner).toHaveProperty('product');
        expect(artifact.owner).toHaveProperty('confidence');

        expect(artifact.metadata).toHaveProperty('pid');
        expect(artifact.metadata).toHaveProperty('name');
      }
    });

    it('service artifacts should have required fields', async () => {
      const scanner = createVendorScanners().service;
      const artifacts = await scanner.scan(zoomContext);

      for (const artifact of artifacts) {
        expect(artifact.type).toBe('service');
        expect(artifact.source).toBe('service');
        expect(artifact.metadata).toHaveProperty('name');
        expect(artifact.metadata).toHaveProperty('displayName');
        expect(artifact.metadata).toHaveProperty('binaryPath');
        expect(artifact.metadata).toHaveProperty('startType');
        expect(artifact.metadata).toHaveProperty('currentState');
      }
    });

    it('task artifacts should have required fields', async () => {
      const scanner = createVendorScanners().task;
      const artifacts = await scanner.scan(zoomContext);

      for (const artifact of artifacts) {
        expect(artifact.type).toBe('task');
        expect(artifact.source).toBe('task');
        expect(artifact.metadata).toHaveProperty('name');
        expect(artifact.metadata).toHaveProperty('path');
        expect(artifact.metadata).toHaveProperty('enabled');
        expect(artifact.metadata).toHaveProperty('state');
        expect(artifact.metadata).toHaveProperty('actions');
        expect(artifact.metadata).toHaveProperty('triggers');
      }
    });

    it('defender artifact should have required fields', async () => {
      const scanner = createSystemScanners().defender;
      const artifacts = await scanner.scan(zoomContext);

      expect(artifacts).toHaveLength(1);
      const artifact = artifacts[0];

      expect(artifact.type).toBe('defender_state');
      expect(artifact.metadata).toHaveProperty('state');
      expect(artifact.metadata).toHaveProperty('overallStatus');
      expect(artifact.metadata).toHaveProperty('suspiciousIndicators');

      expect(['healthy', 'degraded', 'compromised', 'unknown']).toContain(
        artifact.metadata.overallStatus
      );
    });
  });

  describe('Performance Benchmarks', () => {
    it('should complete individual scans within reasonable time', async () => {
      const scanners = createAllScanners();
      const maxDuration = 30000; // 30 seconds max per scanner

      // Process scanner
      const processStart = Date.now();
      await scanners.process.scan(zoomContext);
      const processDuration = Date.now() - processStart;
      expect(processDuration).toBeLessThan(maxDuration);

      // Service scanner
      const serviceStart = Date.now();
      await scanners.service.scan(zoomContext);
      const serviceDuration = Date.now() - serviceStart;
      expect(serviceDuration).toBeLessThan(maxDuration);

      // Task scanner
      const taskStart = Date.now();
      await scanners.task.scan(zoomContext);
      const taskDuration = Date.now() - taskStart;
      expect(taskDuration).toBeLessThan(maxDuration);

      // Defender scanner
      const defenderStart = Date.now();
      await scanners.defender.scan(zoomContext);
      const defenderDuration = Date.now() - defenderStart;
      expect(defenderDuration).toBeLessThan(maxDuration);

      console.log('Scan durations:');
      console.log(`- Process: ${processDuration}ms`);
      console.log(`- Service: ${serviceDuration}ms`);
      console.log(`- Task: ${taskDuration}ms`);
      console.log(`- Defender: ${defenderDuration}ms`);
    });
  });
});
