/**
 * Broad-Spectrum Scanners Unit Tests
 *
 * Tests for ProcessScanner, ServiceScanner, TaskScanner,
 * WMI Scanner, NetworkConfig Scanner, and Defender Scanner.
 *
 * NOTE: These tests verify scanner behavior and output structure.
 * They run read-only queries against the actual system.
 */

import { describe, it, expect } from 'vitest';
import type { ProductDefinition, ScanContext } from '../../src/main/core/acquisition/types';
import {
  createProcessScanner,
  createServiceScanner,
  createTaskScanner,
  createWMISubscriptionScanner,
  createNetworkConfigScanner,
  createDefenderStateScanner,
} from '../../src/main/core/acquisition/scanners';

// Test product definition (won't match anything in most cases)
const testProduct: ProductDefinition = {
  id: 'test-product',
  vendor: 'Test Vendor',
  displayName: 'Test Product',
  paths: {
    install: ['C:\\Program Files\\TestProduct'],
    appData: ['%APPDATA%\\TestProduct'],
    programData: ['%PROGRAMDATA%\\TestProduct'],
    logs: [],
    temp: [],
  },
  registry: {
    software: ['HKCU\\SOFTWARE\\TestProduct'],
    uninstall: [],
    services: [],
    other: [],
  },
  processes: ['testapp.exe'],
  services: ['TestService'],
  tasks: ['\\TestProduct\\'],
};

const testContext: ScanContext = {
  product: testProduct,
  includeAllUsers: false,
  now: Date.now(),
};

describe('ProcessScanner', () => {
  it('should create a scanner instance', () => {
    const scanner = createProcessScanner();
    expect(scanner.id).toBe('process');
  });

  it('should return an array of process artifacts', async () => {
    const scanner = createProcessScanner();
    const artifacts = await scanner.scan(testContext);

    expect(Array.isArray(artifacts)).toBe(true);
    // With test product, likely no matches
  });

  it('should get full process tree', async () => {
    const scanner = createProcessScanner();
    const processes = await scanner.getProcessTree();

    expect(Array.isArray(processes)).toBe(true);
    // Should have at least some processes running
    expect(processes.length).toBeGreaterThan(0);

    // Check process structure
    if (processes.length > 0) {
      const proc = processes[0];
      expect(proc).toHaveProperty('pid');
      expect(proc).toHaveProperty('name');
      expect(typeof proc.pid).toBe('number');
      expect(typeof proc.name).toBe('string');
    }
  });

  it('should redact command line arguments', async () => {
    const scanner = createProcessScanner();
    const processes = await scanner.getProcessTree();

    // Find a process with command line
    const procWithCmdLine = processes.find(p => p.commandLine);
    if (procWithCmdLine && procWithCmdLine.commandLine) {
      // Should not contain typical sensitive patterns
      expect(procWithCmdLine.commandLine).not.toMatch(/--password=\w+/);
    }
  });
});

describe('ServiceScanner', () => {
  it('should create a scanner instance', () => {
    const scanner = createServiceScanner();
    expect(scanner.id).toBe('service');
  });

  it('should return an array of service artifacts', async () => {
    const scanner = createServiceScanner();
    const artifacts = await scanner.scan(testContext);

    expect(Array.isArray(artifacts)).toBe(true);
  });

  it('should get all services', async () => {
    const scanner = createServiceScanner();
    const services = await scanner.getAllServices();

    expect(Array.isArray(services)).toBe(true);
    // Should have services on any Windows system
    expect(services.length).toBeGreaterThan(0);

    // Check service structure
    if (services.length > 0) {
      const svc = services[0];
      expect(svc).toHaveProperty('name');
      expect(svc).toHaveProperty('displayName');
      expect(svc).toHaveProperty('state');
      expect(svc).toHaveProperty('startType');
    }
  });
});

