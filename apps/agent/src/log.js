/**
 * Small file logger with size-based rotation.
 *
 * The agent usually runs inside a Windows service with no console attached, so
 * its own log file is the primary source of truth. Every filesystem failure is
 * swallowed on purpose: a broken logger must never take the agent down.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLogDir } from './paths.js';

export function createLogger({
  dir = defaultLogDir(),
  maxBytes = 5 * 1024 * 1024,
  keep = 5,
  echo = undefined,
  name = 'agent',
} = {}) {
  const file = join(dir, `${name}.log`);
  const rotated = (slot) => join(dir, `${name}.${slot}.log`);
  const shouldEcho = echo ?? (Boolean(process.stdout.isTTY) || process.env.BALANZA_AGENT_ECHO === '1');
  let ready = false;

  function ensureDir() {
    if (ready) return true;
    try {
      mkdirSync(dir, { recursive: true });
      ready = true;
      return true;
    } catch {
      return false;
    }
  }

  function rotate() {
    let size;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;

    const limit = Math.max(1, keep);
    if (limit === 1) {
      try {
        unlinkSync(file);
      } catch {}
      try {
        unlinkSync(rotated(1));
      } catch {}
      return;
    }

    try {
      unlinkSync(rotated(limit));
    } catch {}
    for (let slot = limit - 1; slot >= 2; slot--) {
      try {
        unlinkSync(rotated(slot));
      } catch {}
      try {
        renameSync(rotated(slot - 1), rotated(slot));
      } catch {}
    }
    try {
      unlinkSync(rotated(1));
    } catch {}
    try {
      renameSync(file, rotated(1));
    } catch {}
  }

  function write(level, message) {
    const line = `${new Date().toISOString()} ${level} ${message}`;
    let wrote = false;

    if (ensureDir()) {
      rotate();
      try {
        appendFileSync(file, `${line}\n`, 'utf8');
        wrote = true;
      } catch {}
    }

    if (shouldEcho || !wrote) {
      const stream = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
      try {
        stream.write(`${line}\n`);
      } catch {}
    }
  }

  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
    log: (level, message) => (message === undefined ? write('INFO', String(level)) : write(String(level).toUpperCase(), String(message))),
  };
}

export function installCrashHandlers(logger) {
  const fail = (kind) => (err) => {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    try {
      logger.error(`${kind}: ${detail}`);
    } catch {}
    process.exit(1);
  };
  process.on('uncaughtException', fail('uncaughtException'));
  process.on('unhandledRejection', fail('unhandledRejection'));
}
