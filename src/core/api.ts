import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { SyncDb } from './db.js';
import type { AppConfig, ServiceStatus } from '../shared/types.js';

interface BuildAppOptions {
  db: SyncDb;
  config: AppConfig;
  status: () => ServiceStatus;
}

function isAuthorized(request: FastifyRequest, config: AppConfig): boolean {
  if (!config.webAuth.passwordHash) return true;
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  const hash = createHash('sha256').update(password).digest('hex');
  return username === config.webAuth.username && hash === config.webAuth.passwordHash;
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).header('WWW-Authenticate', 'Basic').send({ error: 'Unauthorized' });
}

function htmlPage(nodeName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>FileSync</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; background: #f5f7fb; color: #222; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .card { background: white; border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    h1 { margin-top: 0; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>FileSync 控制台</h1>
  <p>节点名称：${nodeName}</p>
  <div class="grid">
    <div class="card"><h3>状态</h3><pre id="status">loading...</pre></div>
    <div class="card"><h3>节点</h3><pre id="nodes">loading...</pre></div>
    <div class="card"><h3>同步目录</h3><pre id="folders">loading...</pre></div>
    <div class="card"><h3>文件索引</h3><pre id="files">loading...</pre></div>
  </div>
  <script>
    async function load(id, url) {
      const res = await fetch(url);
      const data = await res.json();
      document.getElementById(id).textContent = JSON.stringify(data, null, 2);
    }
    load('status', '/api/status');
    load('nodes', '/api/nodes');
    load('folders', '/api/folders');
    load('files', '/api/files');
  </script>
</body>
</html>`;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('preHandler', async (request, reply) => {
    if (!isAuthorized(request, options.config)) {
      return unauthorized(reply);
    }
  });

  app.get('/', async (_request, reply) => reply.type('text/html').send(htmlPage(options.config.name)));
  app.get('/ui', async (_request, reply) => reply.type('text/html').send(htmlPage(options.config.name)));
  app.get('/api/status', async () => options.status());
  app.get('/api/nodes', async () => options.db.listNodes());
  app.get('/api/folders', async () => options.config.syncFolders);
  app.get('/api/files', async (request) => {
    const syncId = (request.query as { syncId?: string }).syncId;
    return options.db.listFiles(syncId);
  });
  app.get('/api/config', async () => ({ name: options.config.name, webPort: options.config.webPort, syncFolders: options.config.syncFolders }));

  return app;
}