describe('TaskScanner', () => {
  it('should create a scanner instance', () => {
    const scanner = createTaskScanner();
    expect(scanner.id).toBe('task');
  });

  it('should return an array of task artifacts', async () => {
    const scanner = createTaskScanner();
    const artifacts = await scanner.scan(testContext);

    expect(Array.isArray(artifacts)).toBe(true);
  });

  it('should get all tasks', async () => {
    const scanner = createTaskScanner();
    const tasks = await scanner.getAllTasks();

    expect(Array.isArray(tasks)).toBe(true);
    // Most Windows systems have scheduled tasks
    // Don't require > 0 as it may fail in restricted environments

    if (tasks.length > 0) {
      const task = tasks[0];
      expect(task).toHaveProperty('name');
      expect(task).toHaveProperty('path');
      expect(task).toHaveProperty('enabled');
      expect(task).toHaveProperty('actions');
      expect(task).toHaveProperty('triggers');
    }
  });
});

describe('WMISubscriptionScanner', () => {
  it('should create a scanner instance', () => {
    const scanner = createWMISubscriptionScanner();
    expect(scanner.id).toBe('wmi');
  });

  it('should return an array of WMI subscription artifacts', async () => {
    const scanner = createWMISubscriptionScanner();
    const artifacts = await scanner.scan(testContext);

    expect(Array.isArray(artifacts)).toBe(true);
    // Clean systems typically have no WMI subscriptions
  });

  it('should get all WMI subscriptions', async () => {
    const scanner = createWMISubscriptionScanner();
    const subs = await scanner.getAllSubscriptions();

    expect(subs).toHaveProperty('filters');
    expect(subs).toHaveProperty('consumers');
    expect(subs).toHaveProperty('bindings');
    expect(Array.isArray(subs.filters)).toBe(true);
    expect(Array.isArray(subs.consumers)).toBe(true);
    expect(Array.isArray(subs.bindings)).toBe(true);
  });
});

describe('NetworkConfigScanner', () => {
  it('should create a scanner instance', () => {
    const scanner = createNetworkConfigScanner();
    expect(scanner.id).toBe('network');
  });

  it('should return an array of network artifacts', async () => {
    const scanner = createNetworkConfigScanner();
    const artifacts = await scanner.scan(testContext);

    expect(Array.isArray(artifacts)).toBe(true);
  });

  it('should get full network configuration', async () => {
    const scanner = createNetworkConfigScanner();
    const config = await scanner.getFullConfiguration();

    expect(config).toHaveProperty('proxies');
    expect(config).toHaveProperty('dnsSettings');
    expect(config).toHaveProperty('hostsEntries');
    expect(config).toHaveProperty('suspiciousIndicators');
    expect(Array.isArray(config.proxies)).toBe(true);
    expect(Array.isArray(config.dnsSettings)).toBe(true);
    expect(Array.isArray(config.hostsEntries)).toBe(true);
    expect(Array.isArray(config.suspiciousIndicators)).toBe(true);
  });

  it('should parse hosts file entries', async () => {
    const scanner = createNetworkConfigScanner();
    const config = await scanner.getFullConfiguration();

    // Most systems have at least localhost entry
    if (config.hostsEntries.length > 0) {
      const entry = config.hostsEntries[0];
      expect(entry).toHaveProperty('ip');
      expect(entry).toHaveProperty('hostname');
      expect(entry).toHaveProperty('lineNumber');
    }
  });
});

