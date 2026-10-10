#!/usr/bin/env bash
# parley-agent-setup.sh — make the hermes agent in THIS home aware of Parley.
#
#   ~/code/parley/scripts/parley-agent-setup.sh            # idempotent; run after install/update
#
# What "aware" means (2026-10-11, the "Parley setup step"):
#   1. The parley plugin is enabled (plugins.enabled) — it registers the
#      display_doc tool AND a bounded system-prompt section that tells the
#      agent how to use Parley (voice tag, docs panel, media/attachment
#      lanes, link/media cards, meeting captures) with this install's proxy origin.
#      Nothing to configure for that part; it happens on gateway start.
#   2. The plugin's shipped skills (parley-pdf-rasterize,
#      meeting-transcript-ingest) are on hermes' skill path via
#      `skills.external_dirs`, so they appear in the agent's skill list.
#      This script adds that entry — comment-preserving, once.
#   2b. platform_toolsets.parley lists `hermes-parley` + `parley`, so the
#      plugin's registry toolset (display_doc) is part of every session.
#   3. PARLEY_PROXY_ORIGIN is sanity-checked: a second tenant on a shared
#      box runs on another port and must set it in ~/.hermes/.env.
# Restart the gateway afterwards (`systemctl --user restart hermes-gateway`)
# — the prompt section is frozen into each NEW session.
set -euo pipefail
export HERMES_DISABLE_LAZY_INSTALLS=1
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CFG="${HERMES_HOME}/config.yaml"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../backends/hermes/plugin" && pwd)"
SKILLS_DIR="${PLUGIN_DIR}/skills"
[[ -f "$CFG" ]] || { echo "no ${CFG} — install hermes first" >&2; exit 1; }
[[ -d "$SKILLS_DIR" ]] || { echo "no ${SKILLS_DIR} — plugin tree incomplete" >&2; exit 1; }

# The live hermes interpreter for this home (hermes' own yaml helper lives
# there; a plain PyYAML dump would strip every comment from config.yaml).
py=""
for facts in "${HERMES_HOME}"/installs/*/facts.json; do
  [[ -f "$facts" ]] || continue
  env_dir=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"]["venv"]["environment"])' "$facts" 2>/dev/null || true)
  for cand in "${env_dir}/bin/python" "${env_dir}/venv/bin/python"; do
    [[ -n "$env_dir" && -x "$cand" ]] && py="$cand"
  done
done
[[ -x "$py" ]] || { echo "could not find the hermes generation python under ${HERMES_HOME}/installs" >&2; exit 1; }
HERMES_SRC="${HERMES_HOME}/hermes-agent"

env -u PYTHONPATH PYTHONPATH="$HERMES_SRC" "$py" - "$CFG" "$SKILLS_DIR" <<'EOPY'
import sys
from ruamel.yaml import YAML
from utils import atomic_roundtrip_yaml_update
cfg, skills_dir = sys.argv[1], sys.argv[2]
yaml = YAML(); doc = yaml.load(open(cfg)) or {}
# 1. plugin enabled
enabled = list(((doc.get("plugins") or {}).get("enabled")) or [])
if "parley" not in enabled:
    enabled.append("parley"); atomic_roundtrip_yaml_update(cfg, "plugins.enabled", enabled)
    print("plugins.enabled: + parley")
else:
    print("plugins.enabled: parley ✓")
# 1b. platform_toolsets.parley — hermes seeds this map for its built-in
#     platforms only; without a parley row the session never includes the
#     plugin's `parley` registry toolset and display_doc is "not available"
#     (Akhil's first doc attempt, 2026-10-11). Mirror the owner's entry.
pts = dict((doc.get("platform_toolsets") or {}))
row = list(pts.get("parley") or [])
want = ["hermes-parley", "parley"]
if any(w not in row for w in want):
    row = row + [w for w in want if w not in row]
    atomic_roundtrip_yaml_update(cfg, "platform_toolsets.parley", row)
    print(f"platform_toolsets.parley: {row}")
else:
    print(f"platform_toolsets.parley: {row} ✓")
# 2. skills.external_dirs
ext = list(((doc.get("skills") or {}).get("external_dirs")) or [])
if skills_dir not in ext:
    ext.append(skills_dir); atomic_roundtrip_yaml_update(cfg, "skills.external_dirs", ext)
    print(f"skills.external_dirs: + {skills_dir}")
else:
    print(f"skills.external_dirs: {skills_dir} ✓")
EOPY

# 3. proxy origin sanity
ENVF="${HERMES_HOME}/.env"
origin=$(grep -E "^PARLEY_PROXY_ORIGIN=" "$ENVF" 2>/dev/null | cut -d= -f2- || true)
port=$(grep -E "^PORT=" "$ENVF" 2>/dev/null | cut -d= -f2- || true)
if [[ -z "$origin" && -n "$port" && "$port" != "3001" ]]; then
  echo "PARLEY_PROXY_ORIGIN=http://127.0.0.1:${port}" >> "$ENVF"
  echo "PARLEY_PROXY_ORIGIN: set to http://127.0.0.1:${port} (PORT=${port})"
else
  echo "PARLEY_PROXY_ORIGIN: ${origin:-default http://127.0.0.1:3001}"
fi

cat <<EON

The agent now knows Parley (after a gateway restart):
  - prompt section 'parley' (plugin-injected): voice tag, display_doc, media + attachment lanes, link/media cards, meeting captures
  - skills: $(ls "$SKILLS_DIR" | tr '\n' ' ')
Restart: systemctl --user restart hermes-gateway.service
EON
