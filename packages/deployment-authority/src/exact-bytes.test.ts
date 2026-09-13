import { describe, expect, it } from 'vitest';
import { snapshotBoundedBytes } from './exact-bytes.js';

describe('bounded exact byte snapshots', () => {
  it.each(['Buffer', 'Uint8Array'] as const)(
    'rejects a genuine %s with a proxied prototype without invoking traps',
    (kind) => {
      const bytes = kind === 'Buffer' ? Buffer.from([1, 2, 3]) : Uint8Array.from([1, 2, 3]);
      const originalPrototype = Reflect.getPrototypeOf(bytes);
      if (originalPrototype === null) {
        throw new Error('Byte fixture prototype is missing.');
      }
      let trapCalls = 0;
      const hostilePrototype = new Proxy(originalPrototype, {
        get() {
          trapCalls += 1;
          throw new Error('prototype property trap must stay inert');
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error('prototype traversal trap must stay inert');
        },
      });
      Reflect.setPrototypeOf(bytes, hostilePrototype);

      expect(() => snapshotBoundedBytes(bytes, { label: 'fixture bytes', maxBytes: 16 })).toThrow(
        /exact byte-array shell/u,
      );
      expect(trapCalls).toBe(0);
    },
  );

  it.each([
    ['Buffer', () => Buffer.from([1, 2, 3])],
    ['Uint8Array', () => Uint8Array.from([1, 2, 3])],
  ] as const)('detaches admitted %s bytes', (_kind, createBytes) => {
    const bytes = createBytes();
    const snapshot = snapshotBoundedBytes(bytes, { label: 'fixture bytes', maxBytes: 16 });
    bytes[0] = 9;

    expect([...snapshot]).toEqual([1, 2, 3]);
  });
});
