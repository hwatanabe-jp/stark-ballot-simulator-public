import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertProxyFreePortData, createConditionalObjectLedger } from './conditional-object-ledger.js';

const byteLimits = Object.freeze({ pointerMaxBytes: 64 * 1024, recordMaxBytes: 1024 * 1024 });

describe('conditional object ledger', () => {
  it('rejects oversized dense arrays before enumerating their indexed properties and bounds wide records', () => {
    const dense = Array.from({ length: 65_537 }, () => null);
    const wide = Object.fromEntries(Array.from({ length: 65_537 }, (_, index) => [`field${index}`, null]));
    const ownKeys = vi.spyOn(Reflect, 'ownKeys');
    try {
      expect(() => assertProxyFreePortData(dense, 'dense port data')).toThrow('too large');
      expect(ownKeys.mock.calls.some(([value]) => value === dense)).toBe(false);
      expect(() => assertProxyFreePortData(wide, 'wide port data')).toThrow('too large');
    } finally {
      ownKeys.mockRestore();
    }
  });

  it('rejects byte views before enumerating their indexed properties', () => {
    const bytes = new Uint8Array(65_537);
    const ownKeys = vi.spyOn(Reflect, 'ownKeys');
    try {
      expect(() => assertProxyFreePortData(bytes, 'byte-view port data')).toThrow();
      expect(ownKeys.mock.calls.some(([value]) => value === bytes)).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it('is the one raw conditional publication owner for release, Terraform, and App acceptance domains', () => {
    for (const relativePath of [
      './app-acceptance-publication.js',
      './release-ledger.js',
      './terraform-acceptance-publication.js',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).toContain("from './conditional-object-ledger.js'");
      expect(source).toContain('createConditionalObjectLedger({');
      expect(source).toContain('byteLimits:');
      expect(source).not.toMatch(/transport\.(?:getObject|putObject)/u);
      expect(source).not.toMatch(/\.call\(transport,/u);
    }
  });

  it('publishes immutable bytes create-only and admits only an exact-byte retry', async () => {
    const objects = new Map<string, Readonly<{ body: string; etag: string; versionId: string }>>();
    const ledger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: {
        getObject({ key }: { readonly key: string }) {
          return objects.get(key);
        },
        putObject(input: Readonly<Record<string, unknown>>) {
          const key = input['key'] as string;
          if (objects.has(key)) return { status: 'precondition-failed' };
          const stored = { body: input['body'] as string, etag: '"etag"', versionId: 'object-version' };
          objects.set(key, stored);
          return { status: 'written', etag: stored.etag, versionId: stored.versionId };
        },
      },
    });

    await expect(ledger.publishRecord({ key: 'authority/record.json', body: '{"value":true}\n' })).resolves.toEqual({
      status: 'created',
      observation: { etag: '"etag"', versionId: 'object-version' },
    });
    await expect(ledger.publishRecord({ key: 'authority/record.json', body: '{"value":true}\n' })).resolves.toEqual({
      status: 'idempotent-retry',
      observation: { etag: '"etag"', versionId: 'object-version' },
    });
  });

  it('moves a pointer with both reviewed coordinates and returns bounded conflict state', async () => {
    let current = { body: 'opaque predecessor', etag: '"prior"', versionId: 'prior-object' };
    const puts: Readonly<Record<string, unknown>>[] = [];
    const ledger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: {
        getObject() {
          return current;
        },
        putObject(input: Readonly<Record<string, unknown>>) {
          puts.push(input);
          const condition = input['condition'] as Readonly<Record<string, unknown>>;
          if (condition['etag'] !== current.etag || condition['versionId'] !== current.versionId) {
            return { status: 'precondition-failed' };
          }
          current = { body: input['body'] as string, etag: '"next"', versionId: 'next-object' };
          return { status: 'written', etag: current.etag, versionId: current.versionId };
        },
      },
    });

    await expect(
      ledger.movePointer({
        key: 'authority/current.json',
        body: '{"recordKey":"authority/record.json"}\n',
        expected: { etag: '"prior"', versionId: 'prior-object' },
      }),
    ).resolves.toEqual({ status: 'moved', observation: { etag: '"next"', versionId: 'next-object' } });
    expect(puts.at(0)).toMatchObject({
      condition: { type: 'if-match', etag: '"prior"', versionId: 'prior-object' },
    });
  });

  it('uses one inert receiver and fixed frozen record and pointer read bounds', async () => {
    const receivers: unknown[] = [];
    const requests: Readonly<Record<string, unknown>>[] = [];
    const ledger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: {
        getObject(this: unknown, request: Readonly<Record<string, unknown>>) {
          receivers.push(this);
          requests.push(request);
          return undefined;
        },
        putObject() {
          throw new Error('put must not run');
        },
      },
    });

    await ledger.readRecord({ key: 'authority/record.json' });
    await ledger.readPointer({ key: 'authority/current.json' });

    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toBe(receivers[1]);
    expect(Object.getPrototypeOf(receivers[0])).toBeNull();
    expect(Object.isFrozen(receivers[0])).toBe(true);
    expect(requests).toEqual([
      { key: 'authority/record.json', maxBytes: 1024 * 1024 },
      { key: 'authority/current.json', maxBytes: 64 * 1024 },
    ]);
    expect(requests.every((request) => Object.getPrototypeOf(request) === null && Object.isFrozen(request))).toBe(true);
  });

  it('rejects oversized reads and writes at the fixed boundary', async () => {
    const putObject = vi.fn(() => ({ status: 'written', etag: '"etag"', versionId: 'object-version' }));
    const ledger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: {
        getObject() {
          return { body: 'x'.repeat(64 * 1024 + 1), etag: '"etag"', versionId: 'object-version' };
        },
        putObject,
      },
    });

    await expect(ledger.readPointer({ key: 'authority/current.json' })).rejects.toThrow('empty or oversized');
    await expect(
      ledger.publishRecord({ key: 'authority/record.json', body: 'x'.repeat(1024 * 1024 + 1) }),
    ).rejects.toThrow('empty or oversized');
    expect(putObject).not.toHaveBeenCalled();
  });

  it('admits exact native promises and rejects thenables, subclasses, and proxies without invoking traps', async () => {
    const nativeLedger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: {
        getObject() {
          return Promise.resolve(undefined);
        },
        putObject() {
          return Promise.resolve({ status: 'written', etag: '"etag"', versionId: 'object-version' });
        },
      },
    });
    await expect(
      nativeLedger.publishRecord({ key: 'authority/record.json', body: '{"value":true}\n' }),
    ).resolves.toMatchObject({ status: 'created' });

    let thenCalls = 0;
    const thenable: Record<string, unknown> = { status: 'written', etag: '"etag"', versionId: 'object-version' };
    Object.defineProperty(thenable, 'then', {
      enumerable: true,
      get() {
        thenCalls += 1;
        return undefined;
      },
    });
    const thenableLedger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: { getObject() {}, putObject: () => thenable },
    });
    await expect(
      thenableLedger.publishRecord({ key: 'authority/record.json', body: '{"value":true}\n' }),
    ).rejects.toThrow();
    expect(thenCalls).toBe(0);

    class AlteredPromise<T> extends Promise<T> {}
    const subclassLedger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: {
        getObject() {},
        putObject: () => new AlteredPromise((resolve) => resolve({ status: 'precondition-failed' })),
      },
    });
    await expect(
      subclassLedger.publishRecord({ key: 'authority/record.json', body: '{"value":true}\n' }),
    ).rejects.toThrow(/promise shell/u);

    let promiseThenCalls = 0;
    const alteredShell = Promise.resolve({ status: 'written', etag: '"etag"', versionId: 'object-version' });
    void Object.defineProperty(alteredShell, 'then', {
      configurable: true,
      get() {
        promiseThenCalls += 1;
        return vi.fn();
      },
    });
    const alteredShellLedger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: { getObject() {}, putObject: () => alteredShell },
    });
    await expect(
      alteredShellLedger.publishRecord({ key: 'authority/record.json', body: '{"value":true}\n' }),
    ).rejects.toThrow(/promise shell/u);
    expect(promiseThenCalls).toBe(0);

    let proxyTraps = 0;
    const proxiedResult = new Proxy(
      { status: 'precondition-failed' },
      {
        get() {
          proxyTraps += 1;
          return undefined;
        },
        getOwnPropertyDescriptor() {
          proxyTraps += 1;
          return undefined;
        },
        getPrototypeOf() {
          proxyTraps += 1;
          return null;
        },
        ownKeys() {
          proxyTraps += 1;
          return [];
        },
      },
    );
    const proxyLedger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject: null,
      transport: { getObject() {}, putObject: () => proxiedResult },
    });
    await expect(proxyLedger.publishRecord({ key: 'authority/record.json', body: '{"value":true}\n' })).rejects.toThrow(
      /proxy/u,
    );
    expect(proxyTraps).toBe(0);
  });

  it('rejects direct and nested proxied transport authority without invoking traps', () => {
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() {
        traps += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        return undefined;
      },
      getPrototypeOf() {
        traps += 1;
        return null;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
    };
    const transport = { getObject: () => undefined, putObject: () => undefined };
    expect(() =>
      createConditionalObjectLedger(new Proxy({ byteLimits, coordinateObject: null, transport }, handler)),
    ).toThrow(/proxy/u);
    expect(() =>
      createConditionalObjectLedger({ byteLimits, coordinateObject: null, transport: new Proxy(transport, handler) }),
    ).toThrow(/proxy/u);
    expect(() =>
      createConditionalObjectLedger({
        byteLimits,
        coordinateObject: null,
        transport: { getObject: new Proxy(transport.getObject, handler), putObject: transport.putObject },
      }),
    ).toThrow(/proxy/u);
    expect(traps).toBe(0);
  });

  it('observes pointer coordinates through one exact metadata-only port', async () => {
    const receivers: unknown[] = [];
    const requests: unknown[] = [];
    const coordinateObject = vi.fn(function (this: unknown, request: unknown) {
      receivers.push(this);
      requests.push(request);
      return { etag: '"legacy"', versionId: 'legacy-object' };
    });
    const ledger = createConditionalObjectLedger({
      byteLimits,
      coordinateObject,
      transport: { getObject() {}, putObject() {} },
    });

    await expect(ledger.readPointerCoordinates({ key: 'authority/current.json' })).resolves.toEqual({
      etag: '"legacy"',
      versionId: 'legacy-object',
    });
    expect(requests).toEqual([{ key: 'authority/current.json' }]);
    expect(receivers).toHaveLength(1);
    expect(Object.getPrototypeOf(receivers[0])).toBeNull();
    expect(Object.isFrozen(receivers[0])).toBe(true);
  });
});
