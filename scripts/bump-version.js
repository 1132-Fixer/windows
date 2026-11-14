#!/usr/bin/env node
'use strict';

// Local release preparation only. No Git commands, tags, uploads or releases.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md'];

function parseVersion(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(label + ' must be a stable version such as 6.4.0; prereleases require an explicit release plan.');
  }
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(label + ' contains a component outside the safe integer range.');
  }
  return parts;
}

function nextVersion(current, type) {
  if (!['major', 'minor', 'patch'].includes(type)) {
    throw new Error('Bump type must be major, minor or patch.');
  }
  const parts = parseVersion(current, 'package.json version');
  const component = { major: 0, minor: 1, patch: 2 }[type];
  parts[component] += 1;
  for (let index = component + 1; index < parts.length; index++) parts[index] = 0;
  const next = parts.join('.');
  parseVersion(next, 'Next version');
  return next;
}

function parseJson(text, label) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(label + ' must contain valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must contain a JSON object.');
  }
  return value;
}

function encodeJson(value, original) {
  const indent = original.match(/\r?\n([ \t]+)"/);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(value, null, indent ? indent[1] : 2).replace(/\n/g, eol) + eol;
}

function releaseChangelog(text, current, next, date) {
  if (typeof text !== 'string' || !/^# Changelog\r?$/m.test(text)) {
    throw new Error('CHANGELOG.md must contain its Changelog heading.');
  }
  const headers = [...text.matchAll(/^## \[([^\]\r\n]+)\][^\r\n]*\r?$/gm)];
  const unreleased = headers.filter((header) => header[1] === 'Unreleased');
  if (unreleased.length !== 1 || headers[0] !== unreleased[0]) {
    throw new Error('CHANGELOG.md must begin its release sections with exactly one [Unreleased] heading.');
  }
  const released = headers.slice(1);
  if (!released.length || released[0][1] !== current) {
    throw new Error('CHANGELOG.md latest release must match package.json version.');
  }
  const seen = new Set();
  for (const header of released) {
    parseVersion(header[1], 'CHANGELOG.md release');
    if (seen.has(header[1])) throw new Error('CHANGELOG.md contains duplicate release versions.');
    seen.add(header[1]);
  }
  if (seen.has(next)) throw new Error('CHANGELOG.md already contains the next version.');
  const start = unreleased[0].index + unreleased[0][0].length;
  const notes = text.slice(start, released[0].index).trim();
  if (!notes || !notes.replace(/<!--[\s\S]*?-->/g, '').replace(/^#{1,6}[^\r\n]*$/gm, '').trim()) {
    throw new Error('Add release notes under [Unreleased] before bumping the version.');
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
    throw new Error('Release date must be a valid UTC date in YYYY-MM-DD form.');
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, unreleased[0].index) + '## [Unreleased]' + eol + eol +
    '## [' + next + '] - ' + date + eol + eol + notes + eol + eol + text.slice(released[0].index);
}

function planVersionBump(contents, type = 'patch', date = new Date().toISOString().slice(0, 10)) {
  for (const file of FILES) {
    if (!contents || typeof contents[file] !== 'string') throw new Error('Missing required file: ' + file + '.');
  }
  const pkg = parseJson(contents['package.json'], 'package.json');
  const lock = parseJson(contents['package-lock.json'], 'package-lock.json');
  const current = pkg.version;
  const next = nextVersion(current, type);
  const lockRoot = lock.packages && lock.packages[''];
  if (![2, 3].includes(lock.lockfileVersion) || !lockRoot || typeof lockRoot !== 'object' || Array.isArray(lockRoot)) {
    throw new Error('package-lock.json must use lockfileVersion 2 or 3 and contain packages[""]; refresh it through the supported npm path first.');
  }
  if (lock.version !== current || lockRoot.version !== current) {
    throw new Error('package.json, package-lock.json and packages[""] versions must agree before a bump.');
  }
  if (typeof pkg.name !== 'string' || !pkg.name || lock.name !== pkg.name || lockRoot.name !== pkg.name) {
    throw new Error('Package identity must agree in package.json, package-lock.json and packages[""].');
  }
  const changelog = releaseChangelog(contents['CHANGELOG.md'], current, next, date);
  pkg.version = next;
  lock.version = next;
  lockRoot.version = next;
  return {
    current, next,
    files: {
      'package.json': encodeJson(pkg, contents['package.json']),
      'package-lock.json': encodeJson(lock, contents['package-lock.json']),
      'CHANGELOG.md': changelog
    }
  };
}

function bumpVersion({ root = ROOT, type = 'patch', date, io = fs } = {}) {
  const resolvedRoot = io.realpathSync(root);
  const lockPath = path.join(resolvedRoot, '.version-bump.lock');
  let descriptor;
  try { descriptor = io.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A version-bump lock already exists. Check its owner and recover any interrupted preparation before retrying.');
    throw error;
  }
  const entries = [];
  let keepBackups = false;
  let failure;
  try {
    io.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    const contents = {};
    for (const file of FILES) {
      const target = path.join(resolvedRoot, file);
      const stat = io.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(file + ' must be a regular file, not a link.');
      contents[file] = io.readFileSync(target, 'utf8');
    }
    const plan = planVersionBump(contents, type, date);
    const transaction = randomUUID();
    for (const file of FILES) {
      const target = path.join(resolvedRoot, file);
      const entry = {
        file, target, original: contents[file], updated: plan.files[file], committed: false,
        staged: target + '.version-bump-' + transaction + '.tmp',
        backup: target + '.version-bump-' + transaction + '.bak'
      };
      entries.push(entry);
      io.writeFileSync(entry.staged, entry.updated, { encoding: 'utf8', flag: 'wx' });
      io.writeFileSync(entry.backup, entry.original, { encoding: 'utf8', flag: 'wx' });
    }
    // Other editors do not use this lock. Refuse a stale snapshot and check
    // each target again immediately before replacement. One writer still owns
    // the repository; these checks do not provide a filesystem compare-and-swap.
    for (const entry of entries) {
      if (io.readFileSync(entry.target, 'utf8') !== entry.original) throw new Error(entry.file + ' changed during preparation; stale overwrite refused.');
    }
    for (const entry of entries) {
      if (io.readFileSync(entry.target, 'utf8') !== entry.original) throw new Error(entry.file + ' changed during preparation; stale overwrite refused.');
      io.renameSync(entry.staged, entry.target);
      entry.committed = true;
    }
    return { current: plan.current, next: plan.next, files: [...FILES] };
  } catch (error) {
    const recovery = [];
    for (const entry of entries.slice().reverse()) {
      if (!entry.committed) continue;
      try {
        if (io.readFileSync(entry.target, 'utf8') !== entry.updated) throw new Error('Changed by another writer.');
        io.renameSync(entry.backup, entry.target);
      } catch {
        recovery.push(entry.file);
      }
    }
    if (recovery.length) {
      keepBackups = true;
      failure = new Error('Version preparation failed; automatic rollback could not restore ' + recovery.join(', ') +
        '. Preserve the .version-bump-*.bak files and reconcile the three versions before retrying. Cause: ' + error.message);
    } else {
      failure = new Error('Version preparation failed; original files restored where changed. ' + error.message);
    }
    throw failure;
  } finally {
    const cleanupFailures = [];
    for (const entry of entries) {
      const temporaryFiles = [entry.staged, ...(!keepBackups ? [entry.backup] : [])];
      for (const temporary of temporaryFiles) {
        try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') cleanupFailures.push(path.basename(temporary)); }
      }
    }
    try { io.closeSync(descriptor); } catch { cleanupFailures.push('.version-bump.lock handle'); }
    try { io.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') cleanupFailures.push('.version-bump.lock'); }
    if (cleanupFailures.length) {
      const message = 'Cleanup required: ' + cleanupFailures.join(', ') + '. Check all three versions before retrying.';
      if (failure) failure.message += ' ' + message;
      else throw new Error(message);
    }
  }
}

if (require.main === module) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/bump-version.js [major|minor|patch]');
    const result = bumpVersion({ type: process.argv[2] || 'patch' });
    console.log('Prepared ' + result.current + ' -> ' + result.next + ': ' + result.files.join(', ') +
      '. Review the diff; nothing was committed, tagged or published.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { FILES, nextVersion, planVersionBump, bumpVersion };
