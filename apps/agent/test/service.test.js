import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { agentHome, defaultConfigPath, defaultLogDir, runDir, stopFlagPath, pidPath } from '../src/paths.js';
import { createLogger } from '../src/log.js';
import { loadConfig, saveConfig } from '../src/config.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('paths: environment overrides win and the default layout is config/logs/run', () => {
  const home = tempDir('balanza-paths-');
  try {
    withEnv({ BALANZA_AGENT_HOME: home, BALANZA_AGENT_CONFIG: undefined, BALANZA_AGENT_LOG_DIR: undefined }, () => {
      assert.equal(agentHome(), home);
      assert.match(defaultConfigPath(), /config[\\/]agent\.config\.json$/);
      assert.equal(defaultConfigPath(), join(home, 'config', 'agent.config.json'));
      assert.equal(defaultLogDir(), join(home, 'logs'));
      assert.equal(runDir(), join(home, 'run'));
      assert.equal(stopFlagPath(), join(home, 'run', 'stop.flag'));
      assert.equal(pidPath(), join(home, 'run', 'agent.pid'));
    });

    const explicit = join(home, 'explicit.json');
    withEnv({ BALANZA_AGENT_HOME: home, BALANZA_AGENT_CONFIG: explicit }, () => {
      assert.equal(defaultConfigPath(), explicit);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logger: writes and rotates keeping only the configured number of files', () => {
  const dir = tempDir('balanza-log-');
  try {
    const keep = 3;
    const logger = createLogger({ dir, maxBytes: 80, keep, echo: false });
    for (let i = 0; i < 40; i++) {
      logger.info(`line ${i} with enough padding to exceed the tiny rotation threshold`);
    }

    const names = readdirSync(dir).filter((name) => name.endsWith('.log')).sort();
    assert.equal(names.length, keep, `expected ${keep} log files, got ${names.join(', ')}`);
    assert.ok(names.includes('agent.log'));
    assert.ok(!names.includes(`agent.${keep}.log`), 'the oldest slot must be dropped');
    assert.match(readFileSync(join(dir, 'agent.log'), 'utf8'), /INFO/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logger: never throws when the log directory is actually a file', () => {
  const dir = tempDir('balanza-log-broken-');
  const notADirectory = join(dir, 'not-a-directory');
  try {
    writeFileSync(notADirectory, 'x');
    const logger = createLogger({ dir: notADirectory, echo: false });
    assert.doesNotThrow(() => logger.error('boom'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig: writes atomically and leaves no temporary file', () => {
  const dir = tempDir('balanza-config-');
  try {
    const path = join(dir, 'config', 'agent.config.json');
    const config = {
      apiUrl: 'http://127.0.0.1:1',
      token: 'secret',
      pollIntervalSeconds: 5,
      state: { revision: 0, scaleHashes: {} },
    };

    saveConfig(config, path);

    assert.ok(existsSync(path));
    assert.deepEqual(loadConfig(path), config);
    assert.equal(existsSync(`${path}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run: exits cleanly when request-stop is called', { timeout: 25000 }, async () => {
  const home = tempDir('balanza-run-');
  let child;

  try {
    const configDir = join(home, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent.config.json'),
      JSON.stringify({
        apiUrl: 'http://127.0.0.1:1',
        token: 't',
        pollIntervalSeconds: 1,
        state: { revision: 0, scaleHashes: {} },
      }),
      'utf8',
    );

    const env = { ...process.env, BALANZA_AGENT_HOME: home, BALANZA_AGENT_ECHO: '0' };
    delete env.BALANZA_AGENT_CONFIG;
    delete env.BALANZA_AGENT_LOG_DIR;

    const script = fileURLToPath(new URL('../src/index.js', import.meta.url));
    let stderr = '';
    child = spawn(process.execPath, [script, 'run'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const stop = spawnSync(process.execPath, [script, 'request-stop'], { env, encoding: 'utf8' });
    assert.equal(stop.status, 0, `request-stop failed: ${stop.stderr}`);

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`run did not exit within 10s. stderr: ${stderr}`));
      }, 10000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(exitCode, 0);
    const log = readFileSync(join(home, 'logs', 'agent.log'), 'utf8');
    assert.match(log, /stop requested/);
    assert.match(log, /agent stopped/);
  } finally {
    if (child && child.exitCode === null) child.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
