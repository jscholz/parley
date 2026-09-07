# Local mode and the Memory section

Written 2026-09-07. Companion to `ABSTRACT_AGENT_PROTOCOL.md` (which owns the
wire contract) and `UX_DETERMINISM_PLAN.md` §6 (principles). This document is
the design for two backend-declared settings features and the guard rails
around the local model. It is deliberately small: the PWA learns nothing new
about hermes, hindsight or llama.cpp — it renders what the backend declares.

## 0. Why

- On 2026-09-07 the Codex OAuth quota exhausted and every turn failed against
  an empty fallback chain. A local Qwen3.6-35B-A3B on galatea's 4090 now sits
  in `fallback_providers`. That is *implicit*: the user cannot see or choose
  it, and it only engages on provider errors.
- The owner wants an explicit **local mode**: a toggle that routes *all* LLM
  work (chat, auxiliary models, crons, hindsight fact extraction) to the local
  server so the box can run off-grid.
- Hindsight (memory) is invisible and "magic": no place in the UI shows what
  it is doing or what it is using. It needs a Settings section.
- A 24 GB card with a 64K window must be impossible to crash from the app.

## 1. Runtime profiles (the clean core)

A **runtime profile** is a named bundle of *where every model call goes*.
Profiles are backend data, not PWA concepts. They live in hermes config:

```yaml
parley:
  runtime_profile: cloud            # the ACTIVE profile — the setting writes this
  runtime_profiles:
    cloud:
      model:      { default: gpt-6-astra, provider: openai-codex, base_url: https://chatgpt.com/backend-api/codex }
      auxiliary:  { vision: { provider: openai-codex, model: gpt-5.5 } }
      fallback_providers:
        - { provider: custom:local-fallback, model: qwen3.6-35b-a3b, base_url: http://127.0.0.1:8000/v1, api_mode: chat_completions }
      memory:     { llm_provider: openai-codex, llm_model: gpt-5.4-mini }
    local:
      model:      { default: qwen3.6-35b-a3b, provider: custom:local-fallback, base_url: http://127.0.0.1:8000/v1 }
      auxiliary:  { vision: { provider: custom:local-fallback, model: qwen3.6-35b-a3b } }   # server runs --mmproj
      fallback_providers: []                          # off-grid: nothing to fall back to
      memory:     { llm_provider: llamacpp, llm_base_url: http://127.0.0.1:8000/v1, llm_model: qwen3.6-35b-a3b }
      compression: { threshold: 0.6 }                  # compact earlier on the small window
```

Rules:

1. **The active profile is a single enum setting**, `runtime_profile`, declared
   by the hermes plugin in `/v1/settings/schema` (category `Agent`, group
   `Runtime`, options `cloud` / `local`, each with a one-line description). The
   PWA renders it with the existing enum widget. Nothing else changes in the PWA
   for this feature.
2. **Applying a profile is one backend operation** (`apply_runtime_profile`):
   1. *Preflight the target.* Switching to `local` requires `GET
      http://127.0.0.1:8000/health` → 200 and the profile's model present in
      `/v1/models`; otherwise reject with a `SettingsValidationError` whose
      message says what is down. You cannot toggle into a dead mode.
   2. *Snapshot the leaving profile.* Copy the live `model:` block into
      `runtime_profiles.<leaving>.model` so a later switch back restores the
      user's most recent choice, not the profile's stale default.
   3. *Write hermes config* from the target profile: `model:`, the
      `auxiliary.*` keys the profile names (only those), `fallback_providers`,
      and any `compression.*` overrides — via `hermes_cli.config.save_config`,
      which is symlink-preserving (verified: `utils._atomic_write` →
      `atomic_replace`). The gateway resolves `model:` per agent create, so new
      conversations pick it up immediately; cached agents on open sessions keep
      the old model until evicted (same caveat the model picker already has —
      say so in the setting's description).
   4. *Write hindsight's env* (`HINDSIGHT_API_LLM_PROVIDER`, `_LLM_MODEL`,
      `_LLM_BASE_URL`) through hermes' own `.env` writer (`_write_env_lines`,
      also `atomic_replace`-based) and restart `hindsight-server.service`. Do
      this through a small repo script (`scripts/apply-memory-profile.sh` in
      hermes-agent-private) invoked by the plugin, so process control lives
      with the ops scripts, not in Parley.
   5. *Record* `parley.runtime_profile = <target>` last, so a crash mid-apply
      leaves the setting reporting the profile that is actually live.
