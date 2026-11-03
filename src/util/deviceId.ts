/**
 * @fileoverview One stable id per browser profile, so cross-device sync
 * modules (docs shelf, composer drafts) can tell their own writes from
 * another device's. Minted once, kept in localStorage; a storage-less
 * context gets a per-page id, which only costs it the "was that me?"
 * shortcut.
 */
const DEVICE_KEY = 'parley.deviceId';
let deviceId = '';

export function ensureDeviceId(): string {
  if (deviceId) return deviceId;
  try {
    deviceId = localStorage.getItem(DEVICE_KEY) || '';
    if (!deviceId) {
      deviceId = `dev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      localStorage.setItem(DEVICE_KEY, deviceId);
    }
  } catch { deviceId = deviceId || `dev_${Date.now().toString(36)}`; }
  return deviceId;
}
