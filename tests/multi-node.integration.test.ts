import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/core/api.js';
import { createMemoryDb } from '../src/core/db.js';
import { NetworkedMemoryIpfsClient, createMemoryIpfsNetwork } from '../src/core/ipfs-client.js';
import { PubSubManager } from '../src/core/pubsub.js';
import { SyncEngine } from '../src/core/sync-engine.js';
import { TrustManager } from '../src/core/trust.js';
import type { FileVersion, PubSubMessage, SyncFolder } from '../src/shared/types.js';

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface NodeRig {
  peerId: string;
  dir: string;
  folder: SyncFolder;
  db: ReturnType<typeof createMemoryDb>;
  engine: SyncEngine;
  trust: TrustManager;
  pubsub: PubSubManager;
}

async function createRig(network: ReturnType<typeof createMemoryIpfsNetwork>, peerId: string, dir: string, options?: Partial<SyncFolder>): Promise<NodeRig> {
  const key = Buffer.alloc(32, 9);
  const db = createMemoryDb();
  const ipfs = new NetworkedMemoryIpfsClient(network, peerId);
  const folder: SyncFolder = {
    id: `folder-${peerId}`,
    syncId: 'shared-sync',
    localPath: dir,
    historyCount: 5,
    encrypt: true,
    ...options,
  };

  let pubsub!: PubSubManager;
  const engine = new SyncEngine({
    db,
    ipfs,
    peerId,
    encryptionKey: key,
    broadcast: async (msg) => pubsub.broadcastToTrusted(msg),
  });

  const trust = new TrustManager({
    db,
    onTrustNotify: async (targetPeerId, trusted) => {
      await pubsub.sendTo(targetPeerId, {
        type: 'trust-change',
        from: peerId,
        ts: Date.now(),
        payload: { trusted },
      });
    },
    onMutualTrust: async (targetPeerId) => {
      await engine.triggerStateSync(targetPeerId);
    },
  });

  pubsub = new PubSubManager({
    ipfs,
    db,
    myPeerId: peerId,
    name: `node-${peerId}`,
    onDirectMessage: async (from, msg: PubSubMessage) => {
      switch (msg.type) {
        case 'trust-change':
          await trust.onRemoteTrustChange(from, msg.payload as { trusted: boolean });
          break;
        case 'file-changed':
          if (trust.isMutualTrust(from)) {
            await engine.onRemoteChange(folder, msg.payload as FileVersion);
          }
          break;
        case 'file-deleted':
          if (trust.isMutualTrust(from)) {
            await engine.onRemoteDelete(folder, msg.payload as { syncId: string; path: string });
          }
          break;
        case 'state-sync': {
          if (!trust.isMutualTrust(from)) break;
          const payload = msg.payload as { targetPeerId?: string; files?: FileVersion[] };
          if (payload.targetPeerId && payload.targetPeerId !== peerId) break;
          for (const remote of payload.files ?? []) {
            await engine.onRemoteChange(folder, remote);
          }
          break;
        }
        default:
          break;
      }
    },
  });

  await pubsub.start();
  return { peerId, dir, folder, db, engine, trust, pubsub };
}

