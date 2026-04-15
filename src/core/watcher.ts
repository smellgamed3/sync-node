import chokidar, { type FSWatcher } from 'chokidar';
import { relative } from 'node:path';
import type { SyncFolder } from '../shared/types.js';
import { SyncEngine } from './sync-engine.js';

export class Watcher {
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(private readonly engine: SyncEngine) {}

  start(folders: SyncFolder[]): void {
    for (const folder of folders) {
      const watcher = chokidar.watch(folder.localPath, {
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        ignored: ['**/.filesync/**', '**/node_modules/**'],
      });

      const handle = async (fullPath: string) => {
        if (this.engine.isWriteLocked(fullPath)) return;
        const rel = relative(folder.localPath, fullPath);
        await this.engine.onLocalChange(folder, rel, fullPath).catch((err) =>
          console.warn(`watcher onLocalChange error [${rel}]:`, err));
      };

      watcher.on('add', handle);
      watcher.on('change', handle);
      watcher.on('unlink', (fullPath) => {
        if (this.engine.isWriteLocked(fullPath)) return;
        const rel = relative(folder.localPath, fullPath);
        void this.engine.onLocalDelete(folder, rel);
      });

      this.watchers.set(folder.id, watcher);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close()));
    this.watchers.clear();
  }
}
