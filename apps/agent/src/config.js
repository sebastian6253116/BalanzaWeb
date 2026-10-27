/**
 * Agent configuration file.
 *
 * Lives under the agent data directory (default on Windows:
 * %ProgramData%\BalanzaWeb\Agent\config\agent.config.json). The file holds the
 * agent token, so it must be ACL-restricted. Writes are atomic so a power cut
 * cannot leave a truncated token file behind.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultConfigPath } from './paths.js';

export { defaultConfigPath } from './paths.js';

export function loadConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot parse agent configuration at ${path}: ${err.message}`);
  }
}

export function saveConfig(config, path = defaultConfigPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), 'utf8');
  renameSync(temporary, path);
}

export function emptyState() {
  return { revision: 0, scaleHashes: {}, lastSyncAt: null };
}
