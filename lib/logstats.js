// Read-only figures from llama-server logs: per-request timings and classified errors.
// Never returns prompt or completion text: requests are numbers only, and error lines are
// reduced to a category plus text that comes from llama.cpp itself (never from a request).
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

// "<profile>_2026-10-13T01-31-46-672Z.log" -> { profile, startedAt }
function parseLogName(file) {
  const m = /^(.+)_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.log$/.exec(file);
  if (!m) return null;
  return { profile: m[1], startedAt: new Date(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`) };
}

function listLogs() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  return fs.readdirSync(LOGS_DIR)
    .map((file) => ({ file, ...parseLogName(file) }))
    .filter((l) => l.profile)
    .sort((a, b) => b.startedAt - a.startedAt);
}

// Log lines start with "M.SS.mmm.uuu" = minutes.seconds.millis.micros since the process started.
function lineTime(line, startedAt) {
  const m = /^(\d+)\.(\d{2})\.(\d{3})\.\d{3} /.exec(line);
  if (!m) return null;
  return new Date(startedAt.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]));
}

function readTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // drop the first, probably partial, line when we did not start at 0
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

const R_AVAIL = /get_availabl: id +(\d+) .*?(?:f_keep = ([\d.]+)|LRU)/;
const R_LAUNCH = /launch_slot_: id +(\d+) \| task (\d+)/;
const R_PEVAL = /task (\d+) \| prompt eval time = +([\d.]+) ms \/ +(\d+) tokens/;
const R_EVAL = /task (\d+) \| +eval time = +([\d.]+) ms \/ +(\d+) tokens/;
const R_DRAFT = /task (\d+) \| draft acceptance = ([\d.]+)/;
const R_REL = /release: id +(\d+) \| task (\d+) \| stop processing: n_tokens = (\d+), truncated = (\d+)/;

// Requests from a log, oldest first. `cached` = tokens the slot's cache shared with the prompt;
// `reprocessed` = tokens prefilled beyond the point where the prompt diverged (checkpoint rollback).
function parseRequests(text, startedAt) {
  const lastRel = {};
  const tasks = new Map();
  let pending = null;
  for (const line of text.split('\n')) {
    let m;
    if ((m = R_AVAIL.exec(line))) { pending = { slot: +m[1], fKeep: m[2] ? +m[2] : 0 }; continue; }
    if ((m = R_LAUNCH.exec(line))) {
      const slot = +m[1];
      const fKeep = pending && pending.slot === slot ? pending.fKeep : 0;
      tasks.set(+m[2], { slot, prev: lastRel[slot] || 0, fKeep, start: lineTime(line, startedAt) });
      pending = null;
      continue;
    }
    if ((m = R_PEVAL.exec(line)) && tasks.has(+m[1])) { Object.assign(tasks.get(+m[1]), { promptMs: +m[2], processed: +m[3] }); continue; }
    if ((m = R_EVAL.exec(line)) && tasks.has(+m[1])) { Object.assign(tasks.get(+m[1]), { genMs: +m[2], generated: +m[3] }); continue; }
    if ((m = R_DRAFT.exec(line)) && tasks.has(+m[1])) { tasks.get(+m[1]).draftAcceptance = +m[2]; continue; }
    if ((m = R_REL.exec(line))) {
      lastRel[+m[1]] = +m[3];
      const t = tasks.get(+m[2]);
      if (t) Object.assign(t, { end: lineTime(line, startedAt), nTokens: +m[3], truncated: m[4] !== '0' });
    }
  }
  const out = [];
  for (const [task, t] of tasks) {
    if (t.processed == null || t.generated == null || t.nTokens == null) continue;
    const prompt = t.nTokens - t.generated;
    const cached = Math.min(Math.round(t.fKeep * t.prev), prompt);
    out.push({
      at: t.start ? t.start.toISOString() : null,
      task,
      slot: t.slot,
      promptTokens: prompt,
      cachedTokens: cached,
      prefilledTokens: t.processed,
      reprocessedTokens: Math.max(t.processed - Math.max(prompt - cached, 1), 0),
      prefillMs: Math.round(t.promptMs),
      prefillTps: t.promptMs ? +(t.processed / t.promptMs * 1000).toFixed(1) : null,
      generatedTokens: t.generated,
      generateMs: Math.round(t.genMs),
      generateTps: t.genMs ? +(t.generated / t.genMs * 1000).toFixed(1) : null,
      draftAcceptance: t.draftAcceptance ?? null,
      totalMs: t.start && t.end ? t.end - t.start : null,
      truncated: t.truncated,
    });
  }
  return out;
}

// Error categories. `detail` may only take text that llama.cpp writes itself.
const CATEGORIES = [
  { kind: 'bad_alloc', re: /bad allocation|bad_alloc/ },
  { kind: 'ggml_assert', re: /([\w.-]+\.(?:cpp|cu|c|h)):(\d+): GGML_ASSERT\((.{0,160})\) failed/, detail: (m) => `${m[1]}:${m[2]} ${m[3]}` },
  { kind: 'cuda_oom', re: /cudaMalloc failed: out of memory|CUDA error: out of memory/ },
  { kind: 'cuda_error', re: /CUDA error(?::\s*([a-z ]{1,60}))?/, detail: (m) => m[1] || null },
  { kind: 'alloc_failed', re: /failed to allocate|compute buffer allocation failed/ },
  { kind: 'chat_template_error', re: /While executing .* in source/ },
  { kind: 'unauthorized', re: /unauthorized: Invalid API Key/ },
  { kind: 'cancelled', re: /cancel task, id_task/ },
];
const R_LEVEL = /^[\d.]+ ([EW]) +(\S+(?: +\S+)?):/;

function classify(line) {
  for (const c of CATEGORIES) {
    const m = c.re.exec(line);
    if (m) return { kind: c.kind, detail: c.detail ? c.detail(m) : null };
  }
  const lv = R_LEVEL.exec(line);
  if (lv && lv[1] === 'E') return { kind: 'other_error', detail: lv[2].replace(/\s+/g, ' ') };
  return null;
}

const FATAL = new Set(['bad_alloc', 'ggml_assert', 'cuda_oom', 'cuda_error']);
const cache = new Map(); // file -> { size, mtimeMs, summary }

// One run of llama-server = one log file. Scans the whole file (cached by size + mtime).
function summarizeRun(log, isCurrent) {
  const full = path.join(LOGS_DIR, log.file);
  const st = fs.statSync(full);
  const hit = cache.get(log.file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { ...hit.summary, state: runState(hit.summary, isCurrent) };

  const counts = {};
  const firstLast = {};
  let lastTime = null;
  let requests = 0;
  let lastFatal = null;
  let lastLineFatal = false;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    const t = lineTime(line, log.startedAt);
    if (t) lastTime = t;
    if (line.includes('launch_slot_:')) requests++;
    const c = classify(line);
    lastLineFatal = !!(c && FATAL.has(c.kind));
    if (!c) continue;
    const key = c.detail ? `${c.kind}|${c.detail}` : c.kind;
    counts[key] = (counts[key] || 0) + 1;
    const at = (t || lastTime) ? (t || lastTime).toISOString() : null;
    if (!firstLast[key]) firstLast[key] = { first: at };
    firstLast[key].last = at;
    if (FATAL.has(c.kind)) lastFatal = { kind: c.kind, detail: c.detail, at };
  }
  const tailFatal = lines.slice(-8).some((l) => { const c = classify(l); return c && FATAL.has(c.kind); });
  const summary = {
    profile: log.profile,
    startedAt: log.startedAt.toISOString(),
    lastLogAt: lastTime ? lastTime.toISOString() : null,
    requests,
    endedWith: tailFatal || lastLineFatal ? lastFatal : null,
    events: Object.entries(counts).map(([key, n]) => {
      const cut = key.indexOf('|');
      const kind = cut < 0 ? key : key.slice(0, cut);
      const detail = cut < 0 ? null : key.slice(cut + 1);
      return { kind, detail: detail || undefined, count: n, ...firstLast[key] };
    }).sort((a, b) => b.count - a.count),
  };
  cache.set(log.file, { size: st.size, mtimeMs: st.mtimeMs, summary });
  return { ...summary, state: runState(summary, isCurrent) };
}

function runState(summary, isCurrent) {
  if (isCurrent) return 'running';
  if (summary.endedWith) return 'crashed';
  return 'stopped'; // stopped by the controller (taskkill leaves no line) or still unknown
}

module.exports = { LOGS_DIR, listLogs, parseLogName, readTail, parseRequests, summarizeRun, lineTime };