3. **The model picker stays.** In `cloud` it behaves as today and additionally
   updates `runtime_profiles.cloud.model`. In `local` its options are the local
   server's `/v1/models`. A profile switch never silently forgets a picker
   choice.
4. **Embeddings stay on OpenAI in both profiles** for now. Hindsight's stored
   vectors are `text-embedding-3-small` (1536-d); switching the embedder to the
   local `bge-small` (384-d) changes the schema and requires re-embedding the
   whole store. That is a separate, deliberate migration, not a toggle. So
   "off-grid" today means every *LLM* call is local while embeddings still need
   the (non-quota-bound) OpenAI key. Documented as the known gap.

## 2. Guard rails for the local model

Verified 2026-09-07 on the running server:

- **Overflow cannot crash anything.** llama-server allocates the KV cache for
  `n_ctx` at start; a request larger than the window returns HTTP 400
  `exceed_context_size_error` in 0 s with the server and VRAM unchanged
  (tested with an 83K-token prompt against a 64K window).
- **hermes compacts before that.** `agent/model_metadata.py` overwrites the
  model's `context_length` with llama.cpp's allocated `n_ctx` from `/props`
  (not the 262K training window), and `compression.threshold` (0.7 today,
  0.6 in the local profile) triggers compaction at ~40–46K tokens.
- **Concurrency is serialised.** `--parallel 1`: crons and chat queue rather
  than split the KV cache. Slower under load, never over budget.
- **VRAM is fixed at start** (19.0 GB at 64K, ~20 GB with the vision
  projector). Nothing the app sends can grow it.

The residual failure is a *turn* failing with a clear 400 if a single prompt
exceeds 64K after compaction. The lever against that is context, not crashes:

### "Low-context mode" — what actually helps, in order

1. **Fewer tools.** The tool schemas are the largest fixed cost in the system
   prompt (54 Parley tools plus MCP servers). The `local` profile should carry a
   slimmer `toolsets:` list; measure a real turn's `prompt_tokens` on the local
   server first and set the target from the number, not a guess.
2. **Compact earlier and prune tool output.** `compression.threshold: 0.6` and
   `proactive_prune_tokens` in the local profile.
3. **Lower reasoning effort** for the local model (`--reasoning low` /
   per-model reasoning config) — shorter thinking, shorter turns.
4. **Habits** (`/reset`, `/new`) remain the manual lever and are not a
   substitute for the three above.

## 3. Settings › Memory

Category `Memory` (new). Backend-declared; the PWA adds only a section shell
and the category mapping. Fields, all from the hermes plugin:

| id | type | notes |
|---|---|---|
| `memory_enabled` | toggle | hermes `memory.memory_enabled` |
| `memory_user_profile` | toggle | hermes `memory.user_profile_enabled` |
| `memory_llm` | text, `readonly: true` | e.g. `openai-codex · gpt-5.4-mini` — follows the runtime profile; not editable here by design |
| `memory_embeddings` | text, `readonly: true` | e.g. `openai · text-embedding-3-small` |
| `memory_status` | text, `readonly: true` | `hindsight-server active · last retain 3 min ago · 0 LLM errors / 24h`, from the server's journal + `/v1/default/banks/default/stats` (or the health kv) |

Protocol addition (small, generic, documented in
`ABSTRACT_AGENT_PROTOCOL.md`): an optional boolean `readonly` on any setting.
The PWA renders a readonly field as a value line, never an input, and never
POSTs it. Health-check detail and "run now" stay where they are (Settings ›
Health); the Memory section is *what memory is doing and with what*, one glance.

## 4. Out of scope (named so they are not forgotten)

- Local embeddings + re-index (fully off-grid memory).
- A per-profile toolset editor in the UI (profile YAML is the editor for now).
- Vision on the standby host; the local profile is galatea-only, like the
  server it points at. On the standby the preflight fails and the toggle
  refuses — correct behaviour.
