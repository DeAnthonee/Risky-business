import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Store } from './store.js';
import { createApi } from './http.js';
import { attachWebSocket } from './ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_FILE =
  process.env.RISK_DATA_FILE === 'none' ? null : resolve(process.env.RISK_DATA_FILE ?? join(__dirname, '../../../data/games.json'));
const CLIENT_DIR = resolve(process.env.RISK_CLIENT_DIR ?? join(__dirname, '../../client/dist'));

const store = new Store(DATA_FILE);
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use('/api', createApi(store));
app.get('/healthz', (_req, res) => res.json({ ok: true, games: store.rooms.size }));

if (existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, { index: 'index.html' }));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(join(CLIENT_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .type('text')
      .send(`Risk server running. Client build not found at ${CLIENT_DIR} - run "npm run build" to serve the web UI.\nAPI: /api/games`),
  );
}

const server = createServer(app);
attachWebSocket(server, store);

setInterval(() => store.sweep(), 10 * 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Risk server listening on http://${HOST}:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/games`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Data file: ${DATA_FILE ?? '(persistence disabled)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    store.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
