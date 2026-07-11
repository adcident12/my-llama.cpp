const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');
const LOGS_DIR = path.join(ROOT, 'logs');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function clearState() {
  try {
    fs.unlinkSync(STATE_PATH);
  } catch (err) {
    // already gone
  }
}

function isPidAlive(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FI', 'IMAGENAME eq llama-server.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return out.toLowerCase().includes('llama-server.exe');
  } catch (err) {
    return false;
  }
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
  } catch (err) {
    // process may already be gone
  }
}

function resolveModelPath(config, profile) {
  return path.join(config.modelsDir, profile.model);
}

function buildArgs(config, profile) {
  const args = [
    '-m', resolveModelPath(config, profile),
    '--host', profile.host || '127.0.0.1',
    '--port', String(profile.port),
    '-ngl', String(profile.gpuLayers ?? 999),
    '-c', String(profile.ctxSize ?? 8192),
  ];
  if (profile.flashAttn) args.push('-fa', profile.flashAttn);
  if (profile.cacheTypeK) args.push('-ctk', profile.cacheTypeK);
  if (profile.cacheTypeV) args.push('-ctv', profile.cacheTypeV);
  if (profile.parallel) args.push('--parallel', String(profile.parallel));
  if (profile.extraArgs) {
    args.push(...profile.extraArgs.split(' ').filter(Boolean));
  }
  return args;
}

function listProfiles() {
  const config = loadConfig();
  return Object.keys(config.profiles).map((name) => ({ name, ...config.profiles[name] }));
}

function currentlyRunning() {
  const state = readState();
  if (!state) return null;
  if (!isPidAlive(state.pid)) return null;
  return state;
}

function start(profileName) {
  const config = loadConfig();
  const name = profileName || config.defaultProfile;
  const profile = config.profiles[name];
  if (!profile) throw new Error(`unknown profile: ${name}`);
  if (profile.broken) throw new Error(`profile "${name}" is marked broken: ${profile.note || 'see config.json'}`);

  const running = currentlyRunning();
  if (running) throw new Error(`already running (profile "${running.profile}", pid ${running.pid}) - stop it first`);

  const modelPath = resolveModelPath(config, profile);
  if (!fs.existsSync(modelPath)) throw new Error(`model file not found: ${modelPath}`);

  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOGS_DIR, `${name}_${timestamp}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const serverExe = path.join(config.llamaDir, 'llama-server.exe');
  const args = buildArgs(config, profile);

  const child = spawn(serverExe, args, {
    cwd: config.llamaDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.unref();

  const state = {
    pid: child.pid,
    profile: name,
    host: profile.host || '127.0.0.1',
    port: profile.port,
    startedAt: new Date().toISOString(),
    logFile,
    manuallyStopped: false,
  };
  writeState(state);
  return state;
}

function stop(markManual = true) {
  const state = readState();
  if (!state) return { wasRunning: false };
  if (isPidAlive(state.pid)) killPid(state.pid);
  if (markManual) {
    clearState();
  } else {
    writeState({ ...state, manuallyStopped: false });
  }
  return { wasRunning: true, profile: state.profile };
}

function restart(profileName) {
  const state = readState();
  const target = profileName || (state && state.profile);
  stop();
  return start(target);
}

function probeHealth(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

async function status() {
  const state = readState();
  if (!state) return { running: false };

  const alive = isPidAlive(state.pid);
  if (!alive) {
    return { running: false, crashed: true, lastProfile: state.profile, logFile: state.logFile };
  }

  const health = await probeHealth(state.host, state.port);
  const uptimeMs = Date.now() - new Date(state.startedAt).getTime();

  return {
    running: true,
    healthy: health.ok,
    loading: !health.ok,
    pid: state.pid,
    profile: state.profile,
    host: state.host,
    port: state.port,
    startedAt: state.startedAt,
    uptimeMs,
    logFile: state.logFile,
  };
}

function tailLog(lines = 200) {
  const state = readState();
  const logFile = state && state.logFile;
  if (!logFile || !fs.existsSync(logFile)) return '';
  const content = fs.readFileSync(logFile, 'utf8');
  const allLines = content.split('\n');
  return allLines.slice(-lines).join('\n');
}

module.exports = {
  loadConfig,
  listProfiles,
  start,
  stop,
  restart,
  status,
  tailLog,
  readState,
};
