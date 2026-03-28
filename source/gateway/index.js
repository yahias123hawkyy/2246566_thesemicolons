/**
 * GATEWAY SERVICE — Single entry point for the Dashboard.
 *
 * Routes:
 *  GET  /gateway/health          → gateway own liveness
 *  GET  /gateway/replicas        → replica health status list
 *  *    /api/*                   → round-robin proxy to healthy processor replica
 *  POST /admin/shutdown          → proxy to simulator POST /api/admin/shutdown
 *  POST /admin/sensors/:id/events→ proxy to simulator POST /api/admin/sensors/:id/events
 *  GET  /admin/devices           → proxy to simulator GET /api/devices/
 *  *                             → serve static dashboard SPA
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT || '8000', 10);
const HEALTH_INTERVAL = parseInt(process.env.HEALTH_INTERVAL_MS || '5000', 10);
const SIMULATOR_HTTP  = process.env.SIMULATOR_HTTP || 'http://simulator:8080';

const replicaEnv = process.env.PROCESSOR_URLS
  || 'http://processor1:3001,http://processor2:3001,http://processor3:3001';

const replicas = replicaEnv.split(',').map(url => ({
  url: url.trim(),
  healthy: false,
  failures: 0,
}));

console.log(`[gateway] Managing ${replicas.length} replica(s):`, replicas.map(r => r.url));

// ── Round-robin ───────────────────────────────────────────────────────────────
let rrIndex = 0;

function nextHealthy() {
  const alive = replicas.filter(r => r.healthy);
  if (alive.length === 0) return null;
  const replica = alive[rrIndex % alive.length];
  rrIndex = (rrIndex + 1) % alive.length;
  return replica;
}

// ── Health check loop ─────────────────────────────────────────────────────────
async function checkHealth(replica) {
  return new Promise((resolve) => {
    const mod = replica.url.startsWith('https') ? https : http;
    const req = mod.get(`${replica.url}/health`, { timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function healthLoop() {
  for (const replica of replicas) {
    const wasHealthy = replica.healthy;
    const ok = await checkHealth(replica);
    replica.healthy = ok;
    if (ok) {
      replica.failures = 0;
      if (!wasHealthy) console.log(`[gateway] ✓ Replica ${replica.url} ONLINE`);
    } else {
      replica.failures++;
      if (wasHealthy) console.warn(`[gateway] ✗ Replica ${replica.url} OFFLINE`);
    }
  }
}

setInterval(healthLoop, HEALTH_INTERVAL);
healthLoop();

// ── Generic proxy helper ──────────────────────────────────────────────────────
function proxyTo(targetBase, targetPath, clientReq, clientRes) {
  const url = new URL(targetBase);
  const options = {
    hostname: url.hostname,
    port:     url.port || 80,
    path:     targetPath,
    method:   clientReq.method,
    headers:  { ...clientReq.headers, host: url.host },
  };

  const mod = url.protocol === 'https:' ? https : http;
  const proxyReq = mod.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', (err) => {
    console.error(`[gateway] Proxy error to ${targetBase}${targetPath}: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'upstream unavailable' }));
    }
  });

  clientReq.pipe(proxyReq);
}

// ── Static file server ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath  = new URL(req.url, 'http://localhost').pathname;
  const filePath = path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath);
  const mime     = MIME[path.extname(filePath)] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const p = urlObj.pathname;

  // Gateway self
  if (p === '/gateway/health') {
    const alive = replicas.filter(r => r.healthy).map(r => r.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', healthy_replicas: alive, total: replicas.length }));
    return;
  }

  if (p === '/gateway/replicas') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(replicas.map(r => ({
      url: r.url, healthy: r.healthy, failures: r.failures,
    }))));
    return;
  }

  // Admin passthrough → simulator
  // POST /admin/shutdown        → simulator POST /api/admin/shutdown
  // POST /admin/sensors/:id/events → simulator POST /api/admin/sensors/:id/events
  // GET  /admin/devices         → simulator GET /api/devices/
  if (p.startsWith('/admin/')) {
    const simPath = p.replace('/admin/', '/api/admin/');
    // Special case: /admin/devices → /api/devices/
    const finalPath = p === '/admin/devices'
      ? '/api/devices/'
      : simPath + (urlObj.search || '');
    proxyTo(SIMULATOR_HTTP, finalPath, req, res);
    return;
  }

  // Processor API proxy → round-robin to healthy replica
  if (p.startsWith('/api/')) {
    const replica = nextHealthy();
    if (!replica) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no healthy replicas available' }));
      return;
    }
    const targetPath = p.replace('/api', '') + (urlObj.search || '');
    proxyTo(replica.url, targetPath, req, res);
    return;
  }

  // Static dashboard
  serveStatic(req, res);
});

server.listen(PORT, () => console.log(`[gateway] Listening on :${PORT}`));
