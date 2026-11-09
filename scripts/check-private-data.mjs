#!/usr/bin/env node
/**
 * Skyday Finance — Public Repository Privacy & Secret Guard
 * Scans all git-tracked files and unpushed commit diffs (github/main..HEAD)
 * to ensure zero private personal names, personal email addresses, bank account numbers,
 * SQLite databases, or live API tokens can be pushed to the public GitHub repository.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const FORBIDDEN_FILE_PATTERNS = [
  /\.sqlite(-shm|-wal)?$/i,
  /\.db$/i,
  /\.token$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.bundle$/i,
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)(data|backups|attachments|statements|secrets)\//i,
];

// Personal / private identifiers that must never appear in public source code or commit diffs
const FORBIDDEN_CONTENT_PATTERNS = [
  { label: 'Personal surname (Poznanski)', regex: /poznanski/i },
  { label: 'Personal full name (Paulina Stopa)', regex: /paulina\s+stopa/i },
  { label: 'Personal first+middle name (Wojciech Pawel)', regex: /wojciech\s+pawel/i },
  { label: 'Personal email handle (pstopa)', regex: /\bpstopa\b/i },
  { label: 'Personal email handle (wpoznanski)', regex: /\bwpoznanski\b/i },
  { label: 'Live API key token (skdf_)', regex: /\bskdf_[A-Za-z0-9_-]{16,}/ },
  { label: 'Bank sort code / account number (82252260)', regex: /\b82252260\b/ },
];

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2']);

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const violations = [];
const trackedFiles = getTrackedFiles();

for (const file of trackedFiles) {
  if (file === '.env.example' || file === 'scripts/check-private-data.mjs') continue;

  for (const pat of FORBIDDEN_FILE_PATTERNS) {
    if (pat.test(file)) {
      violations.push(`Forbidden tracked file path: ${file}`);
    }
  }

  const lower = file.toLowerCase();
  if (Array.from(BINARY_EXTENSIONS).some((ext) => lower.endsWith(ext))) continue;
  if (!fs.existsSync(file)) continue;

  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const rule of FORBIDDEN_CONTENT_PATTERNS) {
      if (rule.regex.test(line)) {
        violations.push(`${file}:${idx + 1} matched [${rule.label}]`);
      }
    }
  });
}

// Also scan added lines in unpushed commits since github/main if github/main ref exists
try {
  execFileSync('git', ['rev-parse', '--verify', 'github/main'], { stdio: 'ignore' });
  const diffOut = execFileSync('git', ['log', '-p', 'github/main..HEAD', '--', '.', ':!scripts/check-private-data.mjs'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const line of diffOut.split(/\r?\n/)) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const rule of FORBIDDEN_CONTENT_PATTERNS) {
      if (rule.regex.test(line)) {
        violations.push(`Unpushed commit history (github/main..HEAD) contains [${rule.label}]`);
      }
    }
  }
} catch {
  // github/main ref not fetched yet; tracked file check still enforced
}

if (violations.length > 0) {
  console.error('❌ Privacy & Secret Guard blocked push due to private data findings:');
  for (const v of [...new Set(violations)]) {
    console.error(`   - ${v}`);
  }
  process.exit(1);
}

console.log(`✓ Privacy & Secret Guard passed (${trackedFiles.length} tracked files verified clean).`);
