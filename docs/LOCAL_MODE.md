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
      memory:     { llm_provider: openai-codex, llm_model: gpt-5.4-mini, recall_max_tokens: 4096, recall_budget: mid }
      tools:      { tool_search: {} }               # {} = explicit "use hermes defaults" (still a real write)
      skills:     { platform_disabled: { parley: [] } }
      cron:       { model: "", model_provider: "" }  # explicit empty pin: "follow cloud's model.default"
    local:
      model:      { default: qwen3.6-35b-a3b, provider: custom:local-fallback, base_url: http://127.0.0.1:8000/v1,
                  max_tokens: 8192 }
                  # NOT 12000: hermes derives the compaction threshold from (context_length - max_tokens) *
                  # threshold_percent. At 12000 on the 64K allocated window that lands at 45,505 tokens, which the
                  # ~26k measured head plus the hard-coded 10k lean-tail floor can barely clear before the
                  # ineffective-compression breaker (below) trips again; at 8192 it is 48,742. Verified 2026-09-07
                  # by constructing an agent.
      auxiliary:  { vision: {…local…}, compression: {…local…}, web_extract: {…local…}, session_search: {…local…},
                  skills_hub: {…local…}, approval: {…local…}, mcp: {…local…}, title_generation: {…local…},
                  triage_specifier: {…local…}, curator: {…local…}, flush_memories: {…local…} }
                  # EVERY auxiliary model, not just vision. Field 2026-09-07: only vision was rerouted, so
                  # the compression SUMMARIZER still called openai-codex, aborted on the exhausted quota,
                  # and the session overflowed + auto-reset. The server runs --mmproj for vision.
      fallback_providers:                             # the local server as its OWN fallback: a conversation opened
        - { provider: custom:local-fallback, model: qwen3.6-35b-a3b, base_url: http://127.0.0.1:8000/v1, api_mode: chat_completions }
                                                      # before the switch still holds a cloud agent until eviction; on a
                                                      # quota 429 hermes re-reads this chain and lands here, not in an error
      memory:     { llm_provider: lmstudio, llm_base_url: http://127.0.0.1:8000/v1, llm_model: qwen3.6-35b-a3b,   # NOT `llamacpp` — see rule 4
                  recall_max_tokens: 1500, recall_budget: low }   # hindsight's OWN config (~/.hindsight/config.json,
                                                      # not hermes config) — applied by scripts/apply-memory-recall.sh,
                                                      # no restart needed. §2 below.
      compression: { threshold: 0.6, threshold_tokens: 30000 }   # the ratio is floored at 0.75 for sub-512K windows
                  # (~49k on 64K — too close to the usable budget once output is reserved); the absolute cap wins.
      tools:
        tool_search:
          enabled: on
          listing: on
          listing_max_tokens: 1200
          defer: [computer_use, session_search, image_generate, todo_list, process_manage, cronjob_manage,
                  drive_preview, gui_tour, desktop_preview, annotate_preview, show_tip, setup_mcp, desktop_project,
                  close_terminal, apply_layout, read_terminal, read_window_below, focus_pane,
                  browser_back, browser_cdp, browser_click, browser_console, browser_dialog, browser_exec,
                  browser_get_images, browser_navigate, browser_press, browser_scroll, browser_snapshot, browser_type,
                  delegate_task, text_to_speech, skill_manage]
          # `defer` REPLACES hermes' curated `_DEFAULT_DEFERRED_TOOLS` wholesale, so this list carries every one of
          # those defaults PLUS the browser/delegate/voice tools that cost schema space but are rarely used from a
          # phone chat. MCP tools (Notion's 24 included) are always deferrable and need no entry here.
      skills:
        platform_disabled:
          parley: [architecture-diagram, ascii-art, ascii-video, baoyu-article-illustrator, baoyu-comic,
                   baoyu-infographic, claude-design, comfyui, design-md, excalidraw, humanizer, ideation,
                   iterative-website-design, manim-video, p5js, pixel-art, minecraft-modpack-server, pokemon-player,
                   gif-search, heartmula, songsee, spotify, video-rough-cutting, youtube-content,
                   social-media-sweep, xurl, yuanbao, openhue, godmode, evaluating-llms-harness,
                   weights-and-biases, huggingface-hub, llama-cpp, obliteratus, outlines, serving-llms-vllm,
                   audiocraft-audio-generation, segment-anything-model, dspy, axolotl, fine-tuning-with-trl,
                   unsloth, agent-client-bridges, claude-code, codex, computer-use, hermes-agent,
                   kanban-codex-lane, opencode, github-auth, github-code-review, github-issues,
                   github-pr-workflow, github-repo-management, kanban-orchestrator, kanban-worker,
                   private-static-site-publishing, webhook-subscriptions, static-intelligence-dashboards,
                   pii-scrub-public-sync]
          # Names taken from the live skills index on 2026-09-07. The `software-development` CATEGORY is
          # deliberately NOT named here — the list above hides individual creative/media/ops-tooling/ML-training
          # skills, not the software-development group as a whole; that call is the owner's, not this diet's.
      cron: { model: "", model_provider: "" }  # same reset guarantee: a cloud-pinned bulk model must not
                                                # survive a flip to local (no API key off-grid).
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
   3. *Write hermes config* from the target profile — via
      `hermes_cli.config.save_config`, which is symlink-preserving (verified:
      `utils._atomic_write` → `atomic_replace`). Two different write shapes,
      by design:
      - `model:` and `fallback_providers` are **wholesale replaces**: the
        profile's exact block/list lands, in full. A key the live `model:`
        had that the target profile never names (e.g. a `max_tokens` or
        `context_length` the previous profile pinned) is REMOVED, not left
        behind — a merge here would route the new provider with the old
        profile's leftover cap. This is why step 2 snapshots the WHOLE live
        `model:` block rather than just the keys the leaving profile names:
        a later switch back restores it exactly, quirks included.
      - `auxiliary.<name>.*`, `compression.*` and
        `skills.platform_disabled.<platform>` are **leaf-level merges**: only
        the keys/platforms the profile names are overwritten; every sibling
        key hermes maintains on that entry (`auxiliary.vision.timeout`,
        `compression.protect_last_n`, another platform's disabled list, the
        GLOBAL `skills.disabled`) survives untouched. `compression` in
        particular has never been wholesale — a profile that names only
        `threshold` leaves `enabled`/`protect_last_n` exactly as hermes had
        them; this is existing, tested behaviour, not new.
      - `tools.tool_search` is a **wholesale replace of that one subtree**
        (siblings under `tools.*` are untouched): a profile names the WHOLE
        tool-search config or none of it. `{}` is a real write — "use
        hermes defaults" — not "leave whatever was there," so a switch back
        to `cloud` actually undoes the local diet.
      The gateway resolves `model:` per agent create, so new conversations
      pick it up immediately; cached agents on open sessions keep the old
      model until evicted (same caveat the model picker already has — say
      so in the setting's description).
   4. *Write hindsight's env* (`HINDSIGHT_API_LLM_PROVIDER`, `_LLM_MODEL`,
      `_LLM_BASE_URL`) through hermes' own `.env` writer (`_write_env_lines`,
      also `atomic_replace`-based) and restart `hindsight-server.service`. Do
      this through a small script SHIPPED IN THIS REPO
      (`backends/hermes/scripts/apply-memory-profile.sh`, overridable via
      `PARLEY_MEMORY_PROFILE_SCRIPT`) invoked by the plugin, so process
      control lives with one ops script rather than scattered through
      Parley's Python — and a third-party install never needs anyone's
      private ops repo for it to exist.
   5. *Apply hindsight's recall/retain knobs* (`recall_max_tokens`,
      `recall_budget`, `auto_recall`, `auto_retain`, `retain_every_n_turns` —
      §2, §3) via `parley_hindsight_config.py`, writing
      `~/.hermes/hindsight/config.json` directly — a DIFFERENT file than
      step 4's `.env`, and no restart: hindsight rereads it fresh per new
      agent/session, so this runs in-process rather than through a script.
      Fires whenever the profile names ANY of the five (the
      `recall_max_tokens`/`recall_budget` pair still fills its missing half
      with hermes' defaults, 4096 / mid, and logs which; the other three are
      independent optionals — a profile may set any subset); idempotent, so
      it is not gated on "would this change anything" the way step 4's
      restart is.
   6. *Record* `parley.runtime_profile = <target>` last, so a crash mid-apply
      leaves the setting reporting the profile that is actually live.
