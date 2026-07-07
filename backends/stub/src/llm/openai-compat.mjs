// OpenAI-compatible chat-completions adapter — one adapter, many
// providers. Anything that speaks POST {base}/chat/completions with
// `stream: true` works: OpenRouter (the default — one key unlocks every
// major model), OpenAI, Groq, Mistral, Together, LM Studio, vLLM, ...
//
// Config (env or constructor):
//   OPENAI_COMPAT_BASE_URL  default https://openrouter.ai/api/v1
//   OPENAI_COMPAT_API_KEY   required
//   OPENAI_COMPAT_MODEL     default openrouter/auto (OpenRouter routes)
//
// Streaming: standard OpenAI SSE — `data: {json}` lines with
// choices[0].delta.content fragments, terminated by `data: [DONE]`.
//
// On API error we yield a single error message rather than throwing —
// same contract as the gemini adapter (a rendered error beats a stuck
// thinking-cursor).

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openrouter/auto';

export class OpenAICompatLLM {
  /** @param {{apiKey: string, baseUrl?: string, model?: string}} opts */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.model = opts.model || DEFAULT_MODEL;
    // Short host tag so healthz/settings show where requests go.
    let host = 'cloud';
    try { host = new URL(this.baseUrl).hostname.replace(/^api\./, ''); } catch {}
    this.name = `${host}:${this.model}`;
  }

  /**
   * @param {Array<{role: string, content: string}>} messages
   */
  async *stream(messages) {
    if (!this.apiKey) {
      yield '[cloud error] no OPENAI_COMPAT_API_KEY set';
      return;
    }
    let resp;
    try {
      resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });
    } catch (e) {
      yield `[cloud error] ${e?.message ?? e}`;
      return;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      yield `[cloud error] HTTP ${resp.status}: ${text.slice(0, 300)}`;
      return;
    }

    // SSE parse: accumulate bytes, split on newlines, handle `data: ` lines.
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* keep-alive comment or partial frame — skip */ }
      }
    }
  }
}
