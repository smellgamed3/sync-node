import type { SyncDb } from './db.js';
import type { IpfsClient } from './ipfs-client.js';

export async function pruneHistory(db: SyncDb, ipfs: IpfsClient, syncId: string, path: string, keepCount: number): Promise<void> {
  const expired = db.getExpiredHistory(syncId, path, keepCount);
  for (const entry of expired) {
    if (!db.isCidReferenced(entry.cid)) {
      await ipfs.unpin(entry.cid);
    }
    db.deleteHistory(entry.id);
  }
}
