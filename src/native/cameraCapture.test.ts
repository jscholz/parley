import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cameraPermissionVerdict, base64ToFile, CAMERA_DENIED_MESSAGE } from './cameraCapture.ts';

describe('native/cameraCapture', () => {
  it('maps plugin permission states to a verdict', () => {
    assert.equal(cameraPermissionVerdict({ camera: 'granted' }), 'ok');
    assert.equal(cameraPermissionVerdict({ camera: 'limited' }), 'ok');
    assert.equal(cameraPermissionVerdict({ camera: 'denied' }), 'denied');
    assert.equal(cameraPermissionVerdict({ camera: 'prompt' }), 'ask');
    assert.equal(cameraPermissionVerdict({ camera: 'prompt-with-rationale' }), 'ask');
    assert.equal(cameraPermissionVerdict(null), 'ask');
    assert.equal(cameraPermissionVerdict({}), 'ask');
  });

  it('base64ToFile yields a typed File with the decoded bytes', async () => {
    const f = base64ToFile(btoa('hello'), 'image/jpeg', 'photo-1.jpeg');
    assert.equal(f.type, 'image/jpeg');
    assert.equal(f.name, 'photo-1.jpeg');
    assert.equal(f.size, 5);
    assert.equal(await f.text(), 'hello');
  });

  it('the denied message tells the user where to fix it', () => {
    assert.match(CAMERA_DENIED_MESSAGE, /Settings › Parley › Camera/);
  });
});
