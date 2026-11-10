#!/usr/bin/env bash
# Virgin Ubuntu 24.04 install of the PUBLIC parley repo, as a new user would do it.
set -u
step() { echo; echo "#### [$(date +%T)] $*"; }
step "apt base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl git ca-certificates python3 python3-venv python3-pip build-essential >/dev/null 2>&1 && echo "apt ok" || echo "APT FAILED"
step "node 22 (nodesource)"
curl -fsSL https://deb.nodesource.com/setup_22.x 2>/dev/null | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null 2>&1; node -v; npm -v
useradd -m tester 2>/dev/null; chown -R tester:tester /home/tester
su - tester -s /bin/bash <<'INNER'
set -u
step() { echo; echo "#### [$(date +%T)] $*"; }
cd ~
step "A. README manual path: git clone"
git clone -q https://github.com/jscholz/parley.git parley-manual && cd parley-manual && git log -1 --oneline || { echo "CLONE FAILED"; exit 1; }
step "A. cp .env.example .env && npm install"
cp .env.example .env && npm install --no-audit --no-fund 2>&1 | tail -5; echo "npm install exit: ${PIPESTATUS[0]}"
step "A. npm run build"
npm run build 2>&1 | tail -5; echo "build exit: ${PIPESTATUS[0]}"
step "A. npm run typecheck"
npm run typecheck 2>&1 | tail -15; echo "typecheck exit: ${PIPESTATUS[0]}"
step "A. npm start (45s) + probes"
(PARLEY_NO_BROWSER=1 BROWSER=none npm start > ~/start-manual.log 2>&1 &)
for i in $(seq 1 45); do sleep 1; curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/ 2>/dev/null | grep -q "200" && break; done
echo "root: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/)"
echo "config: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/config)"
echo "health: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/parley/health)"
echo "sessions: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/parley/sessions)"
echo "--- start log (first 60 lines) ---"; head -60 ~/start-manual.log
echo "--- start log errors ---"; grep -inE "error|cannot|enoent|sidekick|exception|failed" ~/start-manual.log | head -30
pkill -f "node .*server" 2>/dev/null; pkill -f "parley" 2>/dev/null; sleep 2
step "A. npm test (unit)"
cd ~/parley-manual && timeout 900 npm test 2>&1 | grep -E "^# (pass|fail)|^not ok" | head -20
step "B. install.sh path"
cd ~ && PARLEY_INSTALL_DIR=$HOME/parley-installsh timeout 900 bash -c 'curl -fsSL https://raw.githubusercontent.com/jscholz/parley/master/install.sh | PARLEY_NO_BROWSER=1 BROWSER=none bash' > ~/installsh.log 2>&1 &
pid=$!
for i in $(seq 1 600); do sleep 1; if ! kill -0 $pid 2>/dev/null; then break; fi; if grep -q "localhost:3001\|QR\|listening" ~/installsh.log 2>/dev/null; then sleep 8; break; fi; done
echo "install.sh running: $(kill -0 $pid 2>/dev/null && echo yes || echo no)"
echo "--- install.sh log (tail 60) ---"; tail -60 ~/installsh.log
echo "--- install.sh errors ---"; grep -inE "error|cannot|enoent|sidekick|exception|failed|warn" ~/installsh.log | head -30
pkill -f "node" 2>/dev/null
step "C. residual sidekick in the clone"
cd ~/parley-manual && grep -rIil sidekick --exclude-dir=node_modules --exclude-dir=.git . | grep -vE "\.md$" | head -30
step "done"
INNER
