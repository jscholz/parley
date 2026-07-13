// Persisted chat_id → { sessionId, cwd } map.
//
// The Agent SDK scopes session lookup/resume to the working directory:
// resuming with a mismatched cwd silently creates a FRESH session
// (claude-agent-sdk-python#555, claude-code#4926), so the unit of
// identity here is the PAIR {sessionId, cwd}, never sessionId alone.
// And it must persist across restarts — the precedent wrapper lost
// sessions on restart via an in-memory TTL map (research doc §1).
//
// Storage: a single JSON file, rewritten atomically-enough (tmp+rename)
// on every mutation. Volume is tiny (one row per chat). Pass
// persistPath: null for a pure in-memory map (tests).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionEntry {
  sessionId: string | null; // null = chat created, first turn not run yet
  cwd: string;
  title?: string;
  createdAt: number; // epoch ms
}

interface PersistShape {
  version: 1;
  chats: Record<string, SessionEntry>;
}

export class SessionMap {
  private chats = new Map<string, SessionEntry>();
  private persistPath: string | null;

  constructor(persistPath: string | null) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistPath, 'utf8');
    } catch {
      return; // first run — nothing persisted yet
    }
    try {
      const parsed = JSON.parse(raw) as PersistShape;
      if (parsed && parsed.chats && typeof parsed.chats === 'object') {
        for (const [chatId, entry] of Object.entries(parsed.chats)) {
          if (entry && typeof entry.cwd === 'string') this.chats.set(chatId, entry);
        }
      }
    } catch (e) {
      // Corrupt map ≠ lost sessions: the JSONL transcripts under
      // ~/.claude/projects are the source of truth; worst case chats
      // re-associate via the cc:<sessionId> drawer ids. Log and start
      // empty rather than crash the backend.
      console.warn(`[claude-code] session map unreadable (${(e as Error)?.message}); starting empty`);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    const shape: PersistShape = { version: 1, chats: Object.fromEntries(this.chats) };
    const tmp = `${this.persistPath}.tmp`;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(shape, null, 2));
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.warn(`[claude-code] session map save failed: ${(e as Error)?.message}`);
    }
  }

  get(chatId: string): SessionEntry | undefined {
    return this.chats.get(chatId);
  }

  /** Find the chat that owns a session id (reverse lookup for drawer
   *  rows synthesized from listSessions). */
  chatIdForSession(sessionId: string): string | undefined {
    for (const [chatId, entry] of this.chats) {
      if (entry.sessionId === sessionId) return chatId;
    }
    return undefined;
  }

  ensure(chatId: string, cwd: string, now: number): SessionEntry {
    let entry = this.chats.get(chatId);
    if (!entry) {
      entry = { sessionId: null, cwd, createdAt: now };
      this.chats.set(chatId, entry);
      this.save();
    }
    return entry;
  }

  setSession(chatId: string, sessionId: string): void {
    const entry = this.chats.get(chatId);
    if (!entry || entry.sessionId === sessionId) return;
    entry.sessionId = sessionId;
    this.save();
  }

  setTitle(chatId: string, title: string): void {
    const entry = this.chats.get(chatId);
    if (!entry) return;
    entry.title = title;
    this.save();
  }

  delete(chatId: string): SessionEntry | undefined {
    const entry = this.chats.get(chatId);
    if (entry) {
      this.chats.delete(chatId);
      this.save();
    }
    return entry;
  }

  entries(): Array<[string, SessionEntry]> {
    return [...this.chats.entries()];
  }
}
