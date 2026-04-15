export interface NodeInfo {
  nodeId: string;
  name: string;
}

export type TrustState = 'trusted' | 'untrusted';

export type MsgType =
  | 'announce'
  | 'trust-change'
  | 'file-changed'
  | 'file-deleted'
  | 'state-sync'
  | 'state-sync-req';

export interface PubSubMessage<T = unknown> {
  type: MsgType;
  from: string;
  ts: number;
  payload: T;
}

export interface FileVersion {
  syncId: string;
  path: string;
  cid: string;
  size: number;
  modTime: number;
  version: number;
  updatedBy: string;
  updatedAt: number;
}

export interface AnnouncePayload {
  name: string;
  syncFolderIds?: string[];
}

export interface SyncFolder {
  id: string;
  localPath: string;
  syncId: string;
  include?: string[];
  exclude?: string[];
  historyCount: number;
  encrypt: boolean;
}

export interface AppConfig {
  name: string;
  webPort: number;
  webAuth: { username: string; passwordHash: string };
  encryptionKey?: string;
  syncFolders: SyncFolder[];
  relay?: boolean;
  relayRetentionDays?: number;
}

export interface NodeRecord {
  node_id: string;
  name: string;
  trust: TrustState;
  trusts_me: number;
  last_seen: number;
}

export interface HistoryEntry extends FileVersion {
  id: number;
  savedAt: number;
}

export interface ServiceStatus {
  ok: boolean;
  peerId: string;
  kuboAvailable: boolean;
  nodeName: string;
}
