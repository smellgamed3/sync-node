import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryDb } from '../src/core/db.js';
import { SyncEngine } from '../src/core/sync-engine.js';
import { MemoryIpfsClient } from '../src/core/ipfs-client.js';
import type { FileVersion } from '../src/shared/types.js';

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

describe('relay mode', () => {
  it('onRelayStore 存储元数据并 pin，不写本地文件', async () => {
    const db = createMemoryDb();
    const ipfs = new MemoryIpfsClient();
    const engine = new SyncEngine({ db, ipfs, peerId: 'relay-1' });

    const cid = await ipfs.add(Buffer.from('encrypted-data'));
    const remote: FileVersion = {
      syncId: 's1', path: 'doc.txt', cid,
      size: 100, modTime: Date.now(), version: 1,
      updatedBy: 'peer-a', updatedAt: Date.now(),
    };

    await engine.onRelayStore(remote);

    expect(db.getFile('s1', 'doc.txt')).toBeTruthy();
    expect(db.getFile('s1', 'doc.txt')!.cid).toBe(cid);
    expect(ipfs.isPinned(cid)).toBe(true);
  });

  it('onRelayStore 相同 CID 时跳过重复存储', async () => {
    const db = createMemoryDb();
    const ipfs = new MemoryIpfsClient();
    const engine = new SyncEngine({ db, ipfs, peerId: 'relay-1' });
    const cid = await ipfs.add(Buffer.from('data'));

    const remote: FileVersion = {
      syncId: 's1', path: 'a.txt', cid, size: 10,
      modTime: Date.now(), version: 1, updatedBy: 'peer-a', updatedAt: Date.now(),
    };

    await engine.onRelayStore(remote);
    await engine.onRelayStore(remote); // 重复调用

    expect(db.getAllFiles().length).toBe(1);
  });

  it('onRelayStore 版本更新时将旧版本归档到历史', async () => {
    const db = createMemoryDb();
    const ipfs = new MemoryIpfsClient();
    const engine = new SyncEngine({ db, ipfs, peerId: 'relay-1' });
    const cid1 = await ipfs.add(Buffer.from('v1'));
    const cid2 = await ipfs.add(Buffer.from('v2'));

    await engine.onRelayStore({
      syncId: 's1', path: 'a.txt', cid: cid1, size: 10,
      modTime: Date.now(), version: 1, updatedBy: 'peer-a', updatedAt: Date.now(),
    });
    await engine.onRelayStore({
      syncId: 's1', path: 'a.txt', cid: cid2, size: 20,
      modTime: Date.now(), version: 2, updatedBy: 'peer-a', updatedAt: Date.now() + 1,
    });

    expect(db.getFile('s1', 'a.txt')!.cid).toBe(cid2);
    // 旧 CID 应被历史引用，不可被 unpin
    expect(db.isCidReferenced(cid1)).toBe(true);
  });

  it('onRelayDelete 删除文件元数据，旧 CID 保留在历史中', async () => {
    const db = createMemoryDb();
    const ipfs = new MemoryIpfsClient();
    const engine = new SyncEngine({ db, ipfs, peerId: 'relay-1' });
    const cid = await ipfs.add(Buffer.from('data'));

    await engine.onRelayStore({
      syncId: 's1', path: 'a.txt', cid, size: 10,
      modTime: Date.now(), version: 1, updatedBy: 'peer-a', updatedAt: Date.now(),
    });

    await engine.onRelayDelete({ syncId: 's1', path: 'a.txt' });

    expect(db.getFile('s1', 'a.txt')).toBeUndefined();
    expect(db.isCidReferenced(cid)).toBe(true); // 历史中保留
  });

  it('onRelayDelete 对不存在文件是空操作', async () => {
    const db = createMemoryDb();
    const ipfs = new MemoryIpfsClient();
    const engine = new SyncEngine({ db, ipfs, peerId: 'relay-1' });

    await engine.onRelayDelete({ syncId: 's1', path: 'nonexistent.txt' });
    expect(db.getAllFiles().length).toBe(0);
  });

  it('shouldRelaySyncTo 对同一 peer 防抖', () => {
    const engine = new SyncEngine({
      db: createMemoryDb(),
      ipfs: new MemoryIpfsClient(),
      peerId: 'relay-1',
    });

    expect(engine.shouldRelaySyncTo('peer-a')).toBe(true);
    expect(engine.shouldRelaySyncTo('peer-a')).toBe(false); // 防抖生效
    expect(engine.shouldRelaySyncTo('peer-b')).toBe(true);  // 不同 peer 不受影响
  });
});

