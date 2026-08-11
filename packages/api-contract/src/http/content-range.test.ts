import { describe, expect, it } from 'vitest';
import { parseContentRange } from './content-range';

describe('parseContentRange', () => {
  it('parses the current satisfied byte-range grammar and advertises its length', () => {
    expect(parseContentRange('bytes 4-7/10')).toEqual({
      kind: 'satisfied',
      unit: 'bytes',
      start: 4,
      end: 7,
      total: 10,
      advertisedLength: 4,
    });
    expect(parseContentRange('bytes 000-003/010')).toEqual({
      kind: 'satisfied',
      unit: 'bytes',
      start: 0,
      end: 3,
      total: 10,
      advertisedLength: 4,
    });
  });

  it('parses the unsatisfied byte-range grammar produced by the bundle endpoint', () => {
    expect(parseContentRange('bytes */0')).toEqual({
      kind: 'unsatisfied',
      unit: 'bytes',
      total: 0,
    });
    expect(parseContentRange('bytes */1024')).toEqual({
      kind: 'unsatisfied',
      unit: 'bytes',
      total: 1024,
    });
  });

  it.each([
    null,
    '',
    'Bytes 0-3/10',
    'bytes  0-3/10',
    'bytes 0 -3/10',
    'bytes 0-3 /10',
    'bytes=0-3/10',
    'items 0-3/10',
    'bytes -1-3/10',
    'bytes 0-3/*',
    'bytes */*',
    'bytes */-1',
    'bytes 0.0-3/10',
    'bytes 0-3/10.0',
    'bytes 0-3/10 ',
  ])('rejects values outside the exact current grammar: %s', (value) => {
    expect(parseContentRange(value)).toBeNull();
  });

  it.each([
    'bytes 4-3/10',
    'bytes 0-10/10',
    'bytes 0-0/0',
    `bytes 0-0/${Number.MAX_SAFE_INTEGER + 1}`,
    `bytes */${Number.MAX_SAFE_INTEGER + 1}`,
  ])('rejects unsafe or invalid numeric relationships: %s', (value) => {
    expect(parseContentRange(value)).toBeNull();
  });

  it('accepts safe integer boundaries', () => {
    expect(parseContentRange(`bytes 0-0/${Number.MAX_SAFE_INTEGER}`)).toEqual({
      kind: 'satisfied',
      unit: 'bytes',
      start: 0,
      end: 0,
      total: Number.MAX_SAFE_INTEGER,
      advertisedLength: 1,
    });
    expect(parseContentRange(`bytes */${Number.MAX_SAFE_INTEGER}`)).toEqual({
      kind: 'unsatisfied',
      unit: 'bytes',
      total: Number.MAX_SAFE_INTEGER,
    });
  });
});
