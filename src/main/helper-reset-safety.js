'use strict';

// Pure decision contract for a *bound, existing* helper reset. This module
// performs no probes or effects. "ready" means only that the supplied facts
// satisfy this contract at the injected time. The native orchestrator must
// hold its machine-wide lease and re-probe immediately before EACH effect.
// An absent/unbound legacy account is not a reset candidate; creation and
// explicit legacy adoption require separate, evidenced workflows.
// A trusted native adapter must establish the configured profile root and
// registry/path ownership. This evaluator checks their supplied relationship;
// lexical path checks cannot establish native root authorization or ACLs.
const windowsPath = require('path').win32;

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_AGE_MS = 5000;
const MANAGED_ACCOUNT_NAME = 'user1';
const PROBE_NAMES = Object.freeze([
  'binding', 'account', 'shutdown', 'sessions', 'processes',
  'profile', 'logonFence', 'lease', 'journal'
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function uint32(value) {
  return /^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= 0xffffffff;
}

function validSid(value) {
  if (typeof value !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+){1,15}$/.test(value)) return false;
  const parts = value.split('-');
  return /^(0|[1-9][0-9]*)$/.test(parts[2]) &&
    Number(parts[2]) <= 0xffffffffffff && parts.slice(3).every(uint32);
}

function validMachineSid(value) {
  return typeof value === 'string' && /^S-1-5-21-[0-9]+-[0-9]+-[0-9]+$/.test(value) &&
    value.split('-').slice(4).every(uint32);
}

function managedSid(sid, machineSid) {
  if (!validMachineSid(machineSid) || !validSid(sid) || !sid.startsWith(machineSid + '-')) return false;
  const rid = sid.slice(machineSid.length + 1);
  // Built-in users and groups are not managed helper identities.
  return uint32(rid) && Number(rid) >= 1000;
}

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || value.includes('/')) return false;
  const segments = value.slice(3).split('\\');
  return segments.length > 0 && segments.every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..' &&
    !/[<>:"|?*\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(segment)
  );
}

function canonical(value) {
  return windowsPath.normalize(value).toLowerCase();
}

function overlaps(left, right) {
  return left === right || left.startsWith(right + '\\') || right.startsWith(left + '\\');
}

function decision(blockers, scope, expiresAtMs = null) {
  return {
    decision: blockers.length ? 'blocked' : 'ready',
    blockers,
    expiresAtMs: blockers.length ? null : expiresAtMs,
    requiresNativeRevalidation: true,
    scope
  };
}

