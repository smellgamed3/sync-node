import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/core/api.js';
import { createMemoryDb } from '../src/core/db.js';

describe('api', () => {
  it('returns status from the health endpoint', async () => {
    const db = createMemoryDb();
    const app = buildApp({
      db,
      status: () => ({ ok: true, peerId: 'peer-a', kuboAvailable: false, nodeName: 'test-node' }),
      config: { name: 'test-node', webPort: 8384, webAuth: { username: 'admin', passwordHash: '' }, syncFolders: [], encryptionKey: 'x' }
    });

    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    await app.close();
  });
});
