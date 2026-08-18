/**
 * @fileoverview In-app notification banner for non-viewed chats.
 *
 * Notifications from other sessions need an immediate, clickable surface.
 * Cron output is informational; approval prompts are blocking and get
 * explicit action buttons that send the matching slash command into the
 * source chat.
 */

import { log } from '../util/log.ts';

const AUTO_DISMISS_MS = 6_000;

export type ApprovalAction = 'approve' | 'approve_session' | 'deny';

let bannerEl: HTMLElement | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let onOpenCb: ((chatId: string, msgId: string | null) => void) | null = null;
let onActionCb: ((chatId: string, action: ApprovalAction, msgId: string | null) => void | Promise<void>) | null = null;

interface ShowArgs {
  chatId: string;
  kind: string;
  content: string;
  sidekickId: string | null;
  chatLabel?: string;
}

export function init(opts: {
  onOpen: (chatId: string, msgId: string | null) => void;
  onAction?: (chatId: string, action: ApprovalAction, msgId: string | null) => void | Promise<void>;
}): void {
  onOpenCb = opts.onOpen;
  onActionCb = opts.onAction ?? null;
}

export function show(args: ShowArgs): void {
  ensureMounted();
  if (!bannerEl) return;
  const { kind, content, chatLabel } = args;
  const isApproval = kind === 'approval';
  const emoji = kind === 'cron' ? '⏰' : isApproval ? '⚠️' : '🔔';
  let body = content || '';
  if (kind === 'cron') {
    const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
    const m = headerRe.exec(body);
    if (m) body = `${m[1].trim()}: ${m[3].trim()}`;
  } else if (isApproval) {
    body = approvalPreview(body);
  }
  const preview = body.length > 150 ? body.slice(0, 147) + '…' : body;
  const label = isApproval
    ? `Approval required${chatLabel ? ` · ${chatLabel}` : ''}`
    : (chatLabel || args.chatId.replace(/^sidekick:/, '').slice(0, 12));

  bannerEl.classList.toggle('iab-approval', isApproval);
  bannerEl.innerHTML = `
    <div class="iab-emoji" aria-hidden="true">${emoji}</div>
    <div class="iab-content">
      <div class="iab-title">${escapeHtml(label)}</div>
      <div class="iab-preview">${escapeHtml(preview)}</div>
      ${isApproval ? `
        <div class="iab-actions" aria-label="Approval actions">
          <button type="button" data-iab-action="approve">Approve</button>
          <button type="button" data-iab-action="approve_session">Session</button>
          <button type="button" data-iab-action="deny">Deny</button>
        </div>` : ''}
    </div>
    <button class="iab-dismiss" aria-label="Dismiss">×</button>
  `;
  bannerEl.classList.add('visible');

  bannerEl.onclick = () => {
    hide();
    if (onOpenCb) onOpenCb(args.chatId, args.sidekickId);
  };
  const dismissBtn = bannerEl.querySelector('.iab-dismiss') as HTMLElement | null;
  if (dismissBtn) {
    dismissBtn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      hide();
    };
  }
  bannerEl.querySelectorAll<HTMLElement>('[data-iab-action]').forEach((btn) => {
    btn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      const action = btn.dataset.iabAction as ApprovalAction | undefined;
      if (!action) return;
      hide();
      void onActionCb?.(args.chatId, action, args.sidekickId);
    };
  });

  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(hide, isApproval ? AUTO_DISMISS_MS * 2 : AUTO_DISMISS_MS);
  log(`[in-app-banner] show chat=${args.chatId} kind=${kind}`);
}

function approvalPreview(raw: string): string {
  const text = stripLeadingMetadata(raw || '');
  const reason = /^Reason:\s*(.+)$/im.exec(text)?.[1]?.trim() || '';
  const lines = text.split('\n');
  const command: string[] = [];
  let inCommand = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/Dangerous command requires approval/i.test(trimmed)) {
      inCommand = true;
      continue;
    }
    if (!inCommand) continue;
    if (!trimmed) {
      if (command.length) command.push('');
      continue;
    }
    if (/^Reason:/i.test(trimmed) || /^Reply\s+\/approve/i.test(trimmed)) break;
    command.push(line.replace(/\s+$/, ''));
  }
  const cmd = command.join('\n').trim().replace(/\n{3,}/g, '\n\n');
  if (reason && cmd) return `${reason}: ${cmd}`;
  return reason || cmd || text;
}

function stripLeadingMetadata(s: string): string {
  const META_LINE_RE = /^\s*(?:session_id|job_id|chat_id|message_id|user_id|run_id|trace_id)\s*:\s*\S/i;
  const SEP_OR_BLANK_RE = /^\s*(?:-{3,}|=+|\*+)?\s*$/;
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length && (META_LINE_RE.test(lines[i]) || SEP_OR_BLANK_RE.test(lines[i]))) i++;
  return lines.slice(i).join('\n');
}

function hide(): void {
  if (!bannerEl) return;
  bannerEl.classList.remove('visible');
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
}

function ensureMounted(): void {
  if (bannerEl) return;
  bannerEl = document.getElementById('in-app-banner');
  if (bannerEl) return;
  bannerEl = document.createElement('div');
  bannerEl.id = 'in-app-banner';
  bannerEl.className = 'in-app-banner';
  bannerEl.setAttribute('role', 'status');
  bannerEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(bannerEl);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
