/**
 * @fileoverview Hermes approval-prompt parsing shared by every surface
 * that renders one (transcript card, in-app banner, Activity tray).
 *
 * The gateway's prompt has a fixed shape:
 *
 *     ⚠️ Dangerous command requires approval:
 *
 *     <command, possibly multi-line>
 *
 *     Reason: <why the gate fired>
 *     Reply /approve to execute, /approve session to …, or /deny to cancel.
 *
 * Some producers prefix metadata lines (session_id: …) — stripped first.
 */

export interface ApprovalPrompt {
  /** The gated command, trimmed; '' when the prompt didn't match. */
  command: string;
  /** The "Reason:" / "Why it was flagged:" line body, '' when absent. */
  reason: string;
}

/** Prefer the structured fields the plugin's exec-approval hook puts on
 *  the envelope (hermes 0.21.5+ hands it the command and reason directly);
 *  fall back to parsing the prompt text. */
export function approvalFromEnvelope(env: { text?: string; content?: string; command?: string; reason?: string } | null | undefined): ApprovalPrompt {
  const command = typeof env?.command === 'string' ? env.command.trim() : '';
  const reason = typeof env?.reason === 'string' ? env.reason.trim() : '';
  if (command || reason) return { command, reason };
  return parseApprovalPrompt(String(env?.text ?? env?.content ?? ''));
}

const META_LINE_RE = /^\s*(?:session_id|job_id|chat_id|message_id|user_id|run_id|trace_id)\s*:\s*\S/i;
const SEP_OR_BLANK_RE = /^\s*(?:-{3,}|=+|\*+)?\s*$/;

export function stripLeadingMetadata(s: string): string {
  const lines = (s || '').split('\n');
  let i = 0;
  while (i < lines.length && (META_LINE_RE.test(lines[i]) || SEP_OR_BLANK_RE.test(lines[i]))) i++;
  return lines.slice(i).join('\n');
}

// Two generations of gateway wording (hermes 0.21.5, 2026-09-28, changed
// the words and nobody's card matched for a week): the old
// "⚠️ Dangerous command requires approval:" / "Reason:" / "Reply /approve …"
// and the new "⚠️ **Hermes wants to run a command that needs your OK**" /
// fenced command / "Why it was flagged: …" / "Reply `/approve` to run it once…".
const HEADER_RE = /Dangerous command requires approval|wants to run a command that needs your OK/i;
const REASON_RE = /^\**(?:Reason|Why it was flagged)\**:\s*(.+)$/im;
const REASON_LINE_RE = /^\**(?:Reason|Why it was flagged)\**:/i;
const REPLY_LINE_RE = /^\**Reply\s+`?\/approve/i;
const DEADLINE_LINE_RE = /^If you don't answer within/i;

export function parseApprovalPrompt(raw: string): ApprovalPrompt {
  const text = stripLeadingMetadata(raw || '');
  const reason = REASON_RE.exec(text)?.[1]?.trim() || '';
  const lines = text.split('\n');
  const command: string[] = [];
  let inCommand = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (HEADER_RE.test(trimmed)) {
      inCommand = true;
      continue;
    }
    if (!inCommand) continue;
    if (!trimmed) {
      if (command.length) command.push('');
      continue;
    }
    if (REASON_LINE_RE.test(trimmed) || REPLY_LINE_RE.test(trimmed) || DEADLINE_LINE_RE.test(trimmed)) break;
    if (trimmed.startsWith('```')) continue;   // the fence is not the command
    command.push(line.replace(/\s+$/, ''));
  }
  return {
    command: command.join('\n').trim().replace(/\n{3,}/g, '\n\n'),
    reason,
  };
}

/** One-line preview for banner / tray rows: "reason: command", falling
 *  back to whichever half exists, then the raw text. */
export function approvalPreview(raw: string): string {
  const { command, reason } = parseApprovalPrompt(raw);
  if (reason && command) return `${reason}: ${command}`;
  return reason || command || stripLeadingMetadata(raw || '');
}
