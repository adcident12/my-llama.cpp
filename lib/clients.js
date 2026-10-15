// Who connects to the model server and the controller: inbound connections from the Windows
// Firewall log (scripts/firewall-log.ps1 turns it on; it holds addresses and ports only), and
// llama-server's "Invalid API Key" events matched to the connection that most likely sent them.
const fs = require('fs');
const path = require('path');
const manager = require('./manager');
const logstats = require('./logstats');

const FW_DIR = path.join(logstats.LOGS_DIR, 'firewall');
const FW_FILES = ['pfirewall.log.old', 'pfirewall.log'];
const FW_COPY = 'inbound.log';
const DEFAULT_FIELDS = ['date', 'time', 'action', 'protocol', 'src-ip', 'dst-ip', 'src-port', 'dst-port', 'size', 'tcpflags', 'tcpsyn', 'tcpack', 'tcpwin', 'icmptype', 'icmpcode', 'info', 'path', 'pid'];
const MATCH_WINDOW_MS = 60 * 1000;

function classifyIp(ip) {
  if (/^127\.|^::1$/.test(ip)) return 'loopback';
  if (/^192\.168\.0\./.test(ip)) return 'lan';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 'private (other subnet)';
  const m = /^100\.(\d+)\./.exec(ip);
  if (m && +m[1] >= 64 && +m[1] <= 127) return 'cgnat / tailscale';
  if (/^169\.254\.|^fe80:/i.test(ip)) return 'link-local';
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return 'private (ipv6 ula)';
  return 'public internet';
}

function watchedPorts() {
  const config = manager.loadConfig();
  const ports = new Map();
  for (const p of Object.values(config.profiles)) ports.set(p.port, 'llama-server');
  ports.set(config.controlPort, 'controller (server.js)');
  ports.set(config.mcpPort || 4571, 'mcp-server.js');
  return ports;
}

// Inbound connections to the watched ports since `sinceMs`, oldest first. Reads inbound.log
// (the SYSTEM task's readable copy) when it exists, else the firewall's own files if this
// process may read them. A file that cannot be read is skipped and named in `notes`.
function readConnections(sinceMs, ports) {
  const out = [];
  const notes = [];
  let found = false;
  const copy = path.join(FW_DIR, FW_COPY);
  const names = fs.existsSync(copy) ? [FW_COPY] : FW_FILES;
  for (const name of names) {
    const file = path.join(FW_DIR, name);
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = logstats.readTail(file, 32 * 1024 * 1024); } catch (err) {
      notes.push(`${name}: ${err.code || 'unreadable'} (Windows lets only SYSTEM/Administrators read the firewall's own files; the scheduled task "llama-stroller firewall copy" makes ${FW_COPY})`);
      continue;
    }
    found = true;
    if (name === FW_COPY) {
      const m = /^#Copied: (\S+)/m.exec(text);
      if (m) notes.push(`${FW_COPY} last copied ${m[1]} (local time, every minute)`);
    }
    let fields = DEFAULT_FIELDS;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('#Fields:')) { fields = line.slice(8).trim().split(/\s+/); continue; }
      if (!line || line[0] === '#') continue;
      const v = line.split(' ');
      const f = {};
      fields.forEach((k, i) => { f[k] = v[i]; });
      if (f.path !== 'RECEIVE' || f.action !== 'ALLOW') continue;
      const port = Number(f['dst-port']);
      if (!ports.has(port)) continue;
      const at = new Date(`${f.date}T${f.time}`).getTime(); // the log's time is local
      if (!(at >= sinceMs)) continue;
      out.push({ at, ip: f['src-ip'], port, protocol: f.protocol });
    }
  }
  out.sort((a, b) => a.at - b.at);
  return { found, connections: out, notes };
}

