/**
 * Session Risk Scorer
 *
 * Evaluates environmental factors that affect remediation safety.
 *
 * ENVIRONMENTAL FACTORS:
 * - Windows Defender state (disabled = bad sign)
 * - Tamper protection (disabled = potential compromise)
 * - Suspicious exclusions (malware indicator)
 * - Proxy configuration (potential hijacking)
 * - Hosts file modifications (potential blocking)
 * - DNS configuration (potential hijacking)
 */

import { randomUUID } from 'node:crypto';
import type { DefenderStateArtifact, NetworkArtifact } from '../acquisition/types';
import type {
  NetworkPosture,
  RiskFactor,
  RiskScore,
  SecurityPosture,
  SessionRisk,
  SessionRiskScorer,
} from './types';
import { scoreToBucket } from './types';

// ============================================================================
// Environmental Risk Factors
// ============================================================================

const ENV_FACTORS = {
  // Defender factors
  defenderDisabled: {
    id: 'defender_disabled',
    name: 'Windows Defender Disabled',
    description: 'Real-time protection is disabled',
    category: 'environmental' as const,
    weight: 30,
    confidence: 'high' as const,
    mitigations: ['Enable Windows Defender', 'Investigate why it was disabled'],
  },
  tamperProtectionOff: {
    id: 'tamper_protection_off',
    name: 'Tamper Protection Disabled',
    description: 'Tamper protection is disabled (suspicious)',
    category: 'environmental' as const,
    weight: 40,
    confidence: 'high' as const,
    mitigations: [
      'Tamper protection can only be disabled via Security Center',
      'Malware may have disabled it',
      'Investigate before proceeding',
    ],
  },
  suspiciousExclusions: {
    id: 'suspicious_exclusions',
    name: 'Suspicious Exclusions',
    description: 'Defender has suspicious exclusion patterns',
    category: 'security' as const,
    weight: 35,
    confidence: 'medium' as const,
    mitigations: [
      'Review Defender exclusions',
      'Remove suspicious exclusions',
      'May indicate malware',
    ],
  },
  manySuspiciousExclusions: {
    id: 'many_suspicious_exclusions',
    name: 'Many Suspicious Exclusions',
    description: 'Multiple suspicious Defender exclusions',
    category: 'security' as const,
    weight: 50,
    confidence: 'high' as const,
    mitigations: [
      'System may be compromised',
      'Full malware scan recommended',
    ],
  },
  recentThreats: {
    id: 'recent_threats',
    name: 'Recent Threats Detected',
    description: 'Defender has recently detected threats',
    category: 'security' as const,
    weight: 25,
    confidence: 'high' as const,
    mitigations: [
      'Review threat history',
      'Ensure threats were fully remediated',
    ],
  },
  manyRecentThreats: {
    id: 'many_recent_threats',
    name: 'Many Recent Threats',
    description: 'Defender has detected many recent threats',
    category: 'security' as const,
    weight: 40,
    confidence: 'high' as const,
    mitigations: [
      'System may be actively infected',
      'Consider full system remediation',
    ],
  },

  // Network factors
  proxyConfigured: {
    id: 'proxy_configured',
    name: 'Proxy Configured',
    description: 'System has a proxy configured',
    category: 'environmental' as const,
    weight: 10,
    confidence: 'medium' as const,
    mitigations: ['Verify proxy is legitimate'],
  },
  suspiciousProxy: {
    id: 'suspicious_proxy',
    name: 'Suspicious Proxy',
    description: 'Proxy configuration looks suspicious',
    category: 'security' as const,
    weight: 35,
    confidence: 'medium' as const,
    mitigations: [
      'Proxy may be intercepting traffic',
      'Review proxy settings',
    ],
  },
  hostsModified: {
    id: 'hosts_modified',
    name: 'Hosts File Modified',
    description: 'System hosts file has non-standard entries',
    category: 'environmental' as const,
    weight: 15,
    confidence: 'medium' as const,
    mitigations: ['Review hosts file entries'],
  },
  securityDomainsBlocked: {
    id: 'security_domains_blocked',
    name: 'Security Domains Blocked',
    description: 'Hosts file blocks security/update domains',
    category: 'security' as const,
    weight: 50,
    confidence: 'high' as const,
    mitigations: [
      'Malware may have blocked security domains',
      'Review and clean hosts file',
      'May prevent updates and security scans',
    ],
  },
  dnsHijacked: {
    id: 'dns_hijacked',
    name: 'DNS Appears Hijacked',
    description: 'DNS settings point to suspicious servers',
    category: 'security' as const,
    weight: 45,
    confidence: 'medium' as const,
    mitigations: [
      'DNS may be redirecting traffic',
      'Reset DNS to automatic or known good servers',
    ],
  },

  // Combined indicators
  multipleIndicators: {
    id: 'multiple_indicators',
    name: 'Multiple Compromise Indicators',
    description: 'Multiple signs of potential compromise',
    category: 'security' as const,
    weight: 30,
    confidence: 'high' as const,
    mitigations: [
      'System shows multiple signs of compromise',
      'Full forensic investigation recommended',
    ],
  },
};

