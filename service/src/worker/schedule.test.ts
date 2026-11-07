// nextDelayMs (full batch -> at once, else the poll interval) is covered through the loop in worker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DELAY_CONFIG, errorDelayMs } from './schedule.js';

test('errorDelayMs: separate exponential back-off, capped at errorMaxMs', () => {
  const c = { ...DEFAULT_DELAY_CONFIG, errorBaseMs: 5_000, errorMaxMs: 120_000 };
  assert.deepEqual([1, 2, 3].map((n) => errorDelayMs(n, c)), [5_000, 10_000, 20_000]);
  assert.equal(errorDelayMs(20, c), 120_000);
  assert.equal(errorDelayMs(1000, c), 120_000, 'no overflow');
});
