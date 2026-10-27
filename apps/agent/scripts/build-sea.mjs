#!/usr/bin/env node
/**
 * Build the agent as a self-contained Windows executable.
 *
 *   node apps/agent/scripts/build-sea.mjs [--smoke]
 *
 * Steps: bundle to CommonJS with esbuild, generate the Node SEA blob, copy the
 * running node.exe and inject the blob with postject. The result needs neither
 * Node nor any other runtime on the sede machine.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const agentRoot = join(repoRoot, 'apps', 'agent');
const dist = join(agentRoot, 'dist');
const bundlePath = join(dist, 'agent.cjs');
const seaConfigPath = join(dist, 'sea-config.json');
const blobPath = join(dist, 'sea-prep.blob');
const exePath = join(dist, 'balanza-agent.exe');
const smoke = process.argv.includes('--smoke');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  fail('esbuild is not installed — run "npm install" at the repo root');
}

console.log('1/5 bundling the agent with esbuild...');
mkdirSync(dist, { recursive: true });
try {
  await esbuild.build({
    entryPoints: [join(agentRoot, 'src', 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: bundlePath,
    legalComments: 'none',
    sourcemap: false,
  });
} catch (err) {
  fail(`esbuild failed: ${err.message}`);
}

console.log('2/5 writing the SEA configuration...');
writeFileSync(
  seaConfigPath,
  `${JSON.stringify(
    {
      main: 'agent.cjs',
      output: 'sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log('3/5 generating the SEA blob...');
const blob = spawnSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
  cwd: dist,
  stdio: 'inherit',
});
if (blob.error) fail(`cannot run node --experimental-sea-config: ${blob.error.message}`);
if (blob.status !== 0) fail(`sea blob generation failed with exit code ${blob.status}`);
if (!existsSync(blobPath)) fail(`sea blob was not created at ${blobPath}`);

console.log('4/5 copying node.exe...');
try {
  unlinkSync(exePath);
} catch {}
try {
  copyFileSync(process.execPath, exePath);
} catch (err) {
  fail(`cannot copy ${process.execPath} to ${exePath}: ${err.message}`);
}

console.log('5/5 injecting the blob with postject...');
const postjectDir = join(repoRoot, 'node_modules', 'postject');
if (!existsSync(postjectDir)) fail('postject is missing — run "npm install -D postject"');
const postjectArgs = [
  '--no-install',
  'postject',
  exePath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const inject = spawnSync(npx, postjectArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (inject.error) fail(`cannot run postject: ${inject.error.message}`);
if (inject.status !== 0) fail(`postject failed with exit code ${inject.status}`);
if (!existsSync(exePath)) fail(`the executable was not created at ${exePath}`);

const megabytes = statSync(exePath).size / (1024 * 1024);
console.log('');
console.log(`built ${exePath}`);
console.log(`size: ${megabytes.toFixed(1)} MB`);
console.log('note: injecting the blob invalidates the original Authenticode signature of node.exe');
console.log('      (expected; sign the final executable before distributing it).');

if (smoke) {
  console.log('');
  console.log('running the smoke test...');
  const home = mkdtempSync(join(tmpdir(), 'balanza-sea-'));
  const env = { ...process.env, BALANZA_AGENT_HOME: home };
  delete env.BALANZA_AGENT_CONFIG;
  delete env.BALANZA_AGENT_LOG_DIR;
  try {
    const result = spawnSync(exePath, ['status'], { env, encoding: 'utf8', timeout: 30000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const acceptable = (result.status === 0 || result.status === 1) && /no configuration/i.test(output);
    if (!acceptable) {
      fail(`smoke test failed (exit ${result.status}):\n${output}`);
    }
    console.log(`smoke test ok (exit ${result.status}): ${output.trim().split(/\r?\n/).join(' | ')}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
