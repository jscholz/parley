#!/usr/bin/env bash
set -u
step() { echo; echo "#### [$(date +%T)] $*"; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl ca-certificates procps >/dev/null 2>&1
curl -fsSL https://deb.nodesource.com/setup_22.x 2>/dev/null | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null 2>&1; node -v
useradd -m tester; su - tester -s /bin/bash <<'INNER'
step() { echo; echo "#### [$(date +%T)] $*"; }
step "npx parleyvoo (README headline path), 120 s"
(cd ~ && BROWSER=none PARLEY_NO_BROWSER=1 timeout 120 npx -y parleyvoo > ~/npx.log 2>&1 &)
for i in $(seq 1 100); do sleep 1; curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/ 2>/dev/null | grep -q 200 && break; done
echo "root: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/)  config: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/config)  health: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/parley/health)"
echo "--- npx log (first 50) ---"; head -50 ~/npx.log | cut -c1-200
echo "--- npx log errors ---"; grep -inE "error|cannot|enoent|sidekick|exception|failed" ~/npx.log | head -20
echo "--- installed package ---"; ls ~/.npm/_npx/*/node_modules/parleyvoo/package.json 2>/dev/null | head -1 | xargs -r grep -m1 '"version"'
step "done"
INNER
