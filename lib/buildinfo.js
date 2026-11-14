// Which llama.cpp build the running llama-server is, for GET /api/status.
// Read once per run (cached by pid + start time): first from the start of the run's log,
// then from `llama-server --version`. Only the build number and commit leave this module.
const fs = require('fs');
const { execFile } = require('child_process');

const LOG_HEAD_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 10000;

// "version: 1.0.0-dev (build 12359, commit b1b770d90)" (--version, newer logs) or
// "build: 9949 (049326a00) with ..." (older logs).
function parseBuild(text) {
  if (!text) return null;
  let m = /version: \S+ \(build (\d+), commit ([0-9a-f]+)\)/.exec(text);
  if (!m) m = /(?:^|\n)\S*\s*build: (\d+) \(([0-9a-f]+)\)/.exec(text);
  return m ? { number: Number(m[1]), commit: m[2] } : null;
}

function buildFromLog(logFile) {
  let fd;
  try {
    fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(LOG_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, LOG_HEAD_BYTES, 0);
    return parseBuild(buf.toString('utf8', 0, n));
  } catch (err) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function buildFromExe(exe, startedAt) {
  return new Promise((resolve) => {
    let st;
    try { st = fs.statSync(exe); } catch (err) { return resolve(null); }
    // Replaced after this run started (an upgrade while the model was up): --version would
    // describe the new file, not the running process.
    if (startedAt && st.mtimeMs > new Date(startedAt).getTime()) return resolve(null);
    execFile(exe, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      resolve(parseBuild(`${stdout || ''}\n${stderr || ''}`));
    });
  });
}

const cache = new Map(); // `${pid}:${startedAt}` -> Promise<{number, commit} | null>

function runBuild(state, exe) {
  if (!state || !state.pid) return Promise.resolve(null);
  const key = `${state.pid}:${state.startedAt}`;
  if (!cache.has(key)) {
    cache.clear(); // one run at a time
    cache.set(key, (async () => (state.logFile && buildFromLog(state.logFile)) || (exe ? buildFromExe(exe, state.startedAt) : null))());
  }
  return cache.get(key);
}

module.exports = { parseBuild, buildFromLog, buildFromExe, runBuild };
