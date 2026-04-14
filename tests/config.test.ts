import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';

describe('config', () => {
  it('creates a default config when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'filesync-'));
    try {
      const cfg = loadConfig(dir);
      expect(cfg.webPort).toBe(8384);
      expect(cfg.syncFolders).toEqual([]);
      expect(cfg.encryptionKey).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