3. **The model picker stays.** In `cloud` it behaves as today and additionally
   updates `runtime_profiles.cloud.model`. In `local` its options are the local
   server's `/v1/models`. A profile switch never silently forgets a picker
   choice.
4. **Hindsight's provider for a local server is `lmstudio`, not `llamacpp`.**
   Found during implementation: hindsight's `llamacpp` provider does not talk
   to an external server — it spawns its own llama-cpp-python subprocess and
   downloads a second GGUF, ignoring `base_url`, which on a single 24 GB card
   would fight the model we are routing to. `lmstudio` is hindsight's generic
   "OpenAI-compatible local server, no auth" provider and honours `base_url`.
   Trade-off: it does not send `response_format: json_object`; if retain JSON
   proves flaky, switch to provider `openai` with the same `base_url` (adds the
   grammar, requires an api key).
5. **Embeddings stay on OpenAI in both profiles** for now. Hindsight's stored
   vectors are `text-embedding-3-small` (1536-d); switching the embedder to the
   local `bge-small` (384-d) changes the schema and requires re-embedding the
   whole store. That is a separate, deliberate migration, not a toggle. So
   "off-grid" today means every *LLM* call is local while embeddings still need
   the (non-quota-bound) OpenAI key. Documented as the known gap.
6. **`tools` and `skills` are widened roots, not open ones.** A profile may
   set `tools.tool_search` and `skills.platform_disabled.<platform>` and
   nothing else under either root — `plan_apply` raises a `ProfileError` for
   any other `tools.*`/`skills.*` key a profile tries to carry (e.g. the
   GLOBAL `skills.disabled` list, or a hypothetical `tools.mcp_servers`).
   Same rationale as the original five-root allow-list: a setting that
   reroutes every model call the owner's agent makes must not quietly grow
   the blast radius of what "switching profiles" can touch.
