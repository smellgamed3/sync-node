import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_WEB_PORT } from '../shared/constants.js';
import type { AppConfig } from '../shared/types.js';
import { generateKey } from './crypto.js';

export function getConfigDir(baseDir?: string): string {
  return resolve(baseDir ?? process.env.FILESYNC_HOME ?? join(homedir(), '.filesync'));
}

export function getConfigPath(baseDir?: string): string {
  return join(getConfigDir(baseDir), 'config.json');
}

export function defaultConfig(): AppConfig {
  return {
    name: hostname(),
    webPort: DEFAULT_WEB_PORT,
    webAuth: { username: 'admin', passwordHash: '' },
    encryptionKey: generateKey(),
    syncFolders: [],
  };
}

export function loadConfig(baseDir?: string): AppConfig {
  const dir = getConfigDir(baseDir);
  const file = getConfigPath(baseDir);
  mkdirSync(dir, { recursive: true });

  if (!existsSync(file)) {
    const cfg = defaultConfig();
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    return cfg;
  }

  const parsed = JSON.parse(readFileSync(file, 'utf8')) as AppConfig;
  if (!parsed.encryptionKey) {
    parsed.encryptionKey = generateKey();
    writeFileSync(file, JSON.stringify(parsed, null, 2));
  }
  parsed.syncFolders ??= [];
  return parsed;
}

export function saveConfig(config: AppConfig, baseDir?: string): void {
  const dir = getConfigDir(baseDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigPath(baseDir), JSON.stringify(config, null, 2));
}
