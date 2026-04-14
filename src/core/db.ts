import Database from 'better-sqlite3';
import type { FileVersion, HistoryEntry, NodeRecord, TrustState } from '../shared/types.js';

export interface SyncDb {
  upsertNode(nodeId: string, name: string): void;
  listNodes(): NodeRecord[];
  getNode(nodeId: string): NodeRecord | undefined;
  setTrust(nodeId: string, state: TrustState): void;
  setTrustsMe(nodeId: string, value: boolean): void;
  getTrust(nodeId: string): TrustState | undefined;
  getMutualTrustedNodes(): NodeRecord[];
  upsertFile(syncId: string, version: FileVersion): void;
  getFile(syncId: string, path: string): FileVersion | undefined;
  listFiles(syncId?: string): FileVersion[];
  getAllFiles(): FileVersion[];
  addHistory(syncId: string, version: FileVersion): void;
  getExpiredHistory(syncId: string, path: string, keepCount: number): HistoryEntry[];
  isCidReferenced(cid: string): boolean;
  deleteHistory(id: number): void;
  deleteFile(syncId: string, path: string): void;
  close(): void;
}

class MemoryDb implements SyncDb {
  private nodes = new Map<string, NodeRecord>();
  private files = new Map<string, FileVersion>();
  private history: HistoryEntry[] = [];
  private nextId = 1;

  private key(syncId: string, path: string): string {
    return `${syncId}:${path}`;
  }

  upsertNode(nodeId: string, name: string): void {
    const current = this.nodes.get(nodeId);
    this.nodes.set(nodeId, {
      node_id: nodeId,
      name,
      trust: current?.trust ?? 'untrusted',
      trusts_me: current?.trusts_me ?? 0,
      last_seen: Date.now(),
    });
  }

  listNodes(): NodeRecord[] {
    return [...this.nodes.values()].sort((a, b) => b.last_seen - a.last_seen);
  }

  getNode(nodeId: string): NodeRecord | undefined {
    return this.nodes.get(nodeId);
  }

  setTrust(nodeId: string, state: TrustState): void {
    const current = this.nodes.get(nodeId) ?? { node_id: nodeId, name: nodeId, trust: 'untrusted' as TrustState, trusts_me: 0, last_seen: Date.now() };
    current.trust = state;
    current.last_seen = Date.now();
    this.nodes.set(nodeId, current);
  }

  setTrustsMe(nodeId: string, value: boolean): void {
    const current = this.nodes.get(nodeId) ?? { node_id: nodeId, name: nodeId, trust: 'untrusted' as TrustState, trusts_me: 0, last_seen: Date.now() };
    current.trusts_me = value ? 1 : 0;
    current.last_seen = Date.now();
    this.nodes.set(nodeId, current);
  }

  getTrust(nodeId: string): TrustState | undefined {
    return this.nodes.get(nodeId)?.trust;
  }

  getMutualTrustedNodes(): NodeRecord[] {
    return this.listNodes().filter((node) => node.trust === 'trusted' && node.trusts_me === 1);
  }

  upsertFile(syncId: string, version: FileVersion): void {
    this.files.set(this.key(syncId, version.path), version);
  }

  getFile(syncId: string, path: string): FileVersion | undefined {
    return this.files.get(this.key(syncId, path));
  }

  listFiles(syncId?: string): FileVersion[] {
    const all = [...this.files.values()];
    return syncId ? all.filter((file) => file.syncId === syncId) : all;
  }

  getAllFiles(): FileVersion[] {
    return this.listFiles();
  }

  addHistory(_syncId: string, version: FileVersion): void {
    this.history.unshift({ ...version, id: this.nextId++, savedAt: Date.now() });
  }

  getExpiredHistory(syncId: string, path: string, keepCount: number): HistoryEntry[] {
    const matching = this.history.filter((entry) => entry.syncId === syncId && entry.path === path).sort((a, b) => b.savedAt - a.savedAt);
    return matching.slice(keepCount);
  }

  isCidReferenced(cid: string): boolean {
    return this.listFiles().some((file) => file.cid === cid) || this.history.some((item) => item.cid === cid);
  }

  deleteHistory(id: number): void {
    this.history = this.history.filter((item) => item.id !== id);
  }

  deleteFile(syncId: string, path: string): void {
    this.files.delete(this.key(syncId, path));
  }

  close(): void {}
}

