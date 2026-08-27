/**
 * Voice coordination layer — extracted from main.ts boot() (behavior-
 * preserving). Owns only the cross-mode coordination: which voice path is
 * active, how to stop whichever one is, how the mic gesture dispatches to a
 * mode, and the release-all cleanup. The individual mode lifecycles
 * (memo / dictate / listen / webrtc) and the pointer-gesture state machine
 * stay in boot() and are injected here as start/stop callbacks.
 *
 * The active-state flags (memoActive / dictateActive / listenActive) remain
 * boot-scope locals because many sites outside voice coordination mutate
 * them; they're read here via live getters and (for memoActive, which
 * releaseCaptureIfActive clears) written via a setter, so this controller
 * never holds a stale copy.
 */

export interface VoiceControllerDeps {
  // Live accessors for boot-scope voice-state flags.
  getMemoActive: () => boolean;
  setMemoActive: (v: boolean) => void;
  getDictateActive: () => boolean;
  getListenActive: () => boolean;

  // Sub-controller module singletons (structural shapes, injected so this
  // module stays decoupled from main's import graph).
  webrtcControls: { isOpen(): boolean; closeIfOpen(source?: string): unknown };
  webrtcDictate: { isActive(): boolean; stop(): unknown };
  memo: { cancel(): void };
  capture: { hasActive(): boolean; currentOwner(): string | null; release(): void };

  // Mode lifecycle fns + DOM refs (stay in boot, injected).
  composerSend: HTMLButtonElement;
  stopDictate: () => Promise<void>;
  stopCallStream: () => Promise<void>;
  stopListen: () => void;
  startDictate: (initialCursor: number | null) => Promise<void>;
  startMemo: (autoSend: boolean) => Promise<void>;
  log: (...args: unknown[]) => void;
}

export interface VoiceController {
  /** Whether some voice path is currently active. */
  voiceActive(): boolean;
  /** Stop whichever voice path is active. Idempotent. */
  stopVoice(): Promise<void>;
  /** Mic-button dispatch: tap → dictate, hold → PTT memo. */
  startMicMode(gesture: 'tap' | 'hold', initialCursor?: number | null): Promise<void>;
  /** Release-all coordinator: closes call + tears down in-progress memo/dictate. */
  releaseCaptureIfActive(): void;
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const {
    getMemoActive, setMemoActive, getDictateActive, getListenActive,
    webrtcControls, webrtcDictate, memo, capture,
    composerSend, stopDictate, stopCallStream, stopListen,
    startDictate, startMemo, log,
  } = deps;

  function voiceActive(): boolean {
    return getMemoActive() || getDictateActive() || webrtcControls.isOpen() || getListenActive();
  }

  async function stopVoice(): Promise<void> {
    if (getMemoActive()) {
      // Mid-memo stop fires send (release-to-send PTT semantics) by
      // clicking the composer-send. If the user wants to discard, they
      // hit the trash button or Esc.
      composerSend.click();
      return;
    }
    if (getDictateActive()) {
      await stopDictate();
      return;
    }
    if (webrtcControls.isOpen()) {
      await stopCallStream();
      return;
    }
    if (getListenActive()) {
      stopListen();
      return;
    }
  }

  async function startMicMode(
    gesture: 'tap' | 'hold',
    initialCursor: number | null = null,
  ): Promise<void> {
    if (gesture === 'tap') {
      await startDictate(initialCursor);
    } else {
      // PTT memo always sends on release (autoSend=true). Discard via
      // the drag-off-bar gesture handler in the pointerup classifier.
      await startMemo(true);
    }
  }

  function releaseCaptureIfActive(): void {
    if (webrtcControls.isOpen()) void webrtcControls.closeIfOpen('release-capture');
    if (webrtcDictate.isActive()) void webrtcDictate.stop();
    if (getMemoActive()) {
      memo.cancel();
      const bar = document.querySelector('.memo-bar');
      if (bar) bar.remove();
      setMemoActive(false);
      log('[mic-diag] memoActive=false (releaseCaptureIfActive)');
      // Textarea + btnMic stay visible during memo (bottom-row-only
      // memo bar UX), so no display:'' to reset here. Restore the
      // composer-actions row in case it was hidden during memo.
      const composerEl3 = document.querySelector('.composer') as HTMLElement | null;
      const actionsEl = composerEl3?.querySelector('.composer-actions') as HTMLElement | null;
      if (actionsEl) actionsEl.style.display = '';
    }
    // Don't tear down Listen's mic here — Listen owns the capture
    // across commit + reply + re-arm, by design. releaseCaptureIfActive
    // fires from sendTypedMessage to clean up memo/dictate/webrtc
    // captures the user might have started; pulling Listen's mic out
    // mid-turn breaks the post-reply cooldown→armed transition
    // (armRecorder rebuilds against a torn-down stream → teardown →
    // idle, and the user is stranded after one turn).
    if (capture.hasActive() && capture.currentOwner() !== 'listen') {
      capture.release();
    }
  }

  return { voiceActive, stopVoice, startMicMode, releaseCaptureIfActive };
}
