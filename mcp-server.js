// Read-only MCP server (Streamable HTTP, plain JSON responses) about the llama-server this
// controller runs. Separate process from server.js on purpose: llama-server's output is piped
// through server.js, so restarting that would put the running model at risk; this one can be
// started and stopped freely.
//   POST /mcp  JSON-RPC (single message or batch)   GET /mcp -> 405
// Requests not from loopback need "Authorization: Bearer <key>", key in secrets/mcp-api-key.txt
// (created on first start). Browser Origins other than this server's own are refused.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manager = require('./lib/manager');
const { handleMessage } = require('./lib/mcp');

const config = manager.loadConfig();
const PORT = Number(process.env.MCP_PORT) || config.mcpPort || 4571;
const HOST = process.env.MCP_HOST || config.mcpHost || '0.0.0.0';
const KEY_PATH = path.join(__dirname, 'secrets', 'mcp-api-key.txt');
const MAX_BODY = 1024 * 1024;

function loadKey() {
  if (!fs.existsSync(KEY_PATH)) {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, crypto.randomBytes(32).toString('base64url'));
    console.log(`created ${KEY_PATH}`);
  }
  return fs.readFileSync(KEY_PATH, 'utf8').trim();
}
const KEY = Buffer.from(loadKey());

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function authorized(req) {
  if (isLoopback(req.socket.remoteAddress)) return true;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const got = Buffer.from(m[1].trim());
  return got.length === KEY.length && crypto.timingSafeEqual(got, KEY);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser
  try { return new URL(origin).host === req.headers.host; } catch (err) { return false; }
}

function send(res, code, obj, extra = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(code, { ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
  if (!originAllowed(req)) return send(res, 403, { error: 'origin not allowed' });
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });

  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY && !aborted) {
      aborted = true;
      send(res, 413, { error: 'body too large' });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(c);
  });
  req.on('end', async () => {
    if (aborted) return;
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (err) {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    try {
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(handleMessage))).filter(Boolean);
        return out.length ? send(res, 200, out) : send(res, 202);
      }
      const out = await handleMessage(msg);
      return out ? send(res, 200, out) : send(res, 202);
    } catch (err) {
      return send(res, 500, { jsonrpc: '2.0', id: msg && msg.id, error: { code: -32603, message: 'internal error' } });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`llama-stroller MCP on http://${HOST}:${PORT}/mcp`);
});
