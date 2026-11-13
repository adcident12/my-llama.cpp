# llama-stroller: notes for Claude

Windows control server + CLI + tray for running llama.cpp profiles ("Llama Controller").
README.md is the full record (upgrade history, every benchmark, client setup). This file is
what a new session needs first. The user writes in Thai; answer in Thai. On long jobs
(benchmarks, downloads) the user asked for progress reports along the way.

## The machine and its hard limits
- 2x RTX 5060 Ti 16 GB (Blackwell, sm_120), AMD FX-8350, **12 GB RAM visible** (4x4 GB
  installed and all four DIMMs detected at 667 MHz, so 4 GB is reserved/unmapped rather than
  a dead stick), Windows 10, driver 617.14 reports CUDA (UMD) 13.4. PCIe is gen2 max:
  GPU 0 x8, GPU 1 x4.
- **Virtual memory is the real ceiling, not VRAM.** On Windows every VRAM allocation is also
  charged to system commit, so a fully offloaded 2-GPU profile commits ~30 GB at load, and
  the automatic pagefile caps commit at RAM + 3x RAM (~48 GB). Per-slot context checkpoints
  used to grow it ~90 MB per 1k tokens until llama-server hit `bad allocation` and crashed
  on a GGML_ASSERT (opencode overnight, 2026-10-13). **Every profile now has
  `--cache-ram 0 --ctx-checkpoints 4`. Keep them on new profiles.** Verified fixed: 2,550
  opencode requests up to 110k tokens, zero errors, zero Windows event-2004 warnings.
- Disk C: ~99 GB free (2026-11-06, after clearing caches and two models). The pagefile grows on
  its own when big models load.