7. **`cron` is a widened root too, restricted to `cron.model`/
   `cron.model_provider`** — the two keys `POST /v1/jobs/model` ("model for
   all jobs", `ABSTRACT_AGENT_PROTOCOL.md`'s scheduled-jobs extension)
   writes. Landmine this closes: the owner uses "model for all jobs" to
   repoint every cron job at once, and a runtime-profile switch reroutes
   every OTHER model call the same way — if a switch left `cron.model`
   alone, a cloud model pinned into cron strands every job when the owner
   flips to `local` (no API key off-grid), and the reverse strands crons on
   a small local model after flipping back. Both shipped profiles seed an
   EXPLICIT `cron: {model: "", model_provider: ""}` (an empty pin means
   "follow this profile's `model.default`"), so **every profile switch
   resets "model for all jobs" back to that profile's own default** — it
   does not carry a bulk pin over from the profile being left, and it does
   not remember a bulk pin from the last time this profile was active
   either. Anything else under `cron` (the SCHEDULER provider — a
   different axis, `model_drift_guard`, `preflight`, chronos settings, …)
   is owner/hermes territory and a profile may not touch it, same
   enforcement as rule 6's `tools`/`skills` restriction.

   Caveat for an ALREADY-seeded `parley.runtime_profiles` block (any box
   that ran the local-mode feature before this rule existed): `read_profiles`
   honours an existing block as-is and never re-seeds it, so an existing
   profile with no `cron` key simply leaves `cron.model` untouched on
   switch — the reset guarantee above only holds once each profile's YAML
   carries the explicit empty pin. Add `cron: {model: "", model_provider:
   ""}` to each profile by hand (docs above show the exact shape) to pick
   up the guarantee on such a box.

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

Measured 2026-09-07 on the running local server, on a 64K allocated window:
the fixed prompt **head is ≈26k real tokens**, before a single turn of
conversation:

- **System prompt: 15.8k** — `AGENTS.md` 7.1k, the skills index 4.8k, memory
  files 1.2k, `SOUL.md` 0.9k, hermes' own base prompt ~1.8k.
- **Visible tool schemas: 9.8k** for 23 tools — the `tool_search` bridge
  tool's OWN description alone is 1.3k, because it embeds the full catalog of
  35 deferred tools, including Notion's 24. (Notion is already deferred by
  hermes' tool-search bridge by default — it needs no entry in a profile's
  `defer` list.)

