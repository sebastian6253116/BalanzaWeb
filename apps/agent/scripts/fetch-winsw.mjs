#!/usr/bin/env node
/**
 * Download the WinSW v2.12.0 x64 executable used as the Windows service wrapper.
 *
 *   node apps/agent/scripts/fetch-winsw.mjs [--force]
 *
 * The file is vendored under apps/agent/service/bin so install.ps1 can copy it
 * next to the agent. Nothing is installed system-wide.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe';
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'service', 'bin', 'balanza-agent-service.exe');
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  console.log(`already present: ${target}`);
  console.log('pass --force to download it again');
  process.exit(0);
}

let response;
try {
  response = await fetch(url, { redirect: 'follow' });
} catch (err) {
  console.error(`error: cannot download WinSW: ${err.message}`);
  console.error('check the network connection or download it manually from:');
  console.error(`  ${url}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`error: cannot download WinSW: HTTP ${response.status} ${response.statusText}`);
  console.error(`  ${url}`);
  process.exit(1);
}

const bytes = Buffer.from(await response.arrayBuffer());
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, bytes);

const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(`downloaded ${bytes.length} bytes to ${target}`);
console.log(`sha256: ${sha256}`);