## Current state (2026-11-06)
- llama.cpp **b11960** (v0.8.0) in `C:\llama.cpp`; rollback copy `_backup-b11669` (older ones
  deleted 2026-11-06). Newer nightlies exist; Clover (#31306) needs one.
- **`bonsai2-27b` runs on mainline since 2026-10-16**, using the `Q2_0` file from
  `prism-ml/Ternary-Bonsai-2-27B-gguf-dev` in `models\Ternary-Bonsai-2-27B-Q2_0\`. Mainline rejects
  the fork-only `PQ2_0`/`PTQ1_0`. Fallback profile `bonsai2-27b-prism` = PrismML fork
  **prism-b12128** in `C:\llama.cpp-prism`, rollback `_backup-b10754`. prism-b10772 was broken
  (`//////` after ~5 requests, PrismML #342, still open). Before trusting any Bonsai build, run
  `bench/regress.py`.
- `qwen3.8-27b-nvfp4-mtp` has `--spec-draft-n-ubatch 128` (new in b11669): -0.5 GB VRAM on
  GPU1, -0.9 GB commit, speed unchanged (sweep in its config note).
- Running now: **`qwen3.8-27b-nvfp4-mtp`** (both GPUs), the profile the user uses with
  opencode. `defaultProfile` in config.json is still `qwen3.6-mtp`.
- Video Studio (`C:\Users\Rockman\Documents\video-studio`, own CLAUDE.md) translates Thai
  prompts through whatever model is on :11435 and needs GPU 0 under 3 GB, so it only runs
  alongside a one-GPU profile (`bonsai2-27b` or `saluki-27b`). It is not running now.
- Models that look unused but are not: `Qwen3.8-27B-GGUF-v3\mmproj-F16.gguf` is the vision
  projector for every Qwen3.8 NVFP4 profile, and `Qwen3.6-27B-GGUF\mmproj-*` is also used by
  `qwen3.6-27b-mtp`. Check `--mmproj` in config.json before deleting a model folder.
- Deleted 2026-11-06 for disk space: `qwen3.8-27b-bartowski` and `qwen3.8-27b-ggml-org`, models
  and profiles. Their benchmark results stay in README.

## Home network (added 2026-11-06)
- **Logs:** Grafana Alloy v1.21.1 runs here as a service (host label `ai-runtime`), shipping
  the Windows event channels plus `logs\*.log` (job `llama-cpp`), Ollama `server.log` and
  Video Studio `comfy.log` to Loki on the home server, `192.168.0.50:3500`. Config:
  `C:\Program Files\GrafanaLabs\Alloy\config.alloy`. `logs\firewall\inbound.log` must stay out of
  it: it is rewritten in full every minute, so Alloy would re-ship all of it each time. This
  machine has no sshd, so it has no OpenSSH block.
- **Metrics (2026-11-13):** Telegraf 1.36.3 (service `telegraf`, files in
  `C:\Program Files\InfluxData\telegraf`, bucket `homelab-airuntime`, host tag `server3`)
  scrapes `http://127.0.0.1:11435/metrics` every 30 s (measurement `llamacpp`, fields keep the
  `llamacpp:` prefix; bearer token = our API key file, which SYSTEM can read) and runs
  `disk-health.ps1` every 10 min. Only `qwen3.8-27b-nvfp4-mtp` has `--metrics` so far; add
  it to any profile that should be graphed. Editing telegraf.conf needs admin.
- **:11435 is reachable from the internet** at `https://llm.popzone.link`, through Nginx Proxy
  Manager on .50, so public traffic shows up here as source IP 192.168.0.50. The API key is the
  gate here; NPM on .50 only forwards `/v1/*` with an Authorization header, plus `/health`.
- **The panel (:4570)** is proxied at `https://pophome.popzone.link/svc4570/` behind the admin
  login. `public/app.js` stops polling and shows a notice on 401/403, so an open tab does not
  trip the Security page on .50 after the login ends.

## Which profile for what (from the benchmarks in README)
- **New 2026-11-04, worth trying for opencode: `swift-1.5-mtp`.** Thinking on it scored 50/61 vs
  45 for nvfp4-mtp (p=0.06), finished 30% sooner and uses 4 GB less VRAM, but prefill is slower
  (729 vs 1012 tok/s at 30k) and it has a custom license. `flint-40b` is about twice as fast
  (52 tok/s, 1807 prefill at 30k) but weaker: 42/61, BFCL 119, no vision. Its template cannot turn
  thinking off and it answers one-letter grammar prompts at random, so it needs `mc_think`.
  Not yet tried in real agent sessions.
- **opencode / agentic coding, current: `qwen3.8-27b-nvfp4-mtp`.** Same quality as Unsloth's
  `qwen3.8-27b-v3` (within noise everywhere, ThaiExam -10/354), fastest prefill of the MTP
  options (962 vs 673 tok/s at 30k), 38.6 tok/s decode greedy, ~4 GB more VRAM headroom.
- **One GPU, Thai matters: `saluki-27b`** (Thai 60%, follows terse-output instructions).
  **`bonsai2-27b`** is the fastest one-GPU option but the weakest at Thai (52%) and ignores
  "answer only X" instructions 59% of the time; it is what Video Studio was set up with.
- `qwen3.6-mtp` (MoE, ~74 tok/s) has never been run through the benchmark harness, and
  has no vision (old model-card limit; MTP + mmproj now works on other profiles, so it may
  be addable: untested).

## Gotchas learned the hard way
- `llama start X` refuses while another profile runs: `llama stop` first.
- The CLI is not on PATH in the Bash tool. Use `cli\llama.cmd` from the repo root. The
  `claude` CLI is at
  `C:\Users\Rockman\.vscode\extensions\anthropic.claude-code-<ver>-win32-x64\resources\native-binary\claude.exe`.
- Stopping a background task does not kill its child processes. Kill leftover
  `python.exe`/`bash.exe` by command line, or they keep sending requests to whatever model
  loads next (this once wrote one model's results under another's name).
- Git Bash `curl` mangles Thai. Send Thai through Python with `PYTHONIOENCODING=utf-8`.
- After an upgrade, diff `llama-server --help` against the backup's (b11560 moved the
  default port to 9931; harmless since every profile sets `--port`).
- In config.json, `extraArgs` is ONE space-separated string, not a list.

## Benchmark harness (`bench/`)
Scripts and every result from 2026-10-12/13. Needs a venv with `pyarrow` and the datasets
in `bench/data` (not committed; re-download from Hugging Face: gorilla-llm BFCL v3 +
possible_answer, openai/gsm8k, TIGER-Lab/MMLU-Pro, openai/openai_humaneval,
typhoon-ai/thai_exam). `regress.py` = thinking-off calls looking for slashes. `mc_think` = the
thinking-on suite, the only one comparable for models that always think. `bench.py <label> [suites]` talks to :11435 at temp 0 with thinking
off, appends to `results/<label>.jsonl` and resumes after a crash. Multiple choice is
GBNF-constrained to one letter on purpose (otherwise models that explain first get free
chain-of-thought). `validate.py` = upgrade check (tool call, streamed call, tool loop,
vision). `longctx.py` = prefill/decode at 8k and 30k. `memgrow.py` = the commit-growth
reproduction. `run_*.sh` show how a full run was driven.

