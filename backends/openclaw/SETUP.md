# backends/openclaw — local setup (manual steps)

This file captures the bits of openclaw setup that Claude can't do
non-interactively. Run these on cortex after a fresh openclaw install.

## 1. Codex OAuth (model provider)

Openclaw needs a model provider configured. OpenAI Codex OAuth with
`gpt-5.4-mini` as the default.

```bash
# Interactive — opens a browser for OAuth.
openclaw --profile sk-integ models auth login --provider openai-codex --set-default

# After auth completes, lock the default model to the cheap one:
openclaw --profile sk-integ models set openai-codex/gpt-5.4-mini

# Verify:
openclaw --profile sk-integ models status
# Expect: openai-codex/gpt-5.4-mini   …  Auth: yes
```

## 2. Verify end-to-end

```bash
# Gateway should be running via systemctl --user.
systemctl --user is-active openclaw-integ.service          # → active
curl -s https://cortex-lon1.taile0c895.ts.net:8646/v1/health
# → {"ok":true,"status":"ok","via":"parley-plugin"}
```

## 3. Open the Control UI

`https://cortex-lon1.taile0c895.ts.net:8646` from any device on
the tailnet (phone, laptop). If you see a "Browser origin not allowed"
error, the allowlist already includes this origin — restart the
gateway:

```bash
systemctl --user restart openclaw-integ.service
```

If you're hitting from a NEW origin (different domain / port), add it:

```bash
openclaw --profile sk-integ config set gateway.controlUi.allowedOrigins \
  '["https://cortex-lon1.taile0c895.ts.net:8646","<your-new-origin>"]'
systemctl --user restart openclaw-integ.service
```

## 4. Parley PWAs (already set up)

- `https://cortex-lon1.taile0c895.ts.net:3001` — pointed at hermes
- `https://cortex-lon1.taile0c895.ts.net:3002` — pointed at openclaw

Both PWAs are the same build; differ only in `PARLEY_PLATFORM_URL`
env var (see `parley-openclaw.service` unit). Use them to A/B
between backends.
