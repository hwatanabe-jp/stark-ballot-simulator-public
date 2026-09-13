import { describe, expect, it, vi } from 'vitest';
import { snapshotDataTree, snapshotDenseArray, snapshotExactRecord } from './descriptor-snapshot.js';

describe('descriptor snapshots', () => {
  it('captures an exact record from data descriptors without property reads', () => {
    const method = vi.fn(function (this: object) {
      return this;
    });
    let propertyReads = 0;
    const input = new Proxy(
      { method, value: 'captured' },
      {
        get() {
          propertyReads += 1;
          return 'swapped';
        },
      },
    );

    const snapshot = snapshotExactRecord(input, ['method', 'value'], 'test record');

    expect(snapshot).toEqual({ method, value: 'captured' });
    expect(propertyReads).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.apply(snapshot['method'] as (...args: unknown[]) => unknown, snapshot, [])).toBe(snapshot);
  });

  it.each(['accessor', 'hidden', 'symbol'] as const)('rejects a record %s property without invoking it', (shape) => {
    const input: Record<PropertyKey, unknown> = { admitted: 'value' };
    let accessorCalls = 0;
    if (shape === 'accessor') {
      Object.defineProperty(input, 'admitted', {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return 'value';
        },
      });
    } else if (shape === 'hidden') {
      Object.defineProperty(input, 'hidden', { value: 'sentinel', enumerable: false });
    } else {
      Object.defineProperty(input, Symbol('sentinel'), { value: 'sentinel', enumerable: true });
    }

    expect(() => snapshotExactRecord(input, ['admitted'], 'test record')).toThrow(/exact enumerable data shape/u);
    expect(accessorCalls).toBe(0);
  });

  it('captures a dense array from indexed descriptors without indexed property reads', () => {
    let propertyReads = 0;
    const input = new Proxy(['first', 'second'], {
      get() {
        propertyReads += 1;
        return 'swapped';
      },
    });

    const snapshot = snapshotDenseArray(input, 'test array');

    expect(snapshot).toEqual(['first', 'second']);
    expect(propertyReads).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each(['sparse', 'accessor', 'hidden', 'symbol'] as const)(
    'rejects a %s array without invoking indexed accessors',
    (shape) => {
      const input: unknown[] = ['value'];
      let accessorCalls = 0;
      if (shape === 'sparse') {
        input.length = 2;
      } else if (shape === 'accessor') {
        Object.defineProperty(input, '0', {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return 'value';
          },
        });
      } else if (shape === 'hidden') {
        Object.defineProperty(input, 'hidden', { value: 'sentinel', enumerable: false });
      } else {
        Object.defineProperty(input, Symbol('sentinel'), { value: 'sentinel', enumerable: true });
      }

      expect(() => snapshotDenseArray(input, 'test array')).toThrow(/dense indexed data shape/u);
      expect(accessorCalls).toBe(0);
    },
  );

  it('recursively detaches and deeply freezes nested record and array proxies', () => {
    let propertyReads = 0;
    const nested = new Proxy(
      { leaf: 'captured' },
      {
        get() {
          propertyReads += 1;
          return 'swapped';
        },
      },
    );
    const entries = new Proxy([nested], {
      get() {
        propertyReads += 1;
        return 'swapped';
      },
    });
    const input = new Proxy(
      { entries },
      {
        get() {
          propertyReads += 1;
          return 'swapped';
        },
      },
    );

    const snapshot = snapshotDataTree(input, 'test tree') as Readonly<{
      entries: readonly Readonly<{ leaf: string }>[];
    }>;

    expect(snapshot).toEqual({ entries: [{ leaf: 'captured' }] });
    expect(propertyReads).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
  });

  it('detaches Uint8Array bytes reached through a proxied container', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    let propertyReads = 0;
    const input = new Proxy(
      { bytes },
      {
        get() {
          propertyReads += 1;
          return Uint8Array.from([9]);
        },
      },
    );

    const snapshot = snapshotDataTree(input, 'test byte tree') as Readonly<{ bytes: Uint8Array }>;
    bytes[0] = 9;

    expect([...snapshot.bytes]).toEqual([1, 2, 3]);
    expect(snapshot.bytes).not.toBe(bytes);
    expect(propertyReads).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('rejects a proxied Uint8Array rather than reading through its traps', () => {
    let propertyReads = 0;
    const bytes = new Proxy(Uint8Array.from([1, 2, 3]), {
      get() {
        propertyReads += 1;
        return 0;
      },
    });

    expect(() => snapshotDataTree({ bytes }, 'test byte tree')).toThrow(/byte array is invalid/u);
    expect(propertyReads).toBe(0);
  });

  it.each(['accessor', 'hidden', 'symbol'] as const)(
    'rejects a Uint8Array with an extra %s property without invoking it',
    (shape) => {
      const bytes = Uint8Array.from([1]);
      let accessorCalls = 0;
      if (shape === 'accessor') {
        Object.defineProperty(bytes, 'authority', {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return 'sentinel';
          },
        });
      } else if (shape === 'hidden') {
        Object.defineProperty(bytes, 'authority', { value: 'sentinel', enumerable: false });
      } else {
        Object.defineProperty(bytes, Symbol('authority'), { value: 'sentinel', enumerable: true });
      }

      expect(() => snapshotDataTree({ bytes }, 'test byte tree')).toThrow(/byte array is invalid/u);
      expect(accessorCalls).toBe(0);
    },
  );

  it('rejects a detached Uint8Array', () => {
    const bytes = Uint8Array.from([1]);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });

    expect(() => snapshotDataTree({ bytes }, 'test byte tree')).toThrow(/byte array is invalid/u);
  });

  it('rejects nested accessors, cycles, and unsupported objects without invoking accessors', () => {
    let accessorCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'sentinel';
      },
    });
    expect(() => snapshotDataTree({ accessor }, 'test tree')).toThrow(/enumerable data properties/u);
    expect(accessorCalls).toBe(0);

    const cycle: Record<string, unknown> = {};
    cycle['cycle'] = cycle;
    expect(() => snapshotDataTree(cycle, 'test tree')).toThrow(/must not contain a cycle/u);
    expect(() => snapshotDataTree({ date: new Date(0) }, 'test tree')).toThrow(/unsupported object/u);
  });
});
