---
name: integrations-registry
description: Use when the user wants something they built themselves (a Playwright harness, a scraper, a local service, a hand-rolled API client) to show up in Parley's Settings › Integrations with a health status, or asks how to add a custom integration. Writes one YAML file per integration into the agent's integrations registry and a bounded status command for it.
version: 1.0.0
author: Parley
license: MIT
metadata:
  hermes:
    tags: [parley, integrations, status, registry]
    related_skills: []
---

# Integrations registry

Parley's Settings › Integrations pane lists everything this agent is connected
to. Standard integrations (MCP servers, chat platforms, model providers, plugins
with credentials) are discovered automatically. Anything the user rolled
themselves is declared in the **registry**: one YAML file per integration under

    $HERMES_HOME/integrations/<name>.yaml        (usually ~/.hermes/integrations/)

The pane renders each file as a card with a status pill, a report, a **Test**
button (runs `status.command`) and, when present, setup instructions.

## File format

```yaml
name: linkedin-harness            # optional; defaults to the file stem. [a-z0-9_-]{1,20}
label: LinkedIn (Playwright harness)
description: Logged-in LinkedIn profile driven by my Playwright scripts.
docs: https://github.com/me/li-harness#readme   # optional; http(s) URLs become a link
status:                           # optional — without it the card stays UNKNOWN
  command: ~/code/li-harness/bin/status         # exit 0 = OK, 1 = WARN, 2+ = FAIL
  timeout_s: 60                   # default 60; keep probes short and read-only
setup:                            # optional
  kind: instructions              # phase 1 renders `markdown`; command/api-key come later
  markdown: |
    Log in once in the harness profile: `bin/login`, then run `bin/status`.
```

Rules for `status.command`:

- It must be **read-only and bounded**: check a cookie jar, hit one cheap
  endpoint, verify a process is up. Never log in, post, or mutate state from a
  status probe — the user presses Test freely.
- Print a short human report on stdout (first line = the summary). The exit
  code is the verdict; stdout is shown verbatim in the card.
- `~` and `$VARS` are expanded; relative paths resolve from the registry dir.
- The command runs with the agent's environment and `H_NO_ALERT=1`.

## Procedure

1. Ask what the integration is, where its code lives, and what "healthy" means
   for it (a logged-in session? a reachable local service? a recent run?).
2. Write the status script if none exists (bash or python, executable), and
   try it once: `bin/status; echo rc=$?`.
3. Write `$HERMES_HOME/integrations/<name>.yaml` as above. Keep `name` short
   (the Parley id is `int-custom-<name>`, 32 chars max).
4. Tell the user it is in Settings › Integrations and to press **Test**. There
   is no restart; the pane reads the registry on each open.

Do not put secrets in the YAML. A command that needs a token should read it
from the environment or the agent's secret store.
