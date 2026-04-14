export const DEFAULT_WEB_PORT = 8384;
export const DEFAULT_IPFS_API = 'http://127.0.0.1:5001/api/v0';
export const TOPIC_ANNOUNCE = 'filesync/announce';
export const topicSync = (peerId: string) => `filesync/sync/${peerId}`;
export const HISTORY_KEEP_COUNT = 5;
