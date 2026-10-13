import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isImageHref } from './imageViewer.ts';

test('image hrefs: media lane, absolute, query strings, data URLs', () => {
  for (const h of ['/api/parley/media/44fdeb4546d96f55.png', 'https://x.test/a/b.JPG?w=200', '/uploads/u/0-photo.webp#x', 'data:image/png;base64,AAA', 'pic.heic'])
    assert.equal(isImageHref(h), true, h);
});
test('non-image hrefs are left alone', () => {
  for (const h of ['/api/parley/media/abc.mp4', 'https://x.test/report.pdf', 'https://x.test/png', '#doc:cap_1', 'javascript:alert(1)', '', null])
    assert.equal(isImageHref(h as any), false, String(h));
});
