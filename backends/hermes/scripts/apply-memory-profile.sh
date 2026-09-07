#!/usr/bin/env bash
# parley / backends/hermes/scripts / apply-memory-profile.sh
#
# Reference implementation of the runtime-profile LLM-routing script
# (docs/LOCAL_MODE.md §1 rule 2.4). Point hindsight (the memory server) at
# an LLM, then restart it and wait until it answers healthy again.
#
#   apply-memory-profile.sh <provider> <model> [base_url]
#
#   apply-memory-profile.sh openai-codex gpt-5.4-mini
#   apply-memory-profile.sh lmstudio qwen3.6-35b-a3b http://127.0.0.1:8000/v1
#
# Contract:
#   - args: exactly 2 or 3 positional (provider, model, optional base_url).
#     Omitting base_url UNSETS the key rather than writing an empty line.
#   - idempotent: rerunning with the same values rewrites the same lines
#     and bounces the server; running it twice in a row is safe.
#   - writes: HINDSIGHT_API_LLM_PROVIDER / _MODEL / _BASE_URL in hermes'
#     own .env (via hermes_cli.config's save_env_value/remove_env_value —
#     never a raw file rewrite, see the symlink note below).
#   - side effect: restarts the memory-server systemd unit and blocks until
#     its /health endpoint reports healthy (or HS_WAIT_SECONDS elapses).
#
# Called by Parley's hermes plugin when the runtime profile changes
# (parley_route_settings.py's ``_restart_memory_server``) and usable by
# hand. Process control lives here, with the other ops scripts, rather
# than inside Parley's Python.
#
# Two things that have already cost time on real deployments, encoded as
# rules:
#
#   * a hermes ``.env``/``config.yaml`` is commonly a SYMLINK into the
#     operator's own config repo. Anything that renames a new file over
#     the link (sed -i, mv, install) silently turns it into a plain file
#     and the repo copy stops changing. So the write below goes through
#     hermes' own save_env_value/remove_env_value, whose _write_env_lines
#     resolves the symlink first (utils.atomic_replace) and writes the
#     REAL file in place.
#   * hindsight only reads these keys at start (EnvironmentFile= in its
#     systemd unit), so a write without a restart is a no-op that looks
#     like it worked.
#
# Testing: point HERMES at a scratch hermes-home directory (never a real
# deployment's) so save_env_value/remove_env_value touch a throwaway .env.
set -euo pipefail

HERMES="${HERMES:-$HOME/.hermes}"
H_PY="${H_PY:-${HERMES}/hermes-agent/venv/bin/python}"
HS_URL="${HS_URL:-http://127.0.0.1:8765}"
HS_UNIT="${HS_UNIT:-hindsight-server.service}"
HS_WAIT_SECONDS="${HS_WAIT_SECONDS:-90}"

usage() {
  echo "usage: $(basename "$0") <provider> <model> [base_url]" >&2
  echo "  provider  hindsight LLM provider (openai-codex, openai, lmstudio, ...)" >&2
  echo "  model     model id for that provider" >&2
  echo "  base_url  OpenAI-compatible endpoint; omit to UNSET the key" >&2
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage
PROVIDER="$1"; MODEL="$2"; BASE_URL="${3:-}"
[[ -n "${PROVIDER}" && -n "${MODEL}" ]] || usage
[[ -x "${H_PY}" ]] || { echo "no hermes python at ${H_PY}" >&2; exit 1; }

echo "→ hindsight LLM: provider=${PROVIDER} model=${MODEL} base_url=${BASE_URL:-<unset>}"

# An empty base_url REMOVES the key rather than writing an empty line:
# hindsight reads `os.getenv(...) or None`, so the two are equivalent to it,
# but a file that only lists what is actually set is the one you can read in
# an incident.
env -u PYTHONPATH "${H_PY}" - "${PROVIDER}" "${MODEL}" "${BASE_URL}" <<'PY'
import sys
from hermes_cli.config import get_env_path, remove_env_value, save_env_value

provider, model, base_url = sys.argv[1], sys.argv[2], sys.argv[3]
save_env_value("HINDSIGHT_API_LLM_PROVIDER", provider)
save_env_value("HINDSIGHT_API_LLM_MODEL", model)
if base_url:
    save_env_value("HINDSIGHT_API_LLM_BASE_URL", base_url)
else:
    remove_env_value("HINDSIGHT_API_LLM_BASE_URL")
print(f"  wrote {get_env_path()}")
PY

# Prove the symlink survived. If this ever fires, the repo copy has been
# orphaned and the next `git pull` will look like it lost the change.
ENV_PATH="${HERMES}/.env"
if [[ -e "${ENV_PATH}" && ! -L "${ENV_PATH}" ]]; then
  echo "WARNING: ${ENV_PATH} is no longer a symlink — its repo copy (if any) is orphaned" >&2
fi

echo "→ restarting ${HS_UNIT}"
systemctl --user restart "${HS_UNIT}"

echo -n "→ waiting for ${HS_URL}/health "
deadline=$(( $(date +%s) + HS_WAIT_SECONDS ))
while :; do
  body="$(curl -s -m 5 "${HS_URL}/health" 2>/dev/null || true)"
  if [[ "${body}" == *'"status":"healthy"'* ]]; then
    echo "— healthy"
    exit 0
  fi
  if (( $(date +%s) >= deadline )); then
    echo "— TIMEOUT after ${HS_WAIT_SECONDS}s"
    echo "last /health response: ${body:-<no response>}" >&2
    systemctl --user status "${HS_UNIT}" --no-pager -n 20 >&2 || true
    exit 1
  fi
  echo -n "."
  sleep 2
done
