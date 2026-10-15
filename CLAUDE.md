# llama-stroller: notes for Claude

Windows control server + CLI + tray for running llama.cpp profiles ("Llama Controller").
README.md is the full record (upgrade history, every benchmark, client setup). This file is
what a new session needs first. The user writes in Thai; answer in Thai. On long jobs
(benchmarks, downloads) the user asked for progress reports along the way.

## The machine and its hard limits
- 2x RTX 5060 Ti 16 GB (Blackwell, sm_120), AMD FX-8350, **12 GB RAM visible** (4x4 GB
  installed, one stick or slot looks dead), Windows 10, driver reports CUDA 13.3.
- **Virtual memory is the real ceiling, not VRAM.** On Windows every VRAM allocation is also
  charged to system commit, so a fully offloaded 2-GPU profile commits ~30 GB at load, and
  the automatic pagefile caps commit at RAM + 3x RAM (~48 GB). Per-slot context checkpoints
  used to grow it ~90 MB per 1k tokens until llama-server hit `bad allocation` and crashed
  on a GGML_ASSERT (opencode overnight, 2026-10-13). **Every profile now has
  `--cache-ram 0 --ctx-checkpoints 4`. Keep them on new profiles.** Verified fixed: 2,550
  opencode requests up to 110k tokens, zero errors, zero Windows event-2004 warnings.
- Disk C: ~86 GB free (2026-10-15). The pagefile grows on its own when big models load.

## Current state (2026-10-15)
- llama.cpp **b11560** (v0.6.0) in `C:\llama.cpp`; rollback copy `_backup-b11146`.
- PrismML fork (Bonsai only) **prism-b10754** in `C:\llama.cpp-prism`. **prism-b10772 is
  broken** (after ~5 requests it answers `//////` until restart, PrismML issue #342; kept in
  `_broken-b10772`). Before upgrading the fork again, run 10+ tool calls with thinking off
  and check none come back as slashes; a single smoke test passes on the broken build.
- Running now: **`qwen3.8-27b-nvfp4-mtp`** (both GPUs), the profile the user uses with
  opencode. `defaultProfile` in config.json is still `qwen3.6-mtp`.
- Video Studio (`C:\Users\Rockman\Documents\video-studio`, own CLAUDE.md) translates Thai
  prompts through whatever model is on :11435 and needs GPU 0 under 3 GB, so it only runs
  alongside a one-GPU profile (`bonsai2-27b` or `saluki-27b`). It is not running now.

## Which profile for what (from the benchmarks in README)
- **opencode / agentic coding: `qwen3.8-27b-nvfp4-mtp`.** Same quality as Unsloth's
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
typhoon-ai/thai_exam). `bench.py <label> [suites]` talks to :11435 at temp 0 with thinking
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
events matched to an IP). Code in `lib/mcp.js`, `lib/logstats.js`, `lib/clients.js`.
llama-server never logs client IPs (only `-v` would, and that logs prompts too), so source
IPs come from firewall logging: `scripts\firewall-log.ps1` (admin; `-Off` reverts) writes to
`logs\firewall\` (gitignored); a SYSTEM task copies the inbound lines for our ports to `inbound.log` every minute because Windows ACLs the raw file to SYSTEM/admins. Loopback is logged too. Since ~2026-10-07 something
sends a wrong key to :11435 (polling every 16-20 s Oct 7-11, 132-request bursts 10-15);
source not yet known. Note :4570 (server.js) has no auth at all. Its own process, NOT inside server.js: llama-server's stdout is piped
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
3. Optional: delete `Qwen3.8-27B-bartowski` and `Qwen3.8-27B-ggml-org` (~40 GB) if no
   longer wanted; ask first.
4. Check for a PrismML release that fixes #342 (proposed fix #353).
5. The English benchmark report artifact (claude.ai/artifact/CDiTfhLQ5ptix8fpCKvbys,
   copy in `docs/`) is private until the user shares it.
