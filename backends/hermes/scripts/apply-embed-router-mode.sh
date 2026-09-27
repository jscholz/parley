#!/usr/bin/env bash
# parley / backends/hermes/scripts / apply-embed-router-mode.sh
#
# Sibling of apply-memory-profile.sh for the EMBEDDING side of the memory
# server: set where embeddings are computed and bounce the router that
# fronts them. The router (the operator's own OpenAI-compatible endpoint;
# reference: hermes-agent-private/scripts/embed-router.py) reads
# EMBED_ROUTER_MODE at start:
#
#   auto   local server first, cloud fallback on failure   (default)
#   local  local server only — never spends on the cloud
#   cloud  cloud only — frees the GPU / survives a dead local server
#
#   apply-embed-router-mode.sh <auto|local|cloud>
#
# Contract mirrors apply-memory-profile.sh: the write goes through hermes'
# save_env_value (symlink-safe), the unit is restarted and this blocks until
# /health answers. Overridable: EMBED_ROUTER_UNIT (default
# parley-embed-router.service), EMBED_ROUTER_URL (default http://127.0.0.1:8012).
# Called by Parley's hermes plugin (parley_route_settings.py
# ``_apply_embed_router_mode``); process control stays out of Parley's Python.
set -euo pipefail
HERMES="${HERMES:-$HOME/.hermes}"
H_PY="${H_PY:-${HERMES}/hermes-agent/venv/bin/python}"
ER_URL="${EMBED_ROUTER_URL:-http://127.0.0.1:8012}"
ER_UNIT="${EMBED_ROUTER_UNIT:-parley-embed-router.service}"
ER_WAIT_SECONDS="${ER_WAIT_SECONDS:-60}"

usage() { echo "usage: $(basename "$0") <auto|local|cloud>" >&2; exit 2; }
[[ $# -eq 1 ]] || usage
MODE="$1"
case "${MODE}" in auto|local|cloud) ;; *) usage ;; esac
[[ -x "${H_PY}" ]] || { echo "no hermes python at ${H_PY}" >&2; exit 1; }

echo "→ embedding router mode: ${MODE}"
env -u PYTHONPATH "${H_PY}" - "${MODE}" <<'PY'
import sys
from hermes_cli.config import get_env_path, save_env_value
save_env_value("EMBED_ROUTER_MODE", sys.argv[1])
print(f"  wrote {get_env_path()}")
PY
ENV_PATH="${HERMES}/.env"
if [[ -e "${ENV_PATH}" && ! -L "${ENV_PATH}" ]]; then
  echo "WARNING: ${ENV_PATH} is no longer a symlink — its repo copy (if any) is orphaned" >&2
fi

if ! systemctl --user cat "${ER_UNIT}" >/dev/null 2>&1; then
  echo "→ ${ER_UNIT} is not installed on this host; mode written, nothing to restart"
  exit 0
fi
echo "→ restarting ${ER_UNIT}"
systemctl --user restart "${ER_UNIT}"
echo -n "→ waiting for ${ER_URL}/health "
deadline=$(( $(date +%s) + ER_WAIT_SECONDS ))
while :; do
  body="$(curl -s -m 5 "${ER_URL}/health" 2>/dev/null || true)"
  if [[ "${body}" == *'"status":"ok"'* ]]; then
    echo "— ok"
    exit 0
  fi
  if (( $(date +%s) >= deadline )); then
    echo "— TIMEOUT after ${ER_WAIT_SECONDS}s"
    echo "last /health response: ${body:-<no response>}" >&2
    systemctl --user status "${ER_UNIT}" --no-pager -n 20 >&2 || true
    exit 1
  fi
  echo -n "."
  sleep 2
done