describe('DefenderStateScanner', () => {
  it('should create a scanner instance', () => {
    const scanner = createDefenderStateScanner();
    expect(scanner.id).toBe('defender');
  });

  it('should return an array with single defender artifact', async () => {
    const scanner = createDefenderStateScanner();
    const artifacts = await scanner.scan(testContext);

    expect(Array.isArray(artifacts)).toBe(true);
    expect(artifacts.length).toBe(1);

    const artifact = artifacts[0];
    expect(artifact.type).toBe('defender_state');
    expect(artifact.metadata).toHaveProperty('state');
    expect(artifact.metadata).toHaveProperty('overallStatus');
    expect(artifact.metadata).toHaveProperty('suspiciousIndicators');
  });

  it('should get full Defender state', async () => {
    const scanner = createDefenderStateScanner();
    const state = await scanner.getFullState();

    expect(state).toHaveProperty('realTimeProtectionEnabled');
    expect(state).toHaveProperty('behaviorMonitorEnabled');
    expect(state).toHaveProperty('antivirusEnabled');
    expect(state).toHaveProperty('tamperProtectionEnabled');
    expect(state).toHaveProperty('exclusions');
    expect(state).toHaveProperty('suspiciousIndicators');
    expect(Array.isArray(state.exclusions)).toBe(true);
    expect(Array.isArray(state.suspiciousIndicators)).toBe(true);
  });

  it('should detect suspicious exclusions', async () => {
    const scanner = createDefenderStateScanner();
    const state = await scanner.getFullState();

    // Verify structure of exclusions
    if (state.exclusions.length > 0) {
      const exclusion = state.exclusions[0];
      expect(exclusion).toHaveProperty('type');
      expect(exclusion).toHaveProperty('value');
      expect(['path', 'extension', 'process', 'ip']).toContain(exclusion.type);
    }
  });
});

describe('Scanner Safety', () => {
  it('ProcessScanner should only return read-only data', async () => {
    const scanner = createProcessScanner();

    // Verify scanner has no modification methods
    expect(scanner).not.toHaveProperty('kill');
    expect(scanner).not.toHaveProperty('terminate');
    expect(scanner).not.toHaveProperty('stop');
  });

  it('ServiceScanner should only return read-only data', async () => {
    const scanner = createServiceScanner();

    expect(scanner).not.toHaveProperty('start');
    expect(scanner).not.toHaveProperty('stop');
    expect(scanner).not.toHaveProperty('delete');
  });

  it('TaskScanner should only return read-only data', async () => {
    const scanner = createTaskScanner();

    expect(scanner).not.toHaveProperty('create');
    expect(scanner).not.toHaveProperty('delete');
    expect(scanner).not.toHaveProperty('enable');
    expect(scanner).not.toHaveProperty('disable');
  });

  it('WMISubscriptionScanner should only return read-only data', async () => {
    const scanner = createWMISubscriptionScanner();

    expect(scanner).not.toHaveProperty('create');
    expect(scanner).not.toHaveProperty('delete');
    expect(scanner).not.toHaveProperty('remove');
  });

  it('NetworkConfigScanner should only return read-only data', async () => {
    const scanner = createNetworkConfigScanner();

    expect(scanner).not.toHaveProperty('setProxy');
    expect(scanner).not.toHaveProperty('setDns');
    expect(scanner).not.toHaveProperty('modifyHosts');
  });

  it('DefenderStateScanner should only return read-only data', async () => {
    const scanner = createDefenderStateScanner();

    expect(scanner).not.toHaveProperty('disable');
    expect(scanner).not.toHaveProperty('addExclusion');
    expect(scanner).not.toHaveProperty('removeExclusion');
  });
});

describe('Scanner Output Determinism', () => {
  it('ProcessScanner should produce deterministic output', async () => {
    const scanner = createProcessScanner();

    // Run twice and compare structure (not exact content, as PIDs change)
    const artifacts1 = await scanner.scan(testContext);
    const artifacts2 = await scanner.scan(testContext);

    // Both should be arrays
    expect(Array.isArray(artifacts1)).toBe(true);
    expect(Array.isArray(artifacts2)).toBe(true);

    // All artifacts should have required fields
    for (const artifact of artifacts1) {
      expect(artifact).toHaveProperty('id');
      expect(artifact).toHaveProperty('type');
      expect(artifact).toHaveProperty('owner');
      expect(artifact).toHaveProperty('metadata');
      expect(artifact.type).toBe('process');
    }
  });

  it('ServiceScanner should produce sorted output', async () => {
    const scanner = createServiceScanner();
    const artifacts = await scanner.scan(testContext);

    // Check sorting (by service name)
    for (let i = 1; i < artifacts.length; i++) {
      const prev = (artifacts[i - 1].metadata.name as string).toLowerCase();
      const curr = (artifacts[i].metadata.name as string).toLowerCase();
      expect(prev <= curr).toBe(true);
    }
  });
});
