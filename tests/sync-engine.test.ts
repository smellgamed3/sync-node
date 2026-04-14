import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryDb } from '../src/core/db.js';
import { SyncEngine } from '../src/core/sync-engine.js';
import { MemoryIpfsClient } from '../src/core/ipfs-client.js';

describe('sync engine', () => {
  it('stores local changes and applies remote changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filesync-sync-'));
    try {
      const db = createMemoryDb();
      const ipfs = new MemoryIpfsClient();
      const engine = new SyncEngine({ db, ipfs, peerId: 'peer-a' });
      const folder = { id: 'f1', syncId: 's1', localPath: dir, historyCount: 5, encrypt: true };

      const fullPath = join(dir, 'note.txt');
      writeFileSync(fullPath, 'hello');
      const version = await engine.onLocalChange(folder, 'note.txt', fullPath);
      expect(version?.cid).toBeTruthy();

      await engine.onRemoteChange(folder, { ...version!, cid: version!.cid, updatedBy: 'peer-b', version: 2, updatedAt: Date.now() + 1 });
      expect(readFileSync(fullPath, 'utf8')).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
