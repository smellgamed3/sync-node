import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_IPFS_API } from '../shared/constants.js';

export interface IpfsClient {
  add(content: Buffer): Promise<string>;
  cat(cid: string): Promise<Buffer>;
  pin(cid: string): Promise<void>;
  unpin(cid: string): Promise<void>;
  id(): Promise<{ ID: string; Addresses: string[] }>;
  swarmPeers(): Promise<string[]>;
  pubsubPublish(topic: string, data: string): Promise<void>;
  pubsubSubscribe(topic: string, onMessage: (from: string, data: string) => void): Promise<AbortController>;
  gc(): Promise<void>;
  health(): Promise<boolean>;
}

export class KuboHttpClient implements IpfsClient {
  constructor(private readonly api = process.env.IPFS_API ?? DEFAULT_IPFS_API) {}

  async add(content: Buffer): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)]), 'content.bin');
    const res = await fetch(`${this.api}/add?pin=true&quieter=true`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`ipfs add failed: ${res.status}`);
    const data = await res.json() as { Hash: string };
    return data.Hash;
  }

  async cat(cid: string): Promise<Buffer> {
    const res = await fetch(`${this.api}/cat?arg=${encodeURIComponent(cid)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`ipfs cat failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async pin(cid: string): Promise<void> {
    await fetch(`${this.api}/pin/add?arg=${encodeURIComponent(cid)}`, { method: 'POST' });
  }

  async unpin(cid: string): Promise<void> {
    await fetch(`${this.api}/pin/rm?arg=${encodeURIComponent(cid)}`, { method: 'POST' }).catch(() => undefined);
  }

  async id(): Promise<{ ID: string; Addresses: string[] }> {
    const res = await fetch(`${this.api}/id`, { method: 'POST' });
    if (!res.ok) throw new Error(`ipfs id failed: ${res.status}`);
    return await res.json() as { ID: string; Addresses: string[] };
  }

  async swarmPeers(): Promise<string[]> {
    const res = await fetch(`${this.api}/swarm/peers`, { method: 'POST' });
    if (!res.ok) return [];
    const data = await res.json() as { Peers?: Array<{ Peer: string }> };
    return (data.Peers ?? []).map((p) => p.Peer);
  }

  // kubo HTTP API 要求 topic 使用 multibase 编码（base64url, 前缀 'u'）
  private multibaseTopic(topic: string): string {
    return 'u' + Buffer.from(topic).toString('base64url');
  }

  async pubsubPublish(topic: string, data: string): Promise<void> {
    const mbTopic = this.multibaseTopic(topic);
    const form = new FormData();
    form.append('file', new Blob([data]), 'data');
    const res = await fetch(`${this.api}/pubsub/pub?arg=${mbTopic}`, { method: 'POST', body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`pubsub publish failed [${res.status}]: ${text}`);
    }
  }

  async pubsubSubscribe(topic: string, onMessage: (from: string, data: string) => void): Promise<AbortController> {
    const controller = new AbortController();
    const mbTopic = this.multibaseTopic(topic);
    const res = await fetch(`${this.api}/pubsub/sub?arg=${mbTopic}`, { method: 'POST', signal: controller.signal });
    if (!res.ok) console.warn(`pubsub sub [${topic}] failed: ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) { console.warn(`pubsub sub [${topic}]: no body reader`); return controller; }
    const decoder = new TextDecoder();
    let buffer = '';

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as { from: string; data: string };
              const raw = msg.data.startsWith('u')
                ? Buffer.from(msg.data.slice(1), 'base64url').toString('utf8')
                : Buffer.from(msg.data, 'base64').toString('utf8');
              onMessage(msg.from, raw);
            } catch (err) {
              console.warn(`pubsub parse error [${topic}]:`, err);
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) console.warn(`pubsub sub [${topic}] reader error:`, err);
      }
    })();

    return controller;
  }

  async gc(): Promise<void> {
    await fetch(`${this.api}/repo/gc`, { method: 'POST' });
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.api}/version`, { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    }
  }
}

type TopicHandler = { id: string; peerId: string; onMessage: (from: string, data: string) => void };

export class MemoryIpfsNetwork {
  readonly store = new Map<string, Buffer>();
  private readonly topics = new Map<string, TopicHandler[]>();

  publish(from: string, topic: string, data: string): void {
    const listeners = this.topics.get(topic) ?? [];
    for (const listener of listeners) {
      queueMicrotask(() => listener.onMessage(from, data));
    }
  }

  subscribe(topic: string, peerId: string, onMessage: (from: string, data: string) => void): AbortController {
    const controller = new AbortController();
    const item: TopicHandler = { id: randomUUID(), peerId, onMessage };
    const listeners = this.topics.get(topic) ?? [];
    listeners.push(item);
    this.topics.set(topic, listeners);

    controller.signal.addEventListener('abort', () => {
      const current = this.topics.get(topic) ?? [];
      this.topics.set(topic, current.filter((entry) => entry.id !== item.id));
    });

    return controller;
  }
}

export function createMemoryIpfsNetwork(): MemoryIpfsNetwork {
  return new MemoryIpfsNetwork();
}

export class NetworkedMemoryIpfsClient implements IpfsClient {
  private pinned = new Set<string>();

  constructor(private readonly network: MemoryIpfsNetwork, private readonly peerId: string = `memory-${randomUUID()}`) {}

  async add(content: Buffer): Promise<string> {
    const cid = createHash('sha256').update(content).digest('hex');
    this.network.store.set(cid, Buffer.from(content));
    this.pinned.add(cid);
    return cid;
  }

  async cat(cid: string): Promise<Buffer> {
    const value = this.network.store.get(cid);
    if (!value) throw new Error(`missing cid: ${cid}`);
    return Buffer.from(value);
  }

  async pin(cid: string): Promise<void> {
    this.pinned.add(cid);
  }

  async unpin(cid: string): Promise<void> {
    this.pinned.delete(cid);
  }

  isPinned(cid: string): boolean {
    return this.pinned.has(cid);
  }

  async id(): Promise<{ ID: string; Addresses: string[] }> {
    return { ID: this.peerId, Addresses: [] };
  }

  async swarmPeers(): Promise<string[]> {
    return [];
  }

  async pubsubPublish(topic: string, data: string): Promise<void> {
    this.network.publish(this.peerId, topic, data);
  }

  async pubsubSubscribe(topic: string, onMessage: (from: string, data: string) => void): Promise<AbortController> {
    return this.network.subscribe(topic, this.peerId, onMessage);
  }

  async gc(): Promise<void> {}

  async health(): Promise<boolean> {
    return true;
  }
}

export class MemoryIpfsClient extends NetworkedMemoryIpfsClient {
  constructor() {
    super(new MemoryIpfsNetwork());
  }
}
