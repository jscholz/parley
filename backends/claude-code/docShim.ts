// display_doc over the SDK's in-process MCP surface — "the elegant
// trick" from the research doc: the adapter injects a tiny MCP server
// exposing display_doc; its handler reads the file server-side and
// pushes a doc_show envelope into the CURRENT turn's stream, so the
// PWA's Docs panel works on Claude Code with zero Claude Code changes.
//
// One server instance is built per turn, closing over that turn's
// chat_id + push sink — that's how a tool call attributes itself to the
// right chat under concurrent turns (hermes solves the same problem
// with per-session env; we get it for free from the closure).
//
// Schema: the SDK's tool() takes a Zod raw shape (wired 2026-07-14).
// Tests fake tool()/createSdkMcpServer, so they never invoke the
// validator — but the shape below is the real thing.

import { readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath, extname, basename } from 'node:path';
import { z } from 'zod';
import type { AgentSdk, SdkMcpServerConfig, SdkCallToolResult } from './sdkTypes.ts';
import type { ClaudeCodeEnvelope } from './envelopes.ts';
import { docIdFor } from './envelopes.ts';

export const DOC_SERVER_NAME = 'parley';
export const DISPLAY_DOC_TOOL = 'display_doc';

/** Mirror of the hermes plugin's cap — doc_show carries the full body
 *  through the SSE ring. */
export const MAX_DOC_BYTES = 1024 * 1024;

const FORMAT_BY_SUFFIX: Record<string, string> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
};

export const DISPLAY_DOC_INPUT_SCHEMA = {
  path: z.string().describe('Absolute path of the file to display'),
  title: z.string().optional().describe('Optional panel title (defaults to the filename)'),
};

function textResult(payload: Record<string, unknown>, isError = false): SdkCallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

/** Build the per-turn MCP server exposing display_doc for one chat. */
export function buildDocServer(opts: {
  sdk: AgentSdk;
  chatId: string;
  push: (env: ClaudeCodeEnvelope) => void;
  now?: () => number;
}): SdkMcpServerConfig {
  const now = opts.now ?? Date.now;
  const displayDoc = opts.sdk.tool(
    DISPLAY_DOC_TOOL,
    'Display a document in the Parley app\'s Docs side panel — use when ' +
      'the user asks to see/read a file you wrote (notes, a report, deck ' +
      'content) without opening an editor. Renders markdown and HTML; ' +
      'other text shows as plain text. Re-calling with the same path ' +
      'refreshes the existing panel entry.',
    DISPLAY_DOC_INPUT_SCHEMA,
    async (args: Record<string, unknown>): Promise<SdkCallToolResult> => {
      const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
      if (!rawPath) return textResult({ error: 'path is required' }, true);
      const path = resolvePath(rawPath);
      let size: number;
      try {
        size = statSync(path).size;
      } catch (e) {
        return textResult({ error: `could not stat ${path}: ${(e as Error)?.message}` }, true);
      }
      if (size > MAX_DOC_BYTES) {
        return textResult({
          error: `file is ${size} bytes; display_doc caps at ${MAX_DOC_BYTES}. ` +
            'Write a trimmed copy and display that.',
        }, true);
      }
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch (e) {
        return textResult({ error: `could not read ${path}: ${(e as Error)?.message}` }, true);
      }
      const title = (typeof args.title === 'string' && args.title.trim()) || basename(path);
      const format = FORMAT_BY_SUFFIX[extname(path).toLowerCase()] ?? 'text';
      const docId = docIdFor(path, title);
      opts.push({
        type: 'doc_show',
        chat_id: opts.chatId,
        title,
        content,
        format,
        path,
        doc_id: docId,
        displayed_at: now(),
      });
      return textResult({
        success: true,
        displayed: path,
        format,
        bytes: size,
        doc_id: docId,
        note: 'The document is now open in the user\'s Docs panel.',
      });
    },
  );

  return opts.sdk.createSdkMcpServer({
    name: DOC_SERVER_NAME,
    version: '1.0.0',
    tools: [displayDoc],
  });
}
