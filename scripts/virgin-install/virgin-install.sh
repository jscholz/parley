#!/usr/bin/env bash
# Clean-install check: run the README's install paths on a VIRGIN
# ubuntu:24.04 container, as a new user would, and print what broke.
#
#   scripts/virgin-install/virgin-install.sh            # all three
#   scripts/virgin-install/virgin-install.sh parley     # clone + install.sh + unit tests
#   scripts/virgin-install/virgin-install.sh npx        # `npx parleyvoo` (published package)
#   scripts/virgin-install/virgin-install.sh hermes     # upstream hermes installer + backends/hermes/README.md
#
# Needs docker. Each run is a throwaway container; logs land in
# /tmp/parley-virgin-<path>.log. Added 2026-11-10 after a new user's
# clean clone failed on install docs that had drifted from the code.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
paths=("$@"); [ ${#paths[@]} -eq 0 ] && paths=(parley npx hermes)
rc=0
for p in "${paths[@]}"; do
  log="/tmp/parley-virgin-$p.log"
  echo "==> virgin $p → $log"
  docker run --rm --name "parley-virgin-$p-$$" -v "$here:/t:ro" ubuntu:24.04 bash "/t/run-$p.sh" > "$log" 2>&1 || true
  if grep -qE "FAILED|exit: [1-9]|health: 000|Traceback|# fail [1-9]" "$log"; then
    echo "    ✗ $p — see $log"; grep -nE "FAILED|exit: [1-9]|health: 000|Traceback|# fail [1-9]" "$log" | head -5; rc=1
  else
    echo "    ✓ $p"; grep -E "root: |health: |# pass|parley plugin health" "$log" | head -4 | sed 's/^/      /'
  fi
done
exit $rc
