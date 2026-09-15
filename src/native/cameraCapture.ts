/**
 * @fileoverview Native camera capture for the Capacitor shell.
 *
 * Why not the `<input type=file capture>` picker: inside WKWebView that
 * picker is iOS's own UI, and when the app's camera permission is off it
 * opens with a BLACK preview and no error (field 2026-09-13: "camera
 * comes up black but works via the regular Camera app"). The Capacitor
 * Camera plugin asks for permission explicitly and reports denial, so
 * the UI can say what is wrong instead of showing a dark rectangle.
 *
 * The plugin is reached through the Capacitor bridge at runtime (same
 * pattern as notifications/native.ts) — no npm import in the PWA graph.
 * The dependency lives in the iOS app (`@capacitor/camera`, synced by
 * `npx cap sync ios`); when it is missing the caller falls back to the
 * file input.
 */

import { log, diag } from '../util/log.ts';

export type CaptureOutcome =
  | { kind: 'file'; file: File }
  | { kind: 'denied'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; message: string };

export const CAMERA_DENIED_MESSAGE =
  'Camera access is off for Parley — enable it in Settings › Parley › Camera';

function cameraPlugin(): any | null {
  const cap: any = (globalThis as any).Capacitor;
  if (!cap) return null;
  const direct = cap?.Plugins?.Camera;
  if (direct) return direct;
  if (typeof cap.registerPlugin === 'function') {
    try { return cap.registerPlugin('Camera'); } catch { return null; }
  }
  return null;
}

/** Decide from a permission-state map whether the camera is usable.
 *  Pure, so the mapping is unit-testable. `prompt` means "ask", which
 *  the plugin does on the capture call itself. */
export function cameraPermissionVerdict(perms: { camera?: string } | null | undefined): 'ok' | 'denied' | 'ask' {
  const c = perms?.camera;
  if (c === 'granted' || c === 'limited') return 'ok';
  if (c === 'denied') return 'denied';
  return 'ask';
}

/** base64 → File (the plugin returns base64 when asked; a Blob is what
 *  attachments.add() wants). */
export function base64ToFile(b64: string, mime: string, name: string): File {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

export async function captureWithNativeCamera(): Promise<CaptureOutcome> {
  const Camera = cameraPlugin();
  if (!Camera) return { kind: 'unavailable', message: 'Capacitor Camera plugin not registered' };
  try {
    let perms: any = null;
    try { perms = await Camera.checkPermissions(); } catch { /* older plugin — fall through to capture */ }
    let verdict = cameraPermissionVerdict(perms);
    if (verdict === 'ask') {
      try { perms = await Camera.requestPermissions({ permissions: ['camera'] }); } catch { /* capture will prompt */ }
      verdict = cameraPermissionVerdict(perms);
    }
    if (verdict === 'denied') {
      log('camera: permission denied at the OS level');
      return { kind: 'denied', message: CAMERA_DENIED_MESSAGE };
    }
    const photo = await Camera.getPhoto({
      source: 'CAMERA',
      resultType: 'base64',
      quality: 85,
      saveToGallery: false,
      correctOrientation: true,
    });
    if (!photo?.base64String) return { kind: 'cancelled' };
    const fmt = String(photo.format || 'jpeg').toLowerCase();
    const mime = fmt === 'png' ? 'image/png' : fmt === 'heic' ? 'image/heic' : 'image/jpeg';
    const ext = mime.split('/')[1];
    return { kind: 'file', file: base64ToFile(photo.base64String, mime, `photo-${Date.now()}.${ext}`) };
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? '');
    // The plugin rejects with these when the user backs out of the camera.
    if (/cancel/i.test(msg)) return { kind: 'cancelled' };
    if (/denied|permission/i.test(msg)) return { kind: 'denied', message: CAMERA_DENIED_MESSAGE };
    diag(`camera: native capture failed: ${msg}`);
    return { kind: 'unavailable', message: msg || 'native capture failed' };
  }
}
