/**
 * Filesystem layout for the agent.
 *
 * Binaries live under Program Files, while everything mutable (configuration,
 * logs, run state) lives under %ProgramData%\BalanzaWeb\Agent. Development and
 * tests override the whole layout with BALANZA_AGENT_HOME.
 */
import { join } from 'node:path';

export function agentHome() {
  if (process.env.BALANZA_AGENT_HOME) return process.env.BALANZA_AGENT_HOME;
  if (process.platform === 'win32') {
    return join(process.env.ProgramData || 'C:\\ProgramData', 'BalanzaWeb', 'Agent');
  }
  return './data';
}

export function defaultConfigPath() {
  return process.env.BALANZA_AGENT_CONFIG ?? join(agentHome(), 'config', 'agent.config.json');
}

export function defaultLogDir() {
  return process.env.BALANZA_AGENT_LOG_DIR ?? join(agentHome(), 'logs');
}

export function runDir() {
  return join(agentHome(), 'run');
}

export function stopFlagPath() {
  return join(runDir(), 'stop.flag');
}

export function pidPath() {
  return join(runDir(), 'agent.pid');
}

export function legacyConfigPath() {
  return './data/agent.config.json';
}
