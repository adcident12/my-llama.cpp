// MCP tools (read-only) about the llama-server this controller runs, and the JSON-RPC handler.
// Rules: no prompt or completion text, no keys, no paths outside this repo (paths are cut to
// their file name).
const fs = require('fs');
const http = require('http');
const path = require('path');
const manager = require('./manager');
const { getGpuStats } = require('./gpu');
const logstats = require('./logstats');

const SERVER_INFO = { name: 'llama-stroller', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function scrubPaths(s) {
  return typeof s === 'string' ? s.replace(/[A-Za-z]:[\\/][^\s"',;]+/g, (p) => path.basename(p)) : s;
}

// extraArgs -> { flag: value | true }, with paths cut to file names and key files hidden.
function parseFlags(extraArgs) {
  const parts = (extraArgs || '').split(' ').filter(Boolean);
  const flags = {};
  for (let i = 0; i < parts.length; i++) {
    const flag = parts[i];
    if (!flag.startsWith('-')) continue;
    const next = parts[i + 1];
    const hasValue = next !== undefined && (!next.startsWith('-') || /^-\d/.test(next));
    let value = hasValue ? next : true;
    if (hasValue) i++;
    if (/api-key/.test(flag)) value = '(set)';
    flags[flag] = scrubPaths(value);
  }
  return flags;
}

function apiKeyFor(profile) {
  const m = /--api-key-file (\S+)/.exec((profile && profile.extraArgs) || '');
  try { return m ? fs.readFileSync(m[1], 'utf8').trim() : null; } catch (err) { return null; }
}

function llamaGet(state, urlPath, key, timeoutMs = 2000) {
  const host = state.host === '0.0.0.0' ? '127.0.0.1' : state.host;
  return new Promise((resolve) => {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const req = http.get({ host, port: state.port, path: urlPath, headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (err) { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}

function currentProfile() {
  const state = manager.readState();
  if (!state) return { state: null, profile: null };
  return { state, profile: manager.loadConfig().profiles[state.profile] || null };
}

function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

// ---------- tools ----------

async function llamaStatus() {
  const st = await manager.status();
  const out = {
    running: st.running,
    crashed: st.crashed || false,
    profile: st.profile || st.lastProfile || null,
    healthy: st.healthy ?? false,
    loading: st.loading ?? false,
    pid: st.pid ?? null,
    port: st.port ?? null,
    startedAt: st.startedAt ?? null,
    uptimeMin: st.uptimeMs != null ? Math.round(st.uptimeMs / 60000) : null,
    gpus: getGpuStats(),
  };
  if (st.running) {
    const { state, profile } = currentProfile();
    const props = await llamaGet(state, '/props', apiKeyFor(profile));
    if (props.json) {
      const p = props.json;
      out.server = {
        build: p.build_info,
        modelAlias: p.model_alias,
        modelFile: p.model_path ? path.basename(p.model_path) : null,
        modelType: p.model_ftype,
        nCtx: p.default_generation_settings && p.default_generation_settings.n_ctx,
        totalSlots: p.total_slots,
        modalities: p.modalities,
        sleeping: p.is_sleeping,
        endpoints: { slots: p.endpoint_slots, metrics: p.endpoint_metrics },
      };
    } else {
      out.server = { error: props.status ? `props returned HTTP ${props.status}` : 'no answer from llama-server' };
    }
  }
  return out;
}

function llamaProfiles({ withNotes = false } = {}) {
  const config = manager.loadConfig();
  const state = manager.readState();
  return {
    defaultProfile: config.defaultProfile,
    current: state ? state.profile : null,
    profiles: Object.entries(config.profiles).map(([name, p]) => ({
      name,
      current: state ? state.profile === name : false,
      broken: !!p.broken,
      model: p.model,
      llamaBuildDir: path.basename(p.llamaDir || config.llamaDir),
      port: p.port,
      ctxSize: p.ctxSize ?? 8192,
      parallel: p.parallel ?? null,
      gpuLayers: p.gpuLayers ?? 999,
      flashAttn: p.flashAttn ?? null,
      cacheTypeK: p.cacheTypeK ?? null,
      cacheTypeV: p.cacheTypeV ?? null,
      flags: parseFlags(p.extraArgs),
      ...(withNotes && p.note ? { note: scrubPaths(p.note) } : {}),
    })),
  };
}

async function llamaSlots() {
  const { state, profile } = currentProfile();
  if (!state) return { running: false };
  const res = await llamaGet(state, '/slots', apiKeyFor(profile));
  if (!Array.isArray(res.json)) return { running: true, error: res.status ? `slots returned HTTP ${res.status}` : 'no answer from llama-server' };
  return {
    running: true,
    profile: state.profile,
    slots: res.json.map((s) => {
      const p = s.params || {};
      const nt = (s.next_token && s.next_token[0]) || {};
      return {
        id: s.id,
        busy: !!s.is_processing,
        nCtx: s.n_ctx,
        task: s.id_task,
        promptTokens: s.n_prompt_tokens,
        promptTokensProcessed: s.n_prompt_tokens_processed,
        promptTokensFromCache: s.n_prompt_tokens_cache,
        decoded: nt.n_decoded,
        speculative: s.speculative,
        sampling: {
          temperature: p.temperature, topP: p.top_p, topK: p.top_k, minP: p.min_p,
          presencePenalty: p.presence_penalty, maxTokens: p.max_tokens, stream: p.stream,
          chatFormat: p.chat_format, reasoningFormat: p.reasoning_format,
        },
      };
    }),
  };
}

function runLog(run) {
  const logs = logstats.listLogs();
  if (!logs.length) return null;
  if (run) return logs.find((l) => l.file === run || l.file === `${run}.log`) || null;
  const state = manager.readState();
  const cur = state && state.logFile ? path.basename(state.logFile) : null;
  return logs.find((l) => l.file === cur) || logs[0];
}

function llamaRequests({ limit = 50, run, minPromptTokens = 0 } = {}) {
  limit = Math.min(Math.max(1, Number(limit) || 50), 500);
  const log = runLog(run);
  if (!log) return { error: 'no logs' };
  const text = logstats.readTail(path.join(logstats.LOGS_DIR, log.file), 8 * 1024 * 1024);
  const all = logstats.parseRequests(text, log.startedAt).filter((r) => r.promptTokens >= minPromptTokens);
  const recent = all.slice(-limit);
  const sum = (k) => recent.reduce((a, r) => a + (r[k] || 0), 0);
  return {
    run: log.file.replace(/\.log$/, ''),
    profile: log.profile,
    note: 'Times are from the llama-server log. cachedTokens = prompt tokens the slot cache already held; reprocessedTokens = tokens prefilled again past that point (rolled back to an earlier context checkpoint).',
    summary: {
      requests: recent.length,
      from: recent.length ? recent[0].at : null,
      to: recent.length ? recent[recent.length - 1].at : null,
      medianPromptTokens: median(recent.map((r) => r.promptTokens)),
      maxPromptTokens: recent.length ? Math.max(...recent.map((r) => r.promptTokens)) : null,
      prefilledTokens: sum('prefilledTokens'),
      reprocessedTokens: sum('reprocessedTokens'),
      requestsWithReprocessOver1k: recent.filter((r) => r.reprocessedTokens > 1024).length,
      medianPrefillTps: median(recent.filter((r) => r.prefilledTokens >= 512).map((r) => r.prefillTps)),
      medianGenerateTps: median(recent.filter((r) => r.generatedTokens >= 64).map((r) => r.generateTps)),
      medianDraftAcceptance: median(recent.map((r) => r.draftAcceptance)),
      truncated: recent.filter((r) => r.truncated).length,
    },
    requests: recent,
  };
}

function llamaRuns({ limit = 10 } = {}) {
  limit = Math.min(Math.max(1, Number(limit) || 10), 50);
  const state = manager.readState();
  const cur = state && state.logFile ? path.basename(state.logFile) : null;
  return {
    note: 'One run = one llama-server start. state "crashed" means the log ends on a fatal error; "stopped" means it ended without one (stopped from the controller, or killed). Event kinds: bad_alloc, ggml_assert, cuda_oom, cuda_error, alloc_failed, chat_template_error (a request the chat template rejected), unauthorized (wrong API key), cancelled, other_error (llama.cpp function name only).',
    runs: logstats.listLogs().slice(0, limit).map((l) => {
      try {
        return { run: l.file.replace(/\.log$/, ''), ...logstats.summarizeRun(l, l.file === cur) };
      } catch (err) {
        return { run: l.file.replace(/\.log$/, ''), error: 'could not read log' };
      }
    }),
  };
}

const { llamaClients } = require('./clients');

const TOOLS = [
  {
    name: 'llama_status',
    description: 'Start here. Whether llama-server is running, which profile, health, uptime, build, model file and type, context size, slot count, and GPU memory/utilisation/temperature.',
    inputSchema: { type: 'object', properties: {} },
    run: llamaStatus,
  },
  {
    name: 'llama_profiles',
    description: 'Every profile the controller can start: model file, context size, parallel slots, GPU layers, flash-attn, KV-cache types, and the extra llama-server flags (paths cut to file names, key files hidden). Marks the current and default profile.',
    inputSchema: { type: 'object', properties: { withNotes: { type: 'boolean', description: 'Also return each profile\'s free-text note (tests and history). Default false.' } } },
    run: llamaProfiles,
  },
  {
    name: 'llama_slots',
    description: 'Live slot state of the running server: busy or idle, tokens in the prompt, how many came from cache, tokens decoded so far, sampling settings of the current/last task. No prompt text.',
    inputSchema: { type: 'object', properties: {} },
    run: llamaSlots,
  },
  {
    name: 'llama_requests',
    description: 'Recent requests from the llama-server log, numbers only: time, prompt tokens, tokens served from cache, tokens prefilled, tokens re-processed after a checkpoint rollback, prefill and generation tok/s, MTP draft acceptance, duration. With a summary (medians and totals).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'How many of the newest requests. Default 50.' },
        run: { type: 'string', description: 'A run id from llama_runs. Default: the current run.' },
        minPromptTokens: { type: 'integer', minimum: 0, description: 'Only requests with at least this many prompt tokens.' },
      },
    },
    run: llamaRequests,
  },
  {
    name: 'llama_runs',
    description: 'Recent llama-server starts, newest first: profile, start and last log time, request count, whether it crashed and why (bad_alloc, GGML_ASSERT, CUDA OOM...), and counted warning/error events with first and last time.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many runs. Default 10.' } } },
    run: llamaRuns,
  },
  {
    name: 'llama_clients',
    description: 'Who connects from other machines: inbound connections to llama-server, the controller and this MCP per source IP (count, first, last, and whether the address is LAN, Tailscale/CGNAT or public internet), from the Windows Firewall log. Also matches llama-server "Invalid API Key" events to the source IP that most likely sent them. Addresses and ports only.',
    inputSchema: { type: 'object', properties: { hours: { type: 'integer', minimum: 1, maximum: 168, description: 'How far back. Default 24.' } } },
    run: llamaClients,
  },
];

// ---------- JSON-RPC ----------

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'invalid request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    const asked = params.protocolVersion;
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Read-only figures about the llama-server (llama.cpp) that this Windows machine serves to OpenCode and other clients: what is loaded and how it is configured, live slots, per-request speed and cache reuse from the log, crashes, and which machines connect (and which send a wrong API key). Start with llama_status. No prompt or completion text is ever returned. Nothing here can start, stop or change the server.',
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0', id,
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) },
    };
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${params.name}`);
    try {
      const data = await tool.run(params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: scrubPaths(err.message) }] } };
    }
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

module.exports = { handleMessage, TOOLS };
