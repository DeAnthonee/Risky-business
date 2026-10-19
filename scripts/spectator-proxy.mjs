import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLIENT_DIST = path.resolve(REPO_ROOT, 'packages', 'client', 'dist');

function getTargetPort() {
  const portFile = path.resolve(REPO_ROOT, 'data', 'active-port.txt');
  if (fs.existsSync(portFile)) {
    try {
      const p = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      if (p > 0) return p;
    } catch {}
  }
  return parseInt(process.env.TARGET_PORT || process.argv[2] || '61731', 10);
}

const LISTEN_PORT = parseInt(process.env.PORT || process.argv[3] || '5173', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const targetPort = getTargetPort();
  // Proxy API requests
  if (req.url && (req.url.startsWith('/api/') || req.url === '/api')) {
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Bad Gateway: ${err.message}`);
    });
    req.pipe(proxyReq);
    return;
  }

  // Serve static client files
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  let filePath = path.join(CLIENT_DIST, pathname);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback to index.html
    filePath = path.join(CLIENT_DIST, 'index.html');
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
    });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`File Not Found: ${err.message}`);
  }
});

// Proxy WebSocket upgrade requests
server.on('upgrade', (req, clientSocket, head) => {
  const targetPort = getTargetPort();
  const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
    proxySocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      proxySocket.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
    }
    proxySocket.write('\r\n');
    if (head && head.length > 0) {
      proxySocket.write(head);
    }
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxySocket.on('error', () => {
    clientSocket.destroy();
  });
  clientSocket.on('error', () => {
    proxySocket.destroy();
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[Spectator Proxy] Listening on http://127.0.0.1:${LISTEN_PORT}`);
  console.log(`[Spectator Proxy] Forwarding to Risk Server on port ${getTargetPort()}`);
});
