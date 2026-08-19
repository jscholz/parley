#!/usr/bin/env bash
# Parley — one-command install for Mac / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jscholz/parley/master/install.sh | bash
#
#   ...or, if you've already cloned the repo, just run it in place:
#       cd parley && ./install.sh
#
# When piped through curl, clones to ./parley in your CURRENT
# directory (cd into where you want it first). When run as a file from
# inside an existing checkout, uses that checkout in place. Override
# the target either way with PARLEY_INSTALL_DIR=/abs/path.
#
# What it does:
#   1. Verifies node >= 22 (parley uses node 22's
#      --experimental-strip-types flag at runtime).
#   2. Clones the repo to ./parley (or, if run from inside an existing
#      checkout, uses it in place — no pull, no branch surprises).
#   3. Runs `npm install` at root + under `backends/stub/`.
#   4. Copies `.env.example` to `.env` (idempotent).
#   5. Provisions audio-bridge/.venv for server-side voice barge VAD
#      (optional, gated on python3; onnxruntime-only, no torch/CUDA).
#   6. Starts the proxy + the in-tree stub agent (echo LLM) — no API
#      keys required. Open the printed URL.
#
# After it boots, point at a real backend by editing `./parley/.env`
# (uncomment PARLEY_PLATFORM_URL) and restarting `npm start`.

set -euo pipefail

# PARLEY_INSTALL_DIR primary; legacy SIDEKICK_INSTALL_DIR honored.
INSTALL_DIR="${PARLEY_INSTALL_DIR:-${SIDEKICK_INSTALL_DIR:-$(pwd)/parley}}"
REPO_URL="https://github.com/jscholz/parley.git"
USE_EXISTING_CHECKOUT=0

# If invoked from inside an existing parley checkout (./install.sh
# rather than `curl | bash`), use that checkout as the target instead
# of cloning a sibling. The user is presumably driving their own
# branch, so we skip the auto-pull too. Env override still wins.
if [ -z "${PARLEY_INSTALL_DIR:-}" ] && [ -z "${SIDEKICK_INSTALL_DIR:-}" ] && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -d "$SCRIPT_DIR/.git" ] \
     && [ -f "$SCRIPT_DIR/package.json" ] \
     && grep -qE '"name": *"(parleyvoo|sidekick-portal)"' "$SCRIPT_DIR/package.json"; then
    INSTALL_DIR="$SCRIPT_DIR"
    USE_EXISTING_CHECKOUT=1
  fi
fi

echo "==> parley install — target: $INSTALL_DIR"

# 1. Node version check
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed. Install Node 22+ first:"
  echo "  macOS:   brew install node"
  echo "  Linux:   https://nodejs.org or your package manager"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: node $(node -v) is too old. Parley requires Node 22+."
  echo "  Update via brew (\`brew upgrade node\`) or nvm."
  exit 1
fi
echo "==> node $(node -v) ✓"

# 2. Clone or pull
if [ "$USE_EXISTING_CHECKOUT" = "1" ]; then
  echo "==> running in place inside existing checkout (no pull)"
elif [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> existing checkout — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only origin master
else
  echo "==> cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 3. npm install (root + agent)
echo "==> installing root dependencies"
npm install --no-audit --no-fund
if [ -f "backends/stub/package.json" ]; then
  echo "==> installing stub agent dependencies"
  (cd backends/stub && npm install --no-audit --no-fund)
fi

# 4. .env (idempotent)
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "==> created .env (copy of .env.example — edit to override)"
else
  echo "==> .env already exists (preserved)"
fi

# 5. Audio-bridge venv (optional — gated on python3).
#    Provisions server-side voice barge VAD. onnxruntime-only now (no
#    torch/CUDA, see audio-bridge/requirements.txt), so this is a small
#    download. Non-fatal: if python3 is missing or pip fails, the PWA's
#    FallbackVadSource just uses client-side VAD instead.
if command -v python3 >/dev/null 2>&1 && [ -f "audio-bridge/requirements.txt" ]; then
  echo "==> provisioning audio-bridge venv (server-side voice barge VAD)"
  bridge_ok=1
  if [ ! -d "audio-bridge/.venv" ]; then
    python3 -m venv audio-bridge/.venv || bridge_ok=0
  fi
  if [ "$bridge_ok" = "1" ]; then
    audio-bridge/.venv/bin/python -m pip install --quiet --upgrade pip || true
    if audio-bridge/.venv/bin/python -m pip install --quiet -r audio-bridge/requirements.txt; then
      echo "==> audio-bridge venv ready ✓"
    else
      bridge_ok=0
    fi
  fi
  if [ "$bridge_ok" = "0" ]; then
    echo "==> WARNING: audio-bridge venv setup failed — voice barge will use"
    echo "    client-side VAD. Rerun later:"
    echo "    python3 -m venv audio-bridge/.venv && \\"
    echo "    audio-bridge/.venv/bin/pip install -r audio-bridge/requirements.txt"
  fi
else
  echo "==> python3 not found — skipping audio-bridge venv (voice barge uses"
  echo "    client-side VAD; install python3 + rerun to enable server VAD)"
fi

# 6. Start
echo ""
echo "================================================================"
echo "  Parley is starting up."
echo ""
echo "  Defaults: proxy on :3001, in-tree stub agent on :4001 (echo"
echo "  LLM, no API keys required). Both ports auto-shift if busy"
echo "  (3002/4002, etc.)."
echo ""
echo "  Open the URL printed below in your browser."
echo "  Stop with Ctrl+C."
echo "================================================================"
echo ""

exec npm start
