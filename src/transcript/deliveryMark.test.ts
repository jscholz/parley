import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { deliveryMark } from './reconciler.ts';

test('deliveryMark: states and precedence', () => {
  assert.equal(deliveryMark({ delivery: 'pending' })?.state, 'pending');
  assert.equal(deliveryMark({ delivery: 'sent' })?.glyph, '✓');
  assert.equal(deliveryMark({ delivery: 'delivered' })?.glyph, '✓✓');
  assert.equal(deliveryMark({ delivery: 'delivered', ack: 'processing' })?.state, 'seen');
  assert.equal(deliveryMark({ delivery: 'delivered', ack: 'success' })?.state, 'seen');
  assert.equal(deliveryMark({ delivery: 'delivered', ack: 'failure' })?.glyph, '✗');
  assert.equal(deliveryMark({ delivery: 'delivered', ack: 'cancelled' })?.state, 'cancelled');
  assert.equal(deliveryMark({ delivery: 'pending', failed: true })?.state, 'failed');
  assert.equal(deliveryMark({}), null);                     // nothing known (legacy rows without delivery)
});
