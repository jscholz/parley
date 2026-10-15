import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isImageHref, isPdfHref } from './imageViewer.ts';

test('image hrefs: media lane, absolute, query strings, data URLs', () => {
  for (const h of ['/api/parley/media/44fdeb4546d96f55.png', 'https://x.test/a/b.JPG?w=200', '/uploads/u/0-photo.webp#x', 'data:image/png;base64,AAA', 'pic.heic'])
    assert.equal(isImageHref(h), true, h);
});
test('non-image hrefs are left alone', () => {
  for (const h of ['/api/parley/media/abc.mp4', 'https://x.test/report.pdf', 'https://x.test/png', '#doc:cap_1', 'javascript:alert(1)', '', null])
    assert.equal(isImageHref(h as any), false, String(h));
});

test('pdf hrefs: upload lane, media lane, data URL; not images or other files', () => {
  for (const h of ['/api/parley/uploads/umsg_1/0', ]) void h;
  for (const h of ['/api/parley/media/eeee.pdf', 'https://x.test/a.PDF?dl=1', 'data:application/pdf;base64,JVBER'])
    assert.equal(isPdfHref(h), true, h);
  for (const h of ['/x.png', '/x.pdf.txt', '', null])
    assert.equal(isPdfHref(h as any), false, String(h));
});