describe('multi-node integration', () => {
  it('covers discovery, trust gating, sync, backfill, deletion, conflict, filters, and api', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'filesync-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'filesync-b-'));
    const dirC = mkdtempSync(join(tmpdir(), 'filesync-c-'));

    try {
      const network = createMemoryIpfsNetwork();
      const nodeA = await createRig(network, 'peer-a', dirA);
      const nodeB = await createRig(network, 'peer-b', dirB);
      const nodeC = await createRig(network, 'peer-c', dirC, { include: ['allowed/**'], exclude: ['ignored/**'] });
      await nodeA.pubsub.announce();
      await nodeB.pubsub.announce();
      await nodeC.pubsub.announce();
      await flush();

      expect(nodeA.db.listNodes().map((n) => n.node_id)).toContain('peer-b');
      expect(nodeB.db.listNodes().map((n) => n.node_id)).toContain('peer-a');

      const beforeTrustPath = join(dirA, 'pretrust.txt');
      writeFileSync(beforeTrustPath, 'secret-before-trust');
      await nodeA.engine.onLocalChange(nodeA.folder, 'pretrust.txt', beforeTrustPath);
      await flush();
      expect(existsSync(join(dirB, 'pretrust.txt'))).toBe(false);

      await nodeA.trust.setTrust('peer-b', 'trusted');
      await nodeB.trust.setTrust('peer-a', 'trusted');
      await flush(6);

      expect(nodeA.trust.isMutualTrust('peer-b')).toBe(true);
      expect(nodeB.trust.isMutualTrust('peer-a')).toBe(true);
      expect(readFileSync(join(dirB, 'pretrust.txt'), 'utf8')).toBe('secret-before-trust');

      const livePath = join(dirA, 'note.txt');
      writeFileSync(livePath, 'hello from node A');
      await nodeA.engine.onLocalChange(nodeA.folder, 'note.txt', livePath);
      await flush(6);
      expect(readFileSync(join(dirB, 'note.txt'), 'utf8')).toBe('hello from node A');

      writeFileSync(join(dirB, 'note.txt'), 'newer on node B');
      const localB = await nodeB.engine.onLocalChange(nodeB.folder, 'note.txt', join(dirB, 'note.txt'));
      await flush(6);
      expect(readFileSync(join(dirA, 'note.txt'), 'utf8')).toBe('newer on node B');

      await nodeB.engine.onRemoteChange(nodeB.folder, {
        ...localB!,
        cid: createHash('sha256').update('older').digest('hex'),
        version: localB!.version - 1,
        updatedBy: 'peer-a',
        updatedAt: localB!.updatedAt - 1000,
      });
      expect(readFileSync(join(dirB, 'note.txt'), 'utf8')).toBe('newer on node B');

      await nodeA.trust.setTrust('peer-c', 'trusted');
      await nodeC.trust.setTrust('peer-a', 'trusted');
      await flush(6);

      mkdirSync(join(dirA, 'allowed'), { recursive: true });
      mkdirSync(join(dirA, 'ignored'), { recursive: true });
      writeFileSync(join(dirA, 'allowed', 'ok.txt'), 'allowed data');
      await nodeA.engine.onLocalChange(nodeA.folder, 'allowed/ok.txt', join(dirA, 'allowed', 'ok.txt'));
      writeFileSync(join(dirA, 'ignored', 'skip.txt'), 'ignored data');
      await nodeA.engine.onLocalChange(nodeA.folder, 'ignored/skip.txt', join(dirA, 'ignored', 'skip.txt'));
      await flush(6);

      expect(readFileSync(join(dirC, 'allowed', 'ok.txt'), 'utf8')).toBe('allowed data');
      expect(existsSync(join(dirC, 'ignored', 'skip.txt'))).toBe(false);

      unlinkSync(livePath);
      await nodeA.engine.onLocalDelete(nodeA.folder, 'note.txt');
      await flush(6);
      expect(existsSync(join(dirB, 'note.txt'))).toBe(false);

      const app = buildApp({
        db: nodeA.db,
        config: {
          name: 'node-a',
          webPort: 8384,
          webAuth: { username: 'admin', passwordHash: createHash('sha256').update('secret').digest('hex') },
          encryptionKey: 'x',
          syncFolders: [nodeA.folder],
        },
        status: () => ({ ok: true, peerId: 'peer-a', kuboAvailable: false, nodeName: 'node-a' }),
      });

      const denied = await app.inject({ method: 'GET', url: '/api/status' });
      expect(denied.statusCode).toBe(401);

      const authHeader = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
      const statusRes = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: authHeader } });
      const nodesRes = await app.inject({ method: 'GET', url: '/api/nodes', headers: { authorization: authHeader } });
      const filesRes = await app.inject({ method: 'GET', url: '/api/files', headers: { authorization: authHeader } });

      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json().peerId).toBe('peer-a');
      expect(nodesRes.json().some((n: { node_id: string }) => n.node_id === 'peer-b')).toBe(true);
      expect(filesRes.json().some((f: { path: string }) => f.path === 'pretrust.txt')).toBe(true);

      await app.close();
      nodeA.pubsub.stop();
      nodeB.pubsub.stop();
      nodeC.pubsub.stop();
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
      rmSync(dirC, { recursive: true, force: true });
    }
  });
});
