#!/usr/bin/env node
/**
 * Skyday Finance — Dual-Remote Synchronizer (git.skyday.eu + github.com)
 * 1. Runs `scripts/check-private-data.mjs` to guarantee no private data is in the working tree or commit history.
 * 2. Pushes `main` to `git.skyday.eu` (via direct git push or SSH bundle relay through 192.168.40.150).
 * 3. Pushes `main` to `github` (`https://github.com/Wadera/finance.git`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 1. Run privacy guard first (fail-closed)
execFileSync(process.execPath, ['scripts/check-private-data.mjs'], { stdio: 'inherit' });

// 2. Push to git.skyday.eu (origin)
console.log('→ Pushing main to git.skyday.eu (origin)...');
const directOrigin = spawnSync('git', ['push', 'origin', 'main:main'], { stdio: 'pipe', encoding: 'utf8' });
if (directOrigin.status === 0) {
  console.log('✓ Pushed to origin (git.skyday.eu) directly.');
} else {
  // Fallback: push via SSH bundle relay over clawd@192.168.40.150 -> ssh://git@git.skyday.eu:222
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyday-bundle-'));
  const bundlePath = path.join(tmpDir, 'repo.bundle');
  try {
    execFileSync('git', ['bundle', 'create', bundlePath, 'main'], { stdio: 'inherit' });
    const bundleBytes = fs.readFileSync(bundlePath);
    const remoteCmd =
      'set -euo pipefail; work=$(mktemp -d); trap \'rm -rf "$work"\' EXIT; ' +
      'cat > "$work/repo.bundle"; git clone --bare "$work/repo.bundle" "$work/bare.git" >/dev/null 2>&1; ' +
      'git --git-dir="$work/bare.git" push --force ssh://git@git.skyday.eu:222/SKYDAY/skyday-finance.git main:main; ' +
      'echo "✓ Pushed to git.skyday.eu via SSH relay."';
    const sshPush = spawnSync('ssh', ['-o', 'BatchMode=yes', 'clawd@192.168.40.150', remoteCmd], {
      input: bundleBytes,
      encoding: 'utf8',
    });
    if (sshPush.status !== 0) {
      console.error(sshPush.stderr || directOrigin.stderr);
      process.exit(sshPush.status || 1);
    }
    console.log(sshPush.stdout.trim());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 3. Push to GitHub (https://github.com/Wadera/finance.git)
console.log('→ Pushing main to github.com (github)...');
execFileSync('git', ['push', 'github', 'main:main'], { stdio: 'inherit' });
console.log('✓ Pushed to github.com (Wadera/finance) successfully.');