// ============================================================================
// Suspicious Pattern Detection
// ============================================================================

const SUSPICIOUS_EXCLUSION_PATTERNS = [
  /\*\.exe$/i,                    // Exclude all executables
  /\\AppData\\$/i,                // Exclude all AppData
  /\\Temp\\$/i,                   // Exclude all Temp
  /\\Downloads\\$/i,              // Exclude Downloads
  /\\Users\\$/i,                  // Exclude all Users
  /^C:\\$/i,                      // Exclude entire C: drive
  /\\Windows\\$/i,                // Exclude Windows folder
  /\\ProgramData\\$/i,            // Exclude ProgramData
];

const SUSPICIOUS_PROXY_PATTERNS = [
  /localhost:\d{4,5}/i,           // Local proxy (may be legit dev tool)
  /127\.0\.0\.1:\d{4,5}/i,        // Local proxy
  /\.(ru|cn|ir|kp)$/i,            // Country domains often associated with malware
];

const SECURITY_DOMAINS = [
  'windowsupdate.com',
  'microsoft.com',
  'windows.com',
  'avast.com',
  'avg.com',
  'norton.com',
  'mcafee.com',
  'kaspersky.com',
  'bitdefender.com',
  'malwarebytes.com',
  'sophos.com',
  'eset.com',
  'symantec.com',
  'trendmicro.com',
  'crowdstrike.com',
  'virustotal.com',
];

const SUSPICIOUS_DNS_SERVERS = [
  // Known malicious or suspicious DNS servers
  // Most common malware DNS servers are dynamic, so this is limited
];

// ============================================================================
// Session Risk Scorer Implementation
// ============================================================================

/**
 * Create a session risk scorer
 */
export function createSessionRiskScorer(): SessionRiskScorer {
  return {
    score(
      defenderState: DefenderStateArtifact | null,
      networkConfig: NetworkArtifact[],
    ): SessionRisk {
      const assessmentId = randomUUID();
      const assessedAt = Date.now();
      const factors: RiskFactor[] = [];
      const warnings: string[] = [];
      const blockers: string[] = [];

      // Assess security posture
      const securityPosture = assessSecurityPosture(defenderState, factors, warnings, blockers);

      // Assess network posture
      const networkPosture = assessNetworkPosture(networkConfig, factors, warnings, blockers);

      // Check for multiple indicators
      const indicatorCount =
        securityPosture.indicators.length + networkPosture.indicators.length;
      if (indicatorCount >= 3) {
        factors.push(ENV_FACTORS.multipleIndicators);
        warnings.push('Multiple indicators of compromise detected');
      }

      // Calculate score
      const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
      const environmentalScore = Math.min(100, totalWeight);
      const environmentalBucket = scoreToBucket(environmentalScore);

      // Determine safety
      const safeForRemediation = blockers.length === 0 && environmentalScore < 75;

      // Determine recommendation
      let recommendation: SessionRisk['recommendation'];
      if (blockers.length > 0) {
        recommendation = 'abort';
      } else if (environmentalScore >= 75) {
        recommendation = 'investigate_first';
      } else if (environmentalScore >= 40) {
        recommendation = 'proceed_with_caution';
      } else {
        recommendation = 'proceed';
      }

      return {
        assessmentId,
        assessedAt,
        environmentalScore,
        environmentalBucket,
        securityPosture,
        networkPosture,
        factors,
        warnings,
        blockers,
        safeForRemediation,
        recommendation,
      };
    },
  };
}

// ============================================================================
// Security Posture Assessment
// ============================================================================