## opencode-monitor MCP
Added 2026-10-15, local scope (this project only, in `~/.claude.json`; the key is not in the
repo): `http://192.168.0.100:4317/mcp`. Read-only figures about the user's OpenCode
sessions. Tools: `opencode_takeaways` (start here), `opencode_stats`, `opencode_sessions`,
`opencode_tasks`, `opencode_settings`, `opencode_compare`, `opencode_config_changes`. Its
own rule: propose an opencode.json edit with the figure behind it and change nothing until
the user agrees.

## llama-stroller MCP (`mcp-server.js`, added 2026-10-15)
Read-only MCP over Streamable HTTP at `http://192.168.0.53:4571/mcp`, for Claude sessions on
other machines (opencode-monitor on 192.168.0.100 asked for it). Tools: `llama_status`,
`llama_profiles`, `llama_slots`, `llama_requests` (per-request tokens/speed/cache reuse parsed
from the log), `llama_runs` (starts, crashes, classified error counts), `llama_clients`
(inbound connections per source IP from the Windows Firewall log, and "Invalid API Key"
events matched to an IP), `llama_machine` (hardware, commit charge, pagefile, disk, GPU
driver/CUDA, llama.cpp builds per profile, event-2004 count). Code in `lib/mcp.js`,
`lib/logstats.js`, `lib/clients.js`, `lib/machine.js`.
llama-server never logs client IPs (only `-v` would, and that logs prompts too), so source
IPs come from firewall logging: `scripts\firewall-log.ps1` (admin; `-Off` reverts) writes to
`logs\firewall\` (gitignored); a SYSTEM task copies the inbound lines for our ports to `inbound.log` every minute because Windows ACLs the raw file to SYSTEM/admins. Loopback is logged too. The wrong-key bursts on :11435 were
traced on 2026-11-05 to an internet scanner hitting `llm.popzone.link` (about 400 requests per
burst, probing paths like `/.env`), and filtered at NPM on .50 the same day. "Invalid API Key"
lines from then on should mean a real client has a wrong key. Note :4570 (server.js) has no auth at all. Its own process, NOT inside server.js: llama-server's stdout is piped
through server.js, so restarting server.js risks the running model. Non-loopback needs
`Authorization: Bearer` with the key in `secrets/mcp-api-key.txt` (made on first start).
Never let a tool return prompt/completion text, keys, or full paths. `MCP_HOST`/`MCP_PORT`
env vars override (test on 127.0.0.1). Not started by the tray yet.

## Open items, none started
1. DONE 2026-10-15: did `--ctx-checkpoints 4` cost re-processing? Yes, a little.
   `opencode_compare` can't answer it (opencode logs the model name it was configured with,
   not what the server had loaded); the llama-server logs can: per request, prompt eval
   tokens vs `f_keep` x previous n_tokens. nvfp4-mtp after the change (2,547 requests): 58
   (2.3%) rolled back far past the shared prefix (up to 79k tokens redone, ~100 s each),
   23 of 221 min prefill. Before (146 overnight requests, 32 checkpoints): 0. Redoing the
   ~12k system prefix after a compaction happens either way. Possible middle ground:
   `--ctx-checkpoints 8` (~200 MiB per checkpoint), only after `memgrow.py` shows commit stays flat.
2. Optional: add vision to `qwen3.6-mtp` and check MTP speed holds; benchmark it.
3. DONE 2026-11-06: deleted `Qwen3.8-27B-bartowski` and `Qwen3.8-27B-ggml-org`. If more disk is
   needed, offered but not deleted: `muse-glimmer-30b-meta` (18 GB), `qwen3.6-main` (22 GB),
   `qwen3.6-27b` model file only (16 GB), `fable-fusion-27b` (23 GB). Ask first.
4. Try `swift-1.5-mtp` in real opencode sessions against nvfp4-mtp; the user decides the switch.
5. The English benchmark report artifact (claude.ai/artifact/CDiTfhLQ5ptix8fpCKvbys,
   copy in `docs/`) is private until the user shares it.