hindsight's memory recall then injects up to `recall_max_tokens` into every
non-trivial user turn — observed **4,072 tokens = 38 facts** at the (then)
default budget — and the injected copy is REPLAYED on every later turn until
the next compaction, not just the turn that triggered recall. hermes' own
rough prompt-size estimator (bytes / 4) **undercounts this tokenizer by
30–40%**, so anything sized off that estimator runs hotter than it looks.

Compaction is judged "effective" only if the REAL (not estimated)
post-compaction prompt is under `compression.threshold_tokens` — and the lean
tail is a **hard-coded 10k floor** (`LEAN_TAIL_FLOOR_TOKENS` in
`agent/context_compressor.py`), so `threshold_tokens` must clear
head + ~14k or compaction fires and immediately looks ineffective again.
This is also why the local profile's `model.max_tokens` is **8192, not a
rounder 12000**: hermes derives `threshold_tokens` from
`(context_length - max_tokens) * threshold_percent`. On this 64K window,
12000 computes a threshold of 45,505 tokens — too close to head + floor to
survive a real turn without immediately re-tripping; 8192 computes 48,742,
which clears it with room. (Both numbers assume `context_length` is llama.cpp's
allocated `n_ctx`, per the guard-rail above, not the model's training window.)

What the `local` profile's diet does about all of the above, in order:

1. **Fewer tools, loaded on demand.** `tools.tool_search` in the local
   profile turns on the bridge (`enabled: on`, `listing: on`) with a 1200-token
   listing budget and a `defer` list built from hermes' curated defaults PLUS
   the browser/desktop/delegate/voice tools — the ones that cost schema space
   but are rarely invoked from a phone chat. MCP tools defer automatically and
   need no entry.
2. **A slimmer skills index.** `skills.platform_disabled.parley` hides
   creative/media/ops-tooling/ML-training skill categories from the index for
   the `parley` platform only (names taken from the live index on 2026-09-07).
   The `software-development` category is deliberately NOT named — that call
   is the owner's, not this diet's.
3. **A capped, cheaper memory recall.** `memory.recall_max_tokens: 1500` /
   `recall_budget: low` (vs cloud's 4096 / mid) bounds the per-turn injection
   that would otherwise eat back whatever the first two points saved —
   applied via `parley_hindsight_config.py`, in-process, no restart.
4. **Compact earlier and pin the output reservation.** `compression.threshold:
   0.6` and `model.max_tokens: 8192` (the math above) keep `threshold_tokens`
   comfortably above head + tail instead of right at the edge.
5. **Habits** (`/reset`, `/new`) remain the manual lever and are not a
   substitute for the four above.

## 3. Settings › Memory

Category `Memory` (new). Backend-declared; the PWA adds only a section shell
and the category mapping. Two groups, so hermes' own file-based memory is
never confused with hindsight (the actual memory server) again — the
original single-group layout used generic labels ("Memory", "User
profile") for the FILE toggles with no mention that hindsight was a
different system entirely, which is what this split fixes.

**`Built-in files`** — hermes' MEMORY.md/USER.md, unrelated to hindsight:

| id | type | notes |
|---|---|---|
| `memory_enabled` | toggle | hermes `memory.memory_enabled` — labeled "Notes file (MEMORY.md)" |
| `memory_user_profile` | toggle | hermes `memory.user_profile_enabled` — labeled "User profile file (USER.md)" |

**`Hindsight`** — the memory server's own behaviour, backed by
`parley_hindsight_config.py` reading/writing `~/.hermes/hindsight/config.json`
directly (a DIFFERENT file than hermes' `config.yaml`/`.env`; see §1 rule
2.5). hindsight rereads this file fresh whenever a `MemoryManager` is
constructed — per new agent/session, not once at process start — so every
writable field below takes effect on the NEXT chat, never mid-session, and
needs no restart:

| id | type | JSON key | notes |
|---|---|---|---|
| `memory_recall` | toggle | `auto_recall` (default `true`) | recall runs in the background after a turn and injects up to the token cap into the NEXT turn's prompt — its cost is context tokens, not latency; the injected copy is replayed with that turn until the next compaction |
| `memory_recall_max_tokens` | slider, 200..16000 | `recall_max_tokens` (default `4096`) | cap on the per-turn injection |
| `memory_recall_budget` | enum `low`/`mid`/`high` | `recall_budget` (default `mid`) | recall thoroughness |
| `memory_retain` | toggle | `auto_retain` (default `true`) | the EXPENSIVE one — each save runs fact extraction + consolidation on the memory server's own LLM, which in local mode is the SAME GPU chat uses (measured 42s of LLM time for one consolidation pass); it competes with turns, not just tokens |
| `memory_retain_every_n_turns` | slider, 1..50 | `retain_every_n_turns` (default `1`) | frequency knob; higher = fewer, larger (and cheaper) saves |
| `memory_llm` | text, `readonly: true` | — | e.g. `openai-codex · gpt-5.4-mini` — follows the runtime profile; not editable here by design |
| `memory_embeddings` | text, `readonly: true` | — | e.g. `openai · text-embedding-3-small` |
| `memory_status` | text, `readonly: true` | — | `hindsight-server active · last retain 3 min ago · 0 LLM errors / 24h`, from the server's journal + `/v1/default/banks/default/stats` (or the health kv) |
| `memory_hindsight_state` | text, `readonly: true` | — | compact recall/retain summary, e.g. `recall on · 1500 tok · low \| retain on · every 1 turn`; reads `hindsight config not found at <path>` on a fresh install that has never written the file |

Runtime profiles carry the same five JSON keys under a profile's `memory:`
block (§1 rule 2.5) through the identical validate/write path — a profile
switch and a Settings-panel edit can never disagree about what a value
means. Seeded profile values are unchanged by this feature: `local` still
only seeds `recall_max_tokens: 1500` / `recall_budget: low`; retain
frequency is left to the toggle, not baked into a profile.

Protocol addition (small, generic, documented in
`ABSTRACT_AGENT_PROTOCOL.md`): an optional boolean `readonly` on any setting.
The PWA renders a readonly field as a value line, never an input, and never
POSTs it. Health-check detail and "run now" stay where they are (Settings ›
Health); the Memory section is *what memory is doing and with what*, one glance.

## 4. Out of scope (named so they are not forgotten)

- Local embeddings + re-index (fully off-grid memory).
- A per-profile toolset editor in the UI (profile YAML is the editor for now).
- Vision on the standby host; the local profile only works on whichever box
  is actually running the local model server (single-GPU deployments
  today). On the standby the preflight fails and the toggle refuses —
  correct behaviour.
