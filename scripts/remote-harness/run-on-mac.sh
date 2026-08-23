#!/usr/bin/env bash
# Ship the Open-in-chat harness to jons-macbook-air and run it there.
#
# The Mac sits far from fontbrain/London, so the real network latency that
# surfaces the drill race is in play. Chrome + playwright-core@1.59.1 are
# already installed in ~/parley-harness on the Mac. Node is only on PATH
# under a login shell, so we invoke via `bash -lc`.
#
# Usage: scripts/remote-harness/run-on-mac.sh [PIN_INDEX] [REPEATS]
#   env passthrough: PARLEY_URL VERBOSE DRILL_TIMEOUT
set -euo pipefail

HOST="${HARNESS_HOST:-jons-macbook-air}"
REMOTE_DIR="\$HOME/parley-harness"
LOCAL="$(cd "$(dirname "$0")" && pwd)/open-in-chat-trace.mjs"
PIN_INDEX="${1:-0}"
REPEATS="${2:-2}"

# Ship the scenario (overwrite each run so edits propagate).
scp -q "$LOCAL" "$HOST:parley-harness/open-in-chat-trace.mjs"

ENVS="PIN_INDEX=$PIN_INDEX REPEATS=$REPEATS"
[ -n "${PARLEY_URL:-}" ]  && ENVS="$ENVS PARLEY_URL=$PARLEY_URL"
[ -n "${DRILL_TIMEOUT:-}" ] && ENVS="$ENVS DRILL_TIMEOUT=$DRILL_TIMEOUT"
[ -n "${VERBOSE:-}" ]       && ENVS="$ENVS VERBOSE=$VERBOSE"

# shellcheck disable=SC2029
ssh "$HOST" "bash -lc 'cd $REMOTE_DIR && $ENVS node open-in-chat-trace.mjs'"
