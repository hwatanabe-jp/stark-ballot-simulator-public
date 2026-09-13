import { describe, expect, it } from 'vitest';
import { admitReceiptPayload, normalizeExecutionReceipt } from './receipt-normalizer';

describe('admitReceiptPayload', () => {
  it.each([null, undefined, 'receipt', 1, true, []])('rejects a non-object payload: %j', (value) => {
    expect(() => admitReceiptPayload(value)).toThrow('Receipt payload must be an object');
  });

  it('preserves an admitted opaque object payload', () => {
    const payload = { inner: { Fake: {} } };

    expect(admitReceiptPayload(payload)).toBe(payload);
  });
});

describe('direct receipt seal admission', () => {
  const imageId = `0x${'1'.repeat(64)}`;

  it.each(
    [[256], [-1], ['secret'], [null], [1.75], [Number.NaN], [Number.POSITIVE_INFINITY], Array<unknown>(1)].map(
      (seal) => ({
        seal,
      }),
    ),
  )('rejects malformed byte values instead of changing the receipt: $seal', ({ seal }) => {
    expect(() => normalizeExecutionReceipt({ payload: { seal, journal: 'AA==' } }, imageId)).toThrow(/Receipt bytes/);
  });

  it('preserves all admitted byte values when encoding a direct seal', () => {
    const normalized = normalizeExecutionReceipt(
      { payload: { seal: [0, 1, 127, 128, 255], journal: 'AA==' } },
      imageId,
    );

    expect(normalized.receipt.seal).toBe('AAF/gP8=');
  });
});

describe('composite receipt seal admission', () => {
  const imageId = `0x${'1'.repeat(64)}`;

  it.each(
    [
      [-1],
      [1.75],
      [0x1_0000_0000],
      ['1'],
      [null],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      Array<unknown>(1),
      [[0, [-1]]],
    ].map((seal) => ({ seal })),
  )('rejects malformed words instead of changing the receipt: $seal', ({ seal }) => {
    expect(() =>
      normalizeExecutionReceipt(
        { payload: { inner: { Composite: { segments: [{ seal }] } }, journal: { bytes: [0] } } },
        imageId,
      ),
    ).toThrow(/Receipt seal/);
  });

  it('preserves nested u32 words in order with little-endian encoding', () => {
    const normalized = normalizeExecutionReceipt(
      {
        payload: {
          inner: { Composite: { segments: [{ seal: [0, [1, [0x7fffffff, 0x80000000]], 0xffffffff] }] } },
          journal: { bytes: [0] },
        },
      },
      imageId,
    );

    expect(normalized.receipt.seal).toBe('AAAAAAEAAAD///9/AAAAgP////8=');
  });
});
