#!/usr/bin/env bash
# Virgin Ubuntu 24.04: the hermes workflow per
# backends/hermes/README.md (symlink, `hermes plugins enable`, token,
# toolsets merged into the existing key, gateway run, health probe).
set -u
step() { echo; echo "#### [$(date +%T)] $*"; }
export DEBIAN_FRONTEND=noninteractive HOME=/root
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl git ca-certificates python3 python3-venv build-essential openssl procps >/dev/null 2>&1 && echo "apt ok"
step "hermes-agent upstream installer (--skip-setup)"
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh && timeout 1500 bash /tmp/hermes-install.sh --skip-setup > /tmp/hermes-install.log 2>&1; echo "installer exit: $?"; tail -3 /tmp/hermes-install.log
export PATH="$HOME/.hermes/bin:$HOME/.local/bin:$PATH"
hermes --version 2>&1 | head -1; git -C $HOME/.hermes/hermes-agent log -1 --format="upstream %h %ad" --date=short 2>/dev/null
step "clone public parley + README steps 2–5 (corrected)"
cd $HOME && git clone -q --depth 1 https://github.com/jscholz/parley.git parley && git -C parley log -1 --oneline
mkdir -p $HOME/.hermes/plugins && ln -s $HOME/parley/backends/hermes/plugin $HOME/.hermes/plugins/parley
hermes plugins enable parley 2>&1 | grep -vE "^\s*$" | tail -5
TOKEN=$(openssl rand -hex 32); printf 'PARLEY_PLATFORM_TOKEN=%s\nPARLEY_PLATFORM_ALLOW_ALL_USERS=true\n' "$TOKEN" >> $HOME/.hermes/.env
CFG=$HOME/.hermes/config.yaml
python3 /t/merge_toolsets.py "$CFG"
grep -n -A3 "^platform_toolsets:" $CFG | head -6
step "plugin visible + enabled?"
hermes plugins list 2>&1 | grep -iE "parley|error|formatting" | head -6
hermes plugins show parley 2>&1 | head -12
step "gateway run (120 s) + health probe"
(timeout 120 hermes gateway run > $HOME/gateway.log 2>&1 &)
for i in $(seq 1 100); do sleep 1; curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:8645/v1/health 2>/dev/null | grep -qE "200|401|403" && break; done
echo "parley plugin health: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8645/v1/health) (with token: $(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8645/v1/health))"
curl -s -m 5 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8645/v1/capabilities | head -c 400; echo
echo "--- gateway log (first 60) ---"; head -60 $HOME/gateway.log | cut -c1-200
echo "--- gateway log: parley / errors ---"; grep -inE "parley|error|traceback|exception|modulenotfound|importerror|warn" $HOME/gateway.log | head -60
step "done"
