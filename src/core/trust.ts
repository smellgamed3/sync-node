import type { SyncDb } from './db.js';
import type { TrustState } from '../shared/types.js';

interface TrustOptions {
  db: SyncDb;
  onTrustNotify?: (targetPeerId: string, trusted: boolean) => Promise<void> | void;
  onMutualTrust?: (targetPeerId: string) => Promise<void> | void;
}

export class TrustManager {
  constructor(private readonly options: TrustOptions) {}

  async setTrust(targetPeerId: string, state: TrustState): Promise<void> {
    const prev = this.options.db.getNode(targetPeerId);
    this.options.db.setTrust(targetPeerId, state);
    await this.options.onTrustNotify?.(targetPeerId, state === 'trusted');

    if (state === 'trusted' && prev?.trusts_me) {
      await this.options.onMutualTrust?.(targetPeerId);
    }
  }

  async onRemoteTrustChange(from: string, payload: { trusted: boolean }): Promise<void> {
    this.options.db.setTrustsMe(from, payload.trusted);
    if (payload.trusted && this.options.db.getTrust(from) === 'trusted') {
      await this.options.onMutualTrust?.(from);
    }
  }

  isMutualTrust(peerId: string): boolean {
    const node = this.options.db.getNode(peerId);
    return !!node && node.trust === 'trusted' && node.trusts_me === 1;
  }
}
