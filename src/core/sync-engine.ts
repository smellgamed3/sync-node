import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { minimatch } from 'minimatch';
import { decrypt, encrypt } from './crypto.js';
import type { IpfsClient } from './ipfs-client.js';
import type { SyncDb } from './db.js';
import { resolveConflict } from '../shared/conflict.js';
import type { FileVersion, PubSubMessage, SyncFolder } from '../shared/types.js';

interface SyncEngineOptions {
  db: SyncDb;
  ipfs: IpfsClient;
  peerId: string;
  encryptionKey?: string | Buffer;
  broadcast?: (message: PubSubMessage) => Promise<void> | void;
}

export class SyncEngine {
  private readonly writeLock = new Set<string>();

  constructor(private readonly options: SyncEngineOptions) {}

  isWriteLocked(filePath: string): boolean {
    return this.writeLock.has(filePath);
  }

  async onLocalChange(folder: SyncFolder, relativePath: string, fullPath: string): Promise<FileVersion | null> {
    const safePath = this.safeRelativePath(relativePath);
    let content: Buffer = Buffer.from(await readFile(fullPath));
    const fileStat = await stat(fullPath);

    if (folder.encrypt) {
      content = encrypt(content, this.options.encryptionKey);
    }

    const cid = await this.options.ipfs.add(content);
    const current = this.options.db.getFile(folder.syncId, safePath);
    if (current?.cid === cid) return current;

    if (current) {
      this.options.db.addHistory(folder.syncId, current);
      await this.cleanupHistory(folder.syncId, safePath, folder.historyCount);
    }

    const version: FileVersion = {
      syncId: folder.syncId,
      path: safePath,
      cid,
      size: fileStat.size,
      modTime: fileStat.mtimeMs,
      version: (current?.version ?? 0) + 1,
      updatedBy: this.options.peerId,
      updatedAt: Date.now(),
    };

    this.options.db.upsertFile(folder.syncId, version);
    await this.options.broadcast?.({ type: 'file-changed', from: this.options.peerId, ts: Date.now(), payload: version });
    return version;
  }

  async onLocalDelete(folder: SyncFolder, relativePath: string): Promise<void> {
    const safePath = this.safeRelativePath(relativePath);
    const current = this.options.db.getFile(folder.syncId, safePath);
    if (!current) return;

    this.options.db.addHistory(folder.syncId, current);
    this.options.db.deleteFile(folder.syncId, safePath);
    await this.options.broadcast?.({ type: 'file-deleted', from: this.options.peerId, ts: Date.now(), payload: { syncId: folder.syncId, path: safePath } });
  }

  async onRemoteDelete(folder: SyncFolder, payload: { syncId: string; path: string }): Promise<boolean> {
    const safePath = this.safeRelativePath(payload.path);
    if (payload.syncId !== folder.syncId || !this.matchesFilter(safePath, folder)) return false;

    const local = this.options.db.getFile(folder.syncId, safePath);
    if (!local) return false;

    this.options.db.addHistory(folder.syncId, local);
    this.options.db.deleteFile(folder.syncId, safePath);

    const fullPath = join(folder.localPath, safePath);
    this.writeLock.add(fullPath);
    await rm(fullPath, { force: true }).catch(() => undefined);
    setTimeout(() => this.writeLock.delete(fullPath), 1000);
    return true;
  }

  async onRemoteChange(folder: SyncFolder, remote: FileVersion): Promise<boolean> {
    const safePath = this.safeRelativePath(remote.path);
    if (!this.matchesFilter(safePath, folder)) return false;

    const local = this.options.db.getFile(remote.syncId, safePath);
    if (local?.cid === remote.cid) return false;

    if (local) {
      const winner = resolveConflict(local, remote);
      if (winner === 'local') return false;
      this.options.db.addHistory(folder.syncId, local);
    }

    let content = await this.options.ipfs.cat(remote.cid);
    await this.options.ipfs.pin(remote.cid);
    if (folder.encrypt) {
      content = decrypt(content, this.options.encryptionKey);
    }

    const fullPath = join(folder.localPath, safePath);
    await mkdir(dirname(fullPath), { recursive: true });
    this.writeLock.add(fullPath);
    await writeFile(fullPath, content);
    await utimes(fullPath, new Date(remote.modTime), new Date(remote.modTime));
    setTimeout(() => this.writeLock.delete(fullPath), 1000);

    this.options.db.upsertFile(folder.syncId, { ...remote, path: safePath });
    await this.cleanupHistory(folder.syncId, safePath, folder.historyCount);
    return true;
  }

  async triggerStateSync(targetPeerId: string): Promise<void> {
    await this.options.broadcast?.({
      type: 'state-sync',
      from: this.options.peerId,
      ts: Date.now(),
      payload: { targetPeerId, files: this.options.db.getAllFiles() },
    });
  }

  private async cleanupHistory(syncId: string, path: string, keepCount: number): Promise<void> {
    const expired = this.options.db.getExpiredHistory(syncId, path, keepCount);
    for (const entry of expired) {
      if (!this.options.db.isCidReferenced(entry.cid)) {
        await this.options.ipfs.unpin(entry.cid);
      }
      this.options.db.deleteHistory(entry.id);
    }
  }

  private safeRelativePath(relativePath: string): string {
    const normalized = normalize(relativePath).replace(/\\/g, '/');
    if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || isAbsolute(normalized)) {
      throw new Error(`invalid sync path: ${relativePath}`);
    }
    return normalized;
  }

  private matchesFilter(filePath: string, folder: SyncFolder): boolean {
    if (folder.include?.length) {
      return folder.include.some((pattern) => minimatch(filePath, pattern));
    }
    if (folder.exclude?.length) {
      return !folder.exclude.some((pattern) => minimatch(filePath, pattern));
    }
    return true;
  }
}