// "Invalid API Key" times from every llama-server log that overlaps the window.
const unauthCache = new Map();
function unauthorizedTimes(sinceMs) {
  const times = [];
  for (const log of logstats.listLogs()) {
    const full = path.join(logstats.LOGS_DIR, log.file);
    const st = fs.statSync(full);
    if (st.mtimeMs < sinceMs) continue;
    let hit = unauthCache.get(log.file);
    if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
      const t = [];
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (line.includes('unauthorized: Invalid API Key')) {
          const d = logstats.lineTime(line, log.startedAt);
          if (d) t.push(d.getTime());
        }
      }
      hit = { size: st.size, mtimeMs: st.mtimeMs, times: t, port: (manager.loadConfig().profiles[log.profile] || {}).port };
      unauthCache.set(log.file, hit);
    }
    for (const t of hit.times) if (t >= sinceMs) times.push({ at: t, port: hit.port });
  }
  return times.sort((a, b) => a.at - b.at);
}

function iso(ms) { return new Date(ms).toISOString(); }

// When logging began: firewall-log.ps1 creates the folder when it turns logging on.
function firewallLogStart() {
  try { return fs.statSync(FW_DIR).birthtimeMs; } catch (err) { return null; }
}

function llamaClients({ hours = 24 } = {}) {
  hours = Math.min(Math.max(1, Number(hours) || 24), 168);
  const since = Date.now() - hours * 3600 * 1000;
  const ports = watchedPorts();
  const { found, connections, notes } = readConnections(since, ports);
  const logStart = firewallLogStart();

  const byKey = new Map();
  for (const c of connections) {
    const key = `${c.port}|${c.ip}`;
    const e = byKey.get(key) || { port: c.port, service: ports.get(c.port), ip: c.ip, network: classifyIp(c.ip), connections: 0, first: c.at, last: c.at };
    e.connections++;
    e.last = c.at;
    byKey.set(key, e);
  }

  // Match each Invalid API Key event to the latest connection to that port opened up to 60 s
  // before it (keep-alive connections carry several requests, so the window is generous).
  const unauth = unauthorizedTimes(since);
  const blame = new Map();
  let unmatched = 0;
  let beforeLogging = 0;
  let j = 0;
  const llamaConns = connections.filter((c) => ports.get(c.port) === 'llama-server');
  for (const u of unauth) {
    if (!logStart || u.at < logStart) { beforeLogging++; continue; }
    while (j < llamaConns.length && llamaConns[j].at <= u.at + 1000) j++;
    let pick = null;
    for (let k = j - 1; k >= 0 && llamaConns[k].at >= u.at - MATCH_WINDOW_MS; k--) {
      if (llamaConns[k].port === u.port) { pick = llamaConns[k]; break; }
    }
    if (!pick) { unmatched++; continue; }
    const e = blame.get(pick.ip) || { ip: pick.ip, network: classifyIp(pick.ip), events: 0, first: u.at, last: u.at };
    e.events++;
    e.last = u.at;
    blame.set(pick.ip, e);
  }

  return {
    window: { from: iso(since), to: iso(Date.now()), hours },
    firewallLog: found ? 'readable' : (fs.existsSync(FW_DIR) ? 'present but not readable yet' : 'missing: run scripts\\firewall-log.ps1 as Administrator to start logging connections'),
    firewallLogSince: logStart ? iso(logStart) : null,
    notes,
    note: 'Connections are inbound TCP connections, including loopback (127.0.0.1 = a program on this machine, e.g. the controller probing /health). One connection can carry many requests. Invalid-key events are matched to the latest connection to the same port within 60 s before them; "unmatched" means the request came on a connection opened more than 60 s earlier (keep-alive); "beforeLogging" events happened before firewall logging began and cannot be traced.',
    clients: [...byKey.values()]
      .sort((a, b) => b.connections - a.connections)
      .map((e) => ({ ...e, first: iso(e.first), last: iso(e.last) })),
    invalidApiKey: {
      events: unauth.length,
      bySource: [...blame.values()].sort((a, b) => b.events - a.events).map((e) => ({ ...e, first: iso(e.first), last: iso(e.last) })),
      unmatched,
      beforeLogging,
    },
  };
}

module.exports = { llamaClients, classifyIp };
