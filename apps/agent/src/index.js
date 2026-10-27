#!/usr/bin/env node
/**
 * balanza-agent — local service that keeps the scales of one sede in sync.
 *
 *   balanza-agent enroll --api https://vps.example.com --code ABCDEFGH
 *   balanza-agent run
 *   balanza-agent once
 *   balanza-agent request-stop
 *   balanza-agent status
 *
 * No third-party runtime: the agent is plain Node plus the shared protocol packages.
 */
import os from 'node:os';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, saveConfig, defaultConfigPath, emptyState } from './config.js';
import { defaultLogDir, stopFlagPath, pidPath, legacyConfigPath } from './paths.js';
import { createLogger, installCrashHandlers } from './log.js';
import { syncOnce } from './sync.js';
import { pushPlu } from '../../../packages/scale-client/src/index.js';

const stamp = () => new Date().toISOString();
const consoleLog = (message) => console.log(`${stamp()} ${message}`);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

const machineId = () => `${os.hostname()}-${process.platform}-${os.arch()}`;

async function enroll(flags) {
  const apiUrl = flags.api;
  const code = flags.code;
  if (!apiUrl || !code) throw new Error('enroll requires --api <url> and --code <pairing-code>');

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/agent/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, machineId: machineId() }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `enrolment failed: HTTP ${response.status}`);

  const config = {
    apiUrl: apiUrl.replace(/\/$/, ''),
    agentId: body.agentId,
    sede: body.sede,
    token: body.token,
    machineId: machineId(),
    pollIntervalSeconds: body.sede.pollIntervalSeconds ?? 60,
    allowLocalOverride: flags['allow-local-override'] === true,
    state: emptyState(),
  };
  const path = flags.config ?? defaultConfigPath();
  saveConfig(config, path);
  consoleLog(`enrolled as agent ${config.agentId} for sede "${body.sede.name}"`);
  consoleLog(`configuration written to ${path}`);
  consoleLog('store this file with restricted ACLs: it holds the agent token');
}

async function once(flags) {
  const path = flags.config ?? defaultConfigPath();
  const logger = createLogger();
  const config = loadConfig(path);
  if (!config) throw new Error(`no configuration at ${path}; run "enroll" first`);

  const result = await syncOnce({
    config,
    push: pushPlu,
    log: logger.log,
    persist: (next) => saveConfig(next, path),
  });
  return result;
}

async function run(flags) {
  const path = flags.config ?? defaultConfigPath();
  const logger = createLogger();
  let stopping = false;
  let legacyWarned = false;
  let missingLoggedAt = 0;

  const stop = () => {
    logger.info('stopping after the current cycle');
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // A flag left behind by a previous crash must not stop this run.
  try {
    unlinkSync(stopFlagPath());
  } catch {}
  try {
    mkdirSync(dirname(pidPath()), { recursive: true });
    writeFileSync(pidPath(), String(process.pid), 'utf8');
  } catch (err) {
    logger.warn(`cannot write pid file: ${err.message}`);
  }

  logger.info('agent starting');
  try {
    while (!stopping) {
      const config = loadConfig(path);
      let interval = 60;

      if (!config) {
        if (!legacyWarned && path === defaultConfigPath() && existsSync(legacyConfigPath())) {
          logger.warn(`configuration found at legacy path ${legacyConfigPath()}; move it to ${path} or set BALANZA_AGENT_CONFIG`);
          legacyWarned = true;
        }
        const now = Date.now();
        if (now - missingLoggedAt >= interval * 1000) {
          logger.error('FATAL not enrolled yet — run "balanza-agent enroll ..."; waiting');
          missingLoggedAt = now;
        }
      } else {
        interval = Number(config.pollIntervalSeconds ?? 60);
        try {
          const result = await syncOnce({
            config,
            push: pushPlu,
            log: logger.log,
            persist: (next) => saveConfig(next, path),
          });
          interval = Number(config.pollIntervalSeconds ?? interval);
          if (result.changed === false) logger.info(`idle; next poll in ${interval}s`);
        } catch (err) {
          logger.error(`sync error: ${err.message} — retrying in ${interval}s`);
        }
      }

      // Wait for the next poll, but react to a stop request within one second.
      const until = Date.now() + interval * 1000;
      while (!stopping && Date.now() < until) {
        if (existsSync(stopFlagPath())) {
          logger.info('stop requested — finishing current cycle');
          stopping = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
      }
    }
  } finally {
    try {
      unlinkSync(stopFlagPath());
    } catch {}
    try {
      unlinkSync(pidPath());
    } catch {}
  }
  logger.info('agent stopped');
}

async function requestStop() {
  mkdirSync(dirname(stopFlagPath()), { recursive: true });
  writeFileSync(stopFlagPath(), new Date().toISOString(), 'utf8');
  console.log('stop requested');
}

async function status(flags) {
  const path = flags.config ?? defaultConfigPath();
  console.log(`config:        ${path}`);
  console.log(`log dir:       ${defaultLogDir()}`);
  const config = loadConfig(path);
  if (!config) {
    console.log(`no configuration at ${path}`);
    process.exitCode = 1;
    return;
  }
  console.log(`api:           ${config.apiUrl}`);
  console.log(`sede:          ${config.sede?.name} (id ${config.sede?.id})`);
  console.log(`agent:         ${config.agentId}`);
  console.log(`poll interval: ${config.pollIntervalSeconds}s${config.allowLocalOverride ? ' (local override allowed)' : ''}`);
  console.log(`revision:      ${config.state?.revision ?? 0}`);
  console.log(`last sync:     ${config.state?.lastSyncAt ?? 'never'}`);
  const hashes = Object.entries(config.state?.scaleHashes ?? {});
  console.log(`scales known:  ${hashes.length}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);

  if (command === 'run' || command === 'once') installCrashHandlers(createLogger());

  try {
    switch (command) {
      case 'enroll':
        await enroll(flags);
        break;
      case 'run':
        await run(flags);
        break;
      case 'once': {
        const result = await once(flags);
        if (result.changed === false) {
          console.log(`no changes — revision ${result.revision}, nothing sent`);
        } else {
          console.log(`revision ${result.revision}`);
          for (const item of result.pushed) {
            console.log(`  pushed  ${item.name}: ${item.result.records} records in ${item.result.durationMs} ms`);
          }
          for (const id of result.skipped) console.log(`  skipped scale ${id} (unchanged)`);
          if (result.failed) console.log('  some scales failed — revision not advanced, will retry');
        }
        break;
      }
      case 'request-stop':
        await requestStop();
        break;
      case 'status':
        await status(flags);
        break;
      default:
        console.log('usage: balanza-agent enroll --api <url> --code <code> | run | once | request-stop | status');
        process.exitCode = 2;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
