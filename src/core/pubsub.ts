import { TOPIC_ANNOUNCE, topicSync } from '../shared/constants.js';
import type { AnnouncePayload, PubSubMessage } from '../shared/types.js';
import type { SyncDb } from './db.js';
import type { IpfsClient } from './ipfs-client.js';

interface PubSubOptions {
  ipfs: IpfsClient;
  db: SyncDb;
  myPeerId: string;
  name: string;
  onAnnounce?: (from: string, msg: PubSubMessage<AnnouncePayload>) => Promise<void> | void;
  onDirectMessage?: (from: string, msg: PubSubMessage) => Promise<void> | void;
}

export class PubSubManager {
  private controllers: AbortController[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: PubSubOptions) {}

  async start(): Promise<void> {
    this.controllers.push(await this.options.ipfs.pubsubSubscribe(TOPIC_ANNOUNCE, (from, data) => {
      try {
        const msg = JSON.parse(data) as PubSubMessage<AnnouncePayload>;
        if (from !== this.options.myPeerId) {
          const name = msg.payload?.name ?? from;
          this.options.db.upsertNode(from, name);
          void this.options.onAnnounce?.(from, msg);
        }
      } catch {
        // ignore malformed payload
      }
    }));

    this.controllers.push(await this.options.ipfs.pubsubSubscribe(topicSync(this.options.myPeerId), (from, data) => {
      try {
        const msg = JSON.parse(data) as PubSubMessage;
        void this.options.onDirectMessage?.(from, msg);
      } catch {
        // ignore malformed payload
      }
    }));

    await this.announce();
    const intervalMs = parseInt(process.env.FILESYNC_ANNOUNCE_INTERVAL ?? '30000', 10);
    this.timer = setInterval(() => void this.announce(), intervalMs);
  }

  async announce(): Promise<void> {
    const msg: PubSubMessage<AnnouncePayload> = {
      type: 'announce',
      from: this.options.myPeerId,
      ts: Date.now(),
      payload: { name: this.options.name },
    };
    await this.options.ipfs.pubsubPublish(TOPIC_ANNOUNCE, JSON.stringify(msg));
  }

  async sendTo(peerId: string, msg: PubSubMessage): Promise<void> {
    await this.options.ipfs.pubsubPublish(topicSync(peerId), JSON.stringify(msg));
  }

  async broadcastToTrusted(msg: PubSubMessage): Promise<void> {
    const nodes = this.options.db.getMutualTrustedNodes();
    for (const node of nodes) {
      await this.sendTo(node.node_id, msg);
    }
  }

  stop(): void {
    this.controllers.forEach((controller) => controller.abort());
    if (this.timer) clearInterval(this.timer);
  }
}