class SqliteSyncDb implements SyncDb {
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trust TEXT DEFAULT 'untrusted',
        trusts_me INTEGER DEFAULT 0,
        last_seen INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS files (
        sync_id TEXT NOT NULL,
        path TEXT NOT NULL,
        cid TEXT NOT NULL,
        size INTEGER NOT NULL,
        mod_time INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (sync_id, path)
      );
      CREATE TABLE IF NOT EXISTS file_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL,
        path TEXT NOT NULL,
        cid TEXT NOT NULL,
        size INTEGER NOT NULL,
        mod_time INTEGER NOT NULL,
        version INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        saved_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hist ON file_history(sync_id, path, saved_at DESC);
    `);
  }

  upsertNode(nodeId: string, name: string): void {
    this.db.prepare(`
      INSERT INTO nodes (node_id, name, last_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen
    `).run(nodeId, name, Date.now());
  }

  listNodes(): NodeRecord[] {
    return this.db.prepare('SELECT node_id, name, trust, trusts_me, last_seen FROM nodes ORDER BY last_seen DESC').all() as NodeRecord[];
  }

  getNode(nodeId: string): NodeRecord | undefined {
    return this.db.prepare('SELECT node_id, name, trust, trusts_me, last_seen FROM nodes WHERE node_id = ?').get(nodeId) as NodeRecord | undefined;
  }

  setTrust(nodeId: string, state: TrustState): void {
    const node = this.getNode(nodeId);
    if (!node) this.upsertNode(nodeId, nodeId);
    this.db.prepare('UPDATE nodes SET trust = ?, last_seen = ? WHERE node_id = ?').run(state, Date.now(), nodeId);
  }

  setTrustsMe(nodeId: string, value: boolean): void {
    const node = this.getNode(nodeId);
    if (!node) this.upsertNode(nodeId, nodeId);
    this.db.prepare('UPDATE nodes SET trusts_me = ?, last_seen = ? WHERE node_id = ?').run(value ? 1 : 0, Date.now(), nodeId);
  }

  getTrust(nodeId: string): TrustState | undefined {
    return this.getNode(nodeId)?.trust;
  }

  getMutualTrustedNodes(): NodeRecord[] {
    return this.db.prepare("SELECT node_id, name, trust, trusts_me, last_seen FROM nodes WHERE trust = 'trusted' AND trusts_me = 1 ORDER BY last_seen DESC").all() as NodeRecord[];
  }

  upsertFile(syncId: string, version: FileVersion): void {
    this.db.prepare(`
      INSERT INTO files (sync_id, path, cid, size, mod_time, version, updated_by, updated_at)
      VALUES (@syncId, @path, @cid, @size, @modTime, @version, @updatedBy, @updatedAt)
      ON CONFLICT(sync_id, path) DO UPDATE SET
        cid = excluded.cid,
        size = excluded.size,
        mod_time = excluded.mod_time,
        version = excluded.version,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(version);
  }

  getFile(syncId: string, path: string): FileVersion | undefined {
    const row = this.db.prepare('SELECT sync_id as syncId, path, cid, size, mod_time as modTime, version, updated_by as updatedBy, updated_at as updatedAt FROM files WHERE sync_id = ? AND path = ?').get(syncId, path);
    return row as FileVersion | undefined;
  }

  listFiles(syncId?: string): FileVersion[] {
    const sql = syncId
      ? 'SELECT sync_id as syncId, path, cid, size, mod_time as modTime, version, updated_by as updatedBy, updated_at as updatedAt FROM files WHERE sync_id = ? ORDER BY path'
      : 'SELECT sync_id as syncId, path, cid, size, mod_time as modTime, version, updated_by as updatedBy, updated_at as updatedAt FROM files ORDER BY sync_id, path';
    return (syncId ? this.db.prepare(sql).all(syncId) : this.db.prepare(sql).all()) as FileVersion[];
  }

  getAllFiles(): FileVersion[] {
    return this.listFiles();
  }

  addHistory(_syncId: string, version: FileVersion): void {
    this.db.prepare(`
      INSERT INTO file_history (sync_id, path, cid, size, mod_time, version, updated_by, updated_at, saved_at)
      VALUES (@syncId, @path, @cid, @size, @modTime, @version, @updatedBy, @updatedAt, @savedAt)
    `).run({ ...version, savedAt: Date.now() });
  }

  getExpiredHistory(syncId: string, path: string, keepCount: number): HistoryEntry[] {
    return this.db.prepare(`
      SELECT id, sync_id as syncId, path, cid, size, mod_time as modTime, version, updated_by as updatedBy, updated_at as updatedAt, saved_at as savedAt
      FROM file_history
      WHERE sync_id = ? AND path = ?
      ORDER BY saved_at DESC
      LIMIT -1 OFFSET ?
    `).all(syncId, path, keepCount) as HistoryEntry[];
  }

  isCidReferenced(cid: string): boolean {
    const fileCount = this.db.prepare('SELECT COUNT(*) as count FROM files WHERE cid = ?').get(cid) as { count: number };
    const histCount = this.db.prepare('SELECT COUNT(*) as count FROM file_history WHERE cid = ?').get(cid) as { count: number };
    return fileCount.count > 0 || histCount.count > 0;
  }

  deleteHistory(id: number): void {
    this.db.prepare('DELETE FROM file_history WHERE id = ?').run(id);
  }

  deleteFile(syncId: string, path: string): void {
    this.db.prepare('DELETE FROM files WHERE sync_id = ? AND path = ?').run(syncId, path);
  }

  close(): void {
    this.db.close();
  }
}

export function createMemoryDb(): SyncDb {
  return new MemoryDb();
}

export function createSqliteDb(filePath: string): SyncDb {
  return new SqliteSyncDb(filePath);
}