function assessSecurityPosture(
  defenderState: DefenderStateArtifact | null,
  factors: RiskFactor[],
  warnings: string[],
  blockers: string[],
): SecurityPosture {
  const indicators: string[] = [];

  // If no Defender state available
  if (!defenderState) {
    return {
      defenderActive: false,
      realTimeProtection: false,
      tamperProtection: null,
      suspiciousExclusions: 0,
      recentThreats: 0,
      overallStatus: 'unknown',
      indicators: ['Unable to query Defender state'],
    };
  }

  const state = defenderState.metadata.state;

  // Check real-time protection
  const realTimeProtection = state.realTimeProtectionEnabled;
  if (!realTimeProtection) {
    factors.push(ENV_FACTORS.defenderDisabled);
    warnings.push('Windows Defender real-time protection is disabled');
    indicators.push('Real-time protection disabled');
  }

  // Check tamper protection
  const tamperProtection = state.tamperProtectionEnabled;
  if (tamperProtection === false) {
    factors.push(ENV_FACTORS.tamperProtectionOff);
    warnings.push('Tamper protection is disabled - this is suspicious');
    indicators.push('Tamper protection disabled');
  }

  // Check exclusions
  const suspiciousExclusions = countSuspiciousExclusions(state.exclusions);
  if (suspiciousExclusions >= 3) {
    factors.push(ENV_FACTORS.manySuspiciousExclusions);
    warnings.push(`Found ${suspiciousExclusions} suspicious Defender exclusions`);
    indicators.push(`${suspiciousExclusions} suspicious exclusions`);
  } else if (suspiciousExclusions > 0) {
    factors.push(ENV_FACTORS.suspiciousExclusions);
    warnings.push(`Found ${suspiciousExclusions} suspicious Defender exclusion(s)`);
    indicators.push(`${suspiciousExclusions} suspicious exclusion(s)`);
  }

  // Check threat count
  const recentThreats = state.threatCount;
  if (recentThreats >= 5) {
    factors.push(ENV_FACTORS.manyRecentThreats);
    warnings.push(`Defender has detected ${recentThreats} recent threats`);
    indicators.push(`${recentThreats} recent threats`);
  } else if (recentThreats > 0) {
    factors.push(ENV_FACTORS.recentThreats);
    warnings.push(`Defender has detected ${recentThreats} recent threat(s)`);
  }

  // Overall status
  const overallStatus = defenderState.metadata.overallStatus;
  if (overallStatus === 'compromised') {
    blockers.push('System security appears compromised');
    indicators.push('Security status: compromised');
  }

  // Add any indicators from the scanner
  const scannerIndicators = defenderState.metadata.suspiciousIndicators || [];
  indicators.push(...scannerIndicators);

  return {
    defenderActive: state.antivirusEnabled && state.antispywareEnabled,
    realTimeProtection,
    tamperProtection,
    suspiciousExclusions,
    recentThreats,
    overallStatus,
    indicators,
  };
}

function countSuspiciousExclusions(
  exclusions: Array<{ type: string; value: string }>,
): number {
  return exclusions.filter(e => {
    if (e.type === 'path') {
      return SUSPICIOUS_EXCLUSION_PATTERNS.some(p => p.test(e.value));
    }
    if (e.type === 'extension' && e.value === 'exe') {
      return true;
    }
    return false;
  }).length;
}

// ============================================================================
// Network Posture Assessment
// ============================================================================

function assessNetworkPosture(
  networkConfig: NetworkArtifact[],
  factors: RiskFactor[],
  warnings: string[],
  blockers: string[],
): NetworkPosture {
  const indicators: string[] = [];

  let proxyConfigured = false;
  let suspiciousProxy = false;
  let hostsModified = false;
  let securityDomainsBlocked = false;
  let dnsHijacked = false;

  for (const artifact of networkConfig) {
    const category = artifact.metadata.category;
    const current = artifact.metadata.current as Record<string, unknown>;

    switch (category) {
      case 'proxy': {
        if (current && !artifact.metadata.isDefault) {
          proxyConfigured = true;
          factors.push(ENV_FACTORS.proxyConfigured);

          const proxyServer = (current as { server?: string }).server || '';
          if (isSuspiciousProxy(proxyServer)) {
            suspiciousProxy = true;
            factors.push(ENV_FACTORS.suspiciousProxy);
            warnings.push('Proxy configuration looks suspicious');
            indicators.push(`Suspicious proxy: ${proxyServer}`);
          }
        }
        break;
      }

      case 'hosts': {
        const entries = current as Array<{ hostname: string; ip: string }> | undefined;
        if (entries && entries.length > 0) {
          hostsModified = true;
          factors.push(ENV_FACTORS.hostsModified);

          // Check for blocked security domains
          const blockedDomains = entries.filter(e =>
            SECURITY_DOMAINS.some(d => e.hostname.toLowerCase().includes(d)) &&
            (e.ip === '127.0.0.1' || e.ip === '0.0.0.0'),
          );

          if (blockedDomains.length > 0) {
            securityDomainsBlocked = true;
            factors.push(ENV_FACTORS.securityDomainsBlocked);
            warnings.push('Hosts file is blocking security domains');
            blockedDomains.forEach(d => {
              indicators.push(`Blocked domain: ${d.hostname}`);
            });
          }
        }
        break;
      }

      case 'dns': {
        const servers = (current as { servers?: string[] })?.servers || [];
        if (servers.some(s => isSuspiciousDns(s))) {
          dnsHijacked = true;
          factors.push(ENV_FACTORS.dnsHijacked);
          warnings.push('DNS configuration may be hijacked');
          indicators.push('Suspicious DNS servers detected');
        }
        break;
      }
    }
  }

  return {
    proxyConfigured,
    suspiciousProxy,
    hostsModified,
    securityDomainsBlocked,
    dnsHijacked,
    indicators,
  };
}

function isSuspiciousProxy(server: string): boolean {
  return SUSPICIOUS_PROXY_PATTERNS.some(p => p.test(server));
}

function isSuspiciousDns(server: string): boolean {
  return SUSPICIOUS_DNS_SERVERS.some(s => server.includes(s));
}
