#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './api.js';
import { loadConfig, getConfigDir } from './config.js';
import { createSqliteDb } from './db.js';
import { KuboHttpClient, MemoryIpfsClient } from './ipfs-client.js';
import { PubSubManager } from './pubsub.js';
import { SyncEngine } from './sync-engine.js';
import { TrustManager } from './trust.js';
import { Watcher } from './watcher.js';
import type { FileVersion, PubSubMessage, ServiceStatus } from '../shared/types.js';

async function bootstrap() {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  const config = loadConfig(configDir);
  const db = createSqliteDb(join(configDir, 'filesync.db'));

  const kuboClient = new KuboHttpClient();
  const kuboAvailable = await kuboClient.health();
  const ipfs = kuboAvailable ? kuboClient : new MemoryIpfsClient();
  const peerId = kuboAvailable ? (await ipfs.id()).ID : `offline-${config.name}`;

  let pubsub: PubSubManager | undefined;
  const engine = new SyncEngine({
    db,
    ipfs,
    peerId,
    encryptionKey: config.encryptionKey,
    broadcast: async (message) => pubsub?.broadcastToTrusted(message),
  });

  const trust = new TrustManager({
    db,
    onTrustNotify: async (targetPeerId, trusted) => {
      if (!pubsub) return;
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
    name: config.name,
    // 测试模式自动信任所有发现节点（E2E 专用，生产禁用）
    // relay 模式：信任节点上线时补发 state-sync（含防抖）
    onAnnounce: process.env.FILESYNC_DEV_AUTO_TRUST === 'true'
      ? async (from) => { await trust.setTrust(from, 'trusted'); }
      : config.relay
        ? async (from) => {
            if (trust.isMutualTrust(from) && engine.shouldRelaySyncTo(from)) {
              await engine.triggerStateSync(from);
            }
          }
        : undefined,
    onDirectMessage: async (from, msg: PubSubMessage) => {
      switch (msg.type) {
        case 'trust-change':
          await trust.onRemoteTrustChange(from, msg.payload as { trusted: boolean });
          break;
        case 'file-changed': {
          if (!trust.isMutualTrust(from)) return;
          const remote = msg.payload as FileVersion;
          if (config.relay) {
            // relay 模式：存储元数据 + pin，不解密不写本地
            await engine.onRelayStore(remote);
          } else {
            const folder = config.syncFolders.find((item) => item.syncId === remote.syncId);
            if (folder) {
              await engine.onRemoteChange(folder, remote).catch((err) =>
                console.warn(`onRemoteChange error [${remote.path}]:`, err));
            }
          }
          break;
        }
        case 'file-deleted': {
          if (!trust.isMutualTrust(from)) return;
          const payload = msg.payload as { syncId: string; path: string };
          if (config.relay) {
            await engine.onRelayDelete(payload);
          } else {
            const folder = config.syncFolders.find((item) => item.syncId === payload.syncId);
            if (folder) await engine.onRemoteDelete(folder, payload);
          }
          break;
        }
        case 'state-sync': {
          const payload = msg.payload as { targetPeerId?: string; files?: FileVersion[] };
          if (payload.targetPeerId && payload.targetPeerId !== peerId) return;
          for (const remote of payload.files ?? []) {
            if (config.relay) {
              await engine.onRelayStore(remote);
            } else {
              const folder = config.syncFolders.find((item) => item.syncId === remote.syncId);
              if (folder) await engine.onRemoteChange(folder, remote);
            }
          }
          break;
        }
        case 'state-sync-req':
          if (trust.isMutualTrust(from)) {
            await engine.triggerStateSync(from);
          }
          break;
        default:
          break;
      }
    },
  });

  await pubsub.start().catch((err) => console.warn('pubsub start failed:', err));

  let watcher: Watcher | undefined;
  if (config.relay) {
    // relay 模式：不监听本地文件，只做元数据镜像 + pinner
    console.log(`[RELAY] FileSync relay node started (peerId: ${peerId})`);
  } else {
    watcher = new Watcher(engine);
    watcher.start(config.syncFolders);
  }

  const app = buildApp({
    db,
    config,
    status: (): ServiceStatus => ({
      ok: true,
      peerId,
      kuboAvailable,
      nodeName: config.name,
    }),
  });

  const host = process.env.FILESYNC_HOST ?? '127.0.0.1';
  await app.listen({ host, port: config.webPort });
  console.log(`FileSync running on http://${host}:${config.webPort}/ui`);

  const shutdown = async () => {
    await watcher?.stop();
    pubsub?.stop();
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void bootstrap();
