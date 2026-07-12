const http = require('http');
const fs = require('fs');
const path = require('path');
const manager = require('./lib/manager');
const { getGpuStats } = require('./lib/gpu');

const config = manager.loadConfig();
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { resolve({}); }
    });
  });
}

function serveStatic(req, res, urlPath) {
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const st = await manager.status();
      const gpu = getGpuStats();
      return sendJson(res, 200, { ...st, gpu });
    }

    if (url.pathname === '/api/profiles' && req.method === 'GET') {
      return sendJson(res, 200, { profiles: manager.listProfiles(), defaultProfile: config.defaultProfile });
    }

    if (url.pathname === '/api/start' && req.method === 'POST') {
      const body = await readBody(req);
      const state = manager.start(body.profile);
      return sendJson(res, 200, { ok: true, state });
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const result = manager.stop();
      return sendJson(res, 200, { ok: true, result });
    }

    if (url.pathname === '/api/restart' && req.method === 'POST') {
      const body = await readBody(req);
      const state = manager.restart(body.profile);
      return sendJson(res, 200, { ok: true, state });
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
      const lines = Number(url.searchParams.get('lines')) || 200;
      return sendJson(res, 200, { text: manager.tailLog(lines) });
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(config.controlPort, config.controlHost, () => {
  console.log(`llama-controller control server on http://${config.controlHost}:${config.controlPort}`);
});
