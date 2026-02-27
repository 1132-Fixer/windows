#!/usr/bin/env node
/**
 * Auto-increment patch version across all project files.
 * Usage: node scripts/bump-version.js [major|minor|patch]
 * Default: patch
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const type = process.argv[2] || 'patch';

// Read current version from package.json
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const current = pkg.version;
const [major, minor, patch] = current.split('.').map(Number);

let next;
if (type === 'major') next = `${major + 1}.0.0`;
else if (type === 'minor') next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

console.log(`Bumping version: ${current} → ${next}`);

// Files to update with their patterns
const updates = [
  {
    file: 'package.json',
    find: `"version": "${current}"`,
    replace: `"version": "${next}"`
  },
  {
    file: 'src/main/index.js',
    find: `@version ${current}`,
    replace: `@version ${next}`
  },
  {
    file: 'index.html',
    find: `v${current}`,
    replace: `v${next}`
  }
];

for (const { file, find, replace } of updates) {
  const filePath = path.join(ROOT, file);
  if (!fs.existsSync(filePath)) {
    console.log(`  Skip: ${file} (not found)`);
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(find)) {
    content = content.replace(find, replace);
    fs.writeFileSync(filePath, content);
    console.log(`  Updated: ${file}`);
  } else {
    console.log(`  Skip: ${file} (pattern not found)`);
  }
}

console.log(`Done. Version is now ${next}`);