function evaluate(snapshot, options) {
  const blockers = [];
  const deny = code => { if (!blockers.includes(code)) blockers.push(code); };
  if (!record(options) || !positiveInteger(options.nowMs)) {
    return decision(['invalid_clock'], null);
  }
  const maxAgeMs = options.maxAgeMs === undefined ? MAX_AGE_MS : options.maxAgeMs;
  if (!positiveInteger(maxAgeMs) || maxAgeMs > MAX_AGE_MS) {
    return decision(['invalid_max_age'], null);
  }
  const nowMs = options.nowMs;
  if (!record(snapshot) || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      !record(snapshot.operation) || !record(snapshot.probes)) {
    return decision(['invalid_snapshot'], null);
  }
  const op = snapshot.operation;
  if (!identifier(op.id) || !positiveInteger(op.generation) ||
      !identifier(op.machineId) || !identifier(op.leaseNonce) ||
      op.accountName !== MANAGED_ACCOUNT_NAME || !managedSid(op.accountSid, op.machineSid)) {
    return decision(['invalid_operation_identity'], null);
  }
  const scope = {
    operationId: op.id,
    generation: op.generation,
    machineId: op.machineId,
    accountSid: op.accountSid,
    leaseNonce: op.leaseNonce
  };
  let oldestCaptureMs = nowMs;
  for (const name of PROBE_NAMES) {
    const probe = snapshot.probes[name];
    if (!record(probe)) {
      deny(name + '_missing');
      continue;
    }
    if (probe.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
        probe.status !== 'verified' || probe.complete !== true) deny(name + '_unverified');
    if (probe.machineId !== op.machineId || probe.accountSid !== op.accountSid ||
        probe.operationId !== op.id || probe.generation !== op.generation ||
        probe.leaseNonce !== op.leaseNonce) deny(name + '_scope_mismatch');
    if (!positiveInteger(probe.capturedAtMs) || probe.capturedAtMs > nowMs ||
        nowMs - probe.capturedAtMs >= maxAgeMs) {
      deny(name + '_stale_or_invalid');
    } else {
      oldestCaptureMs = Math.min(oldestCaptureMs, probe.capturedAtMs);
    }
  }
  const probes = snapshot.probes;
  const binding = probes.binding;
  if (!record(binding) || binding.ownerVerified !== true || binding.storageProtected !== true ||
      binding.machineSid !== op.machineSid || binding.accountName !== MANAGED_ACCOUNT_NAME) {
    deny('managed_binding_unverified');
  }
  const account = probes.account;
  if (!record(account) || account.exists !== true || account.isLocal !== true ||
      account.accountType !== 'user' || typeof account.name !== 'string' ||
      account.name.toLowerCase() !== MANAGED_ACCOUNT_NAME ||
      account.builtin !== false || account.protected !== false || account.enabled !== false) {
    deny('account_unverified_or_protected');
  }
  if (!record(account) || !validSid(account.currentUserSid) ||
      account.currentUserSid === op.accountSid) deny('current_user_not_protected');

  const shutdown = probes.shutdown;
  if (!record(shutdown) || shutdown.outcome !== 'complete' || shutdown.timedOut !== false ||
      shutdown.spawnFailed !== false || shutdown.terminationConfirmed !== true) {
    deny('shutdown_unverified');
  }
  const sessions = probes.sessions;
  if (!record(sessions) || sessions.activeCount !== 0 || sessions.unknownOwnerCount !== 0) {
    deny('sessions_not_clear');
  }
  const processes = probes.processes;
  if (!record(processes) || processes.remainingCount !== 0 || processes.unknownOwnerCount !== 0) {
    deny('processes_not_clear');
  }
  const profile = probes.profile;
  if (!record(profile) || profile.exists !== true || profile.loaded !== false ||
      profile.special !== false || profile.hiveLoaded !== false ||
      profile.ownerSid !== op.accountSid || profile.ownershipVerified !== true ||
      profile.profilesRootVerified !== true || profile.registeredSid !== op.accountSid ||
      profile.ancestorsReparseFree !== true || profile.leafReparseFree !== true) {
    deny('profile_unverified_or_in_use');
  }
  if (!record(profile) || !absoluteDirectory(profile.path) ||
      !absoluteDirectory(profile.profilesRoot) || !absoluteDirectory(profile.registeredPath) || !record(account) ||
      !absoluteDirectory(account.currentUserProfilePath)) {
    deny('profile_path_unverified');
  } else {
    const target = canonical(profile.path);
    const expected = canonical(windowsPath.join(profile.profilesRoot, MANAGED_ACCOUNT_NAME));
    if (target !== expected || target !== canonical(profile.registeredPath) ||
        overlaps(target, canonical(account.currentUserProfilePath))) deny('profile_path_unsafe');
  }
  const fence = probes.logonFence;
  if (!record(fence) || fence.kind !== 'account-disabled' || fence.applied !== true ||
      !positiveInteger(fence.appliedAtMs) || fence.appliedAtMs > fence.capturedAtMs) {
    deny('logon_fence_unverified');
  }
  const lease = probes.lease;
  if (!record(lease) || lease.scope !== 'machine' || lease.held !== true ||
      lease.exclusive !== true || lease.nonce !== op.leaseNonce || lease.unresolvedWriter !== false ||
      !positiveInteger(lease.expiresAtMs) || lease.expiresAtMs <= nowMs ||
      !positiveInteger(lease.acquiredAtMs) || lease.acquiredAtMs > lease.capturedAtMs) {
    deny('writer_lease_unverified');
  }
  // Freshness alone cannot prove a coherent teardown: an empty session list
  // captured before the account was disabled leaves a sign-in race. Require
  // every observation under this lease, and teardown checks after its fence.
  if (record(lease) && positiveInteger(lease.acquiredAtMs)) {
    for (const name of PROBE_NAMES) {
      if (record(probes[name]) && probes[name].capturedAtMs < lease.acquiredAtMs) {
        deny(name + '_before_lease');
      }
    }
    if (record(fence) && fence.appliedAtMs < lease.acquiredAtMs) deny('fence_before_lease');
  }
  if (record(fence) && positiveInteger(fence.appliedAtMs)) {
    for (const name of ['account', 'shutdown', 'sessions', 'processes', 'profile']) {
      if (record(probes[name]) && probes[name].capturedAtMs < fence.appliedAtMs) {
        deny(name + '_before_fence');
      }
    }
  }
  if (record(shutdown)) {
    for (const name of ['sessions', 'processes']) {
      if (record(probes[name]) && probes[name].capturedAtMs < shutdown.capturedAtMs) {
        deny(name + '_before_shutdown');
      }
    }
  }
  if (record(profile) && record(sessions) && record(processes) &&
      profile.capturedAtMs < Math.max(sessions.capturedAtMs, processes.capturedAtMs)) {
    deny('profile_before_clearance');
  }
  const journal = probes.journal;
  if (!record(journal) || journal.unresolved !== false || journal.phase !== 'validated') {
    deny('interrupted_run_unresolved');
  }
  const expiresAtMs = Math.min(oldestCaptureMs + maxAgeMs,
    record(lease) && positiveInteger(lease.expiresAtMs) ? lease.expiresAtMs : nowMs);
  if (!Number.isSafeInteger(expiresAtMs)) deny('invalid_expiry');
  return decision(blockers, scope, expiresAtMs);
}

function evaluateHelperResetSafety(snapshot, options) {
  // Malformed/unreadable adapter output must never become a ready decision.
  try {
    return evaluate(snapshot, options);
  } catch (_) {
    return decision(['unreadable_snapshot'], null);
  }
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  MAX_AGE_MS,
  evaluateHelperResetSafety
};
