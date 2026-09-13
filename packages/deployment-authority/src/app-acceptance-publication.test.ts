import { describe, expect, it } from 'vitest';

import {
  APP_ACCEPTANCE_KIND,
  APP_CURRENT_ACCEPTANCE_POINTER_KIND,
  deriveAppAcceptanceRecordKey,
  projectAppAcceptancePointerTransition,
  projectInitialAppAcceptancePointer,
} from './app-acceptance-ledger.js';
import { createAppAcceptanceLedger } from './app-acceptance-publication.js';
import { canonicalRecordJson, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  createAppAcceptanceFixture,
  createAppAcceptanceProviderLockFixture,
} from './testdata/app-acceptance-ledger-fixture.js';

type StoredObject = Readonly<{ body: string; etag: string; versionId: string }>;

class ConditionalMemoryTransport {
  readonly objects = new Map<string, StoredObject>();
  readonly gets: Readonly<Record<string, unknown>>[] = [];
  readonly puts: Readonly<Record<string, unknown>>[] = [];
  private writeCount = 0;

  getObject(input: Readonly<Record<string, unknown>>) {
    this.gets.push(input);
    return this.objects.get(input['key'] as string);
  }

  putObject(input: Readonly<Record<string, unknown>>) {
    this.puts.push(input);
    const key = input['key'] as string;
    const body = input['body'] as string;
    const condition = input['condition'] as Readonly<Record<string, unknown>>;
    const current = this.objects.get(key);
    const admitted =
      (condition['type'] === 'if-none-match' && current === undefined) ||
      (condition['type'] === 'if-match' &&
        current !== undefined &&
        current.etag === condition['etag'] &&
        current.versionId === condition['versionId']);
    if (!admitted) return { status: 'precondition-failed' } as const;
    return { status: 'written' as const, ...this.forceWrite(key, body) };
  }

  forceWrite(key: string, body: string) {
    this.writeCount += 1;
    const written = {
      body,
      etag: `"etag-${this.writeCount}"`,
      versionId: `version-${this.writeCount}`,
    } as const;
    this.objects.set(key, written);
    return { etag: written.etag, versionId: written.versionId } as const;
  }
}

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const app = resolveDeploymentLaneAuthority(target, 'app');
const pointerKey = app.names.acceptedDeploymentPointerKey;

function createLedger(transport: ConditionalMemoryTransport) {
  return createAppAcceptanceLedger(
    {
      getObject: (input: Readonly<Record<string, unknown>>) => transport.getObject(input),
      putObject: (input: Readonly<Record<string, unknown>>) => transport.putObject(input),
    },
    'stark-dev/develop',
  );
}

function createRetainedRecord(
  acceptedAt = '2026-08-14T01:04:06.000Z',
  awsProviderVersion: '6.58.0' | '6.57.1' = '6.57.1',
) {
  const record = structuredClone(createAppAcceptanceFixture({ acceptedAt })) as Record<string, unknown>;
  record['provider'] = {
    ...(record['provider'] as Readonly<Record<string, unknown>>),
    lock: createAppAcceptanceProviderLockFixture(awsProviderVersion),
    selections: { 'registry.terraform.io/hashicorp/aws': awsProviderVersion },
    terraformVersion: '1.15.5',
  };
  return record;
}

function seedHistory(transport: ConditionalMemoryTransport) {
  const currentRecord = createAppAcceptanceFixture();
  const retainedRecord = createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:06.000Z' });
  const currentKey = deriveAppAcceptanceRecordKey(currentRecord, 'stark-dev/develop');
  const retainedKey = deriveAppAcceptanceRecordKey(retainedRecord, 'stark-dev/develop');
  transport.forceWrite(currentKey, canonicalRecordJson(currentRecord));
  transport.forceWrite(retainedKey, canonicalRecordJson(retainedRecord));
  const pointer = projectInitialAppAcceptancePointer(
    {
      history: [currentKey, retainedKey],
      predecessor: { etag: '"legacy"', versionId: 'legacy-version' },
    },
    'stark-dev/develop',
  );
  const pointerObservation = transport.forceWrite(pointerKey, canonicalRecordJson(pointer));
  return { currentKey, currentRecord, pointer, pointerObservation, retainedKey, retainedRecord };
}

describe('App acceptance conditional publication ledger', () => {
  it('preflights and create-only publishes one canonical App acceptance', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const record = createAppAcceptanceFixture();
    const key = deriveAppAcceptanceRecordKey(record, 'stark-dev/develop');

    await expect(ledger.preflightRecordPublication(APP_ACCEPTANCE_KIND, record)).resolves.toEqual({
      kind: APP_ACCEPTANCE_KIND,
      key,
      record,
    });
    await expect(ledger.publishRecord(APP_ACCEPTANCE_KIND, record)).resolves.toMatchObject({
      kind: APP_ACCEPTANCE_KIND,
      key,
      record,
      status: 'created',
    });
    expect(transport.puts).toEqual([{ key, body: canonicalRecordJson(record), condition: { type: 'if-none-match' } }]);
  });

  it('admits an exact-byte retry and rejects a different body at the derived key', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const record = createAppAcceptanceFixture();
    const key = deriveAppAcceptanceRecordKey(record, 'stark-dev/develop');
    transport.forceWrite(key, canonicalRecordJson(record));

    await expect(ledger.publishRecord(APP_ACCEPTANCE_KIND, record)).resolves.toMatchObject({
      status: 'idempotent-retry',
      key,
    });
    const stored = transport.objects.get(key);
    if (stored === undefined) throw new Error('Expected the seeded App acceptance record.');
    transport.objects.set(key, { ...stored, body: '{}\n' });
    await expect(ledger.publishRecord(APP_ACCEPTANCE_KIND, record)).rejects.toThrow(/conflicts with different bytes/u);
  });

  it.each(['6.58.0', '6.57.1'] as const)(
    'create-only publishes and reads an exact retained-provider acceptance at AWS %s',
    async (awsProviderVersion) => {
      const transport = new ConditionalMemoryTransport();
      const ledger = createLedger(transport);
      const record = createRetainedRecord('2026-08-14T01:04:06.000Z', awsProviderVersion);
      const key = deriveAppAcceptanceRecordKey(record, 'stark-dev/develop');

      await expect(ledger.publishRecord(APP_ACCEPTANCE_KIND, record)).resolves.toMatchObject({
        key,
        record,
        status: 'created',
      });
      await expect(ledger.readRecord(key)).resolves.toMatchObject({ recordKey: key, record });
    },
  );

  it('resolves the complete bounded target history in pointer order', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);

    await expect(ledger.resolveCurrentHistory(pointerKey)).resolves.toEqual({
      pointerKey,
      pointer: fixture.pointer,
      pointerObservation: fixture.pointerObservation,
      records: [
        expect.objectContaining({ recordKey: fixture.currentKey, record: fixture.currentRecord }),
        expect.objectContaining({ recordKey: fixture.retainedKey, record: fixture.retainedRecord }),
      ],
    });
    expect(transport.gets.map((input) => input['key'])).toEqual([pointerKey, fixture.currentKey, fixture.retainedKey]);
  });

  it('admits an older provider only in retained history, never as the current head', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const currentRecord = createAppAcceptanceFixture();
    const retainedRecord = createRetainedRecord();
    const currentKey = deriveAppAcceptanceRecordKey(currentRecord, 'stark-dev/develop');
    const retainedKey = deriveAppAcceptanceRecordKey(retainedRecord, 'stark-dev/develop');
    transport.forceWrite(currentKey, canonicalRecordJson(currentRecord));
    transport.forceWrite(retainedKey, canonicalRecordJson(retainedRecord));

    const validPointer = projectInitialAppAcceptancePointer(
      {
        history: [currentKey, retainedKey],
        predecessor: { etag: '"legacy"', versionId: 'legacy-version' },
      },
      'stark-dev/develop',
    );
    transport.forceWrite(pointerKey, canonicalRecordJson(validPointer));
    await expect(ledger.resolveCurrentHistory(pointerKey)).resolves.toMatchObject({
      pointer: validPointer,
      records: [{ recordKey: currentKey }, { recordKey: retainedKey }],
    });

    const invalidPointer = projectInitialAppAcceptancePointer(
      {
        history: [retainedKey, currentKey],
        predecessor: { etag: '"legacy"', versionId: 'legacy-version' },
      },
      'stark-dev/develop',
    );
    transport.forceWrite(pointerKey, canonicalRecordJson(invalidPointer));
    await expect(ledger.resolveCurrentHistory(pointerKey)).rejects.toThrow(/Terraform runtime/iu);
  });

  it('moves only the exact generation-incremented prepend transition by ETag and VersionId CAS', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);
    const nextRecord = createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:07.000Z' });
    const nextKey = deriveAppAcceptanceRecordKey(nextRecord, 'stark-dev/develop');
    transport.forceWrite(nextKey, canonicalRecordJson(nextRecord));
    const pointer = projectAppAcceptancePointerTransition(
      {
        currentPointer: fixture.pointer,
        currentPointerObservation: fixture.pointerObservation,
        nextRecordKey: nextKey,
      },
      'stark-dev/develop',
    );

    await expect(
      ledger.movePointer({
        currentPointer: fixture.pointer,
        kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        pointer,
        expected: fixture.pointerObservation,
      }),
    ).resolves.toMatchObject({ status: 'moved', pointerKey, pointer });
    expect(pointer.generation).toBe(2);
    expect(transport.puts.at(-1)).toEqual({
      key: pointerKey,
      body: canonicalRecordJson(pointer),
      condition: { type: 'if-match', ...fixture.pointerObservation },
    });
  });

  it('rejects an older-provider proposed head before pointer transport', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);
    const nextRecord = createRetainedRecord('2026-08-14T01:04:07.000Z');
    const nextKey = deriveAppAcceptanceRecordKey(nextRecord, 'stark-dev/develop');
    transport.forceWrite(nextKey, canonicalRecordJson(nextRecord));
    const pointer = projectAppAcceptancePointerTransition(
      {
        currentPointer: fixture.pointer,
        currentPointerObservation: fixture.pointerObservation,
        nextRecordKey: nextKey,
      },
      'stark-dev/develop',
    );
    const putCount = transport.puts.length;

    await expect(
      ledger.movePointer({
        currentPointer: fixture.pointer,
        kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        pointer,
        expected: fixture.pointerObservation,
      }),
    ).rejects.toThrow(/Terraform runtime/iu);
    expect(transport.puts).toHaveLength(putCount);
  });

  it('rejects moving away from an older-provider current head before pointer transport', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const retainedRecord = createRetainedRecord();
    const retainedKey = deriveAppAcceptanceRecordKey(retainedRecord, 'stark-dev/develop');
    const priorRecord = createAppAcceptanceFixture();
    const priorKey = deriveAppAcceptanceRecordKey(priorRecord, 'stark-dev/develop');
    transport.forceWrite(retainedKey, canonicalRecordJson(retainedRecord));
    transport.forceWrite(priorKey, canonicalRecordJson(priorRecord));
    const currentPointer = projectInitialAppAcceptancePointer(
      {
        history: [retainedKey, priorKey],
        predecessor: { etag: '"legacy"', versionId: 'legacy-version' },
      },
      'stark-dev/develop',
    );
    const currentPointerObservation = transport.forceWrite(pointerKey, canonicalRecordJson(currentPointer));
    const nextRecord = createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:07.000Z' });
    const nextKey = deriveAppAcceptanceRecordKey(nextRecord, 'stark-dev/develop');
    transport.forceWrite(nextKey, canonicalRecordJson(nextRecord));
    const pointer = projectAppAcceptancePointerTransition(
      {
        currentPointer,
        currentPointerObservation,
        nextRecordKey: nextKey,
      },
      'stark-dev/develop',
    );
    const putCount = transport.puts.length;

    await expect(
      ledger.movePointer({
        currentPointer,
        kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        pointer,
        expected: currentPointerObservation,
      }),
    ).rejects.toThrow(/Terraform runtime/iu);
    expect(transport.puts).toHaveLength(putCount);
  });

  it('classifies an exact replay after a successful pointer move as idempotent without another write', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);
    const nextRecord = createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:07.000Z' });
    const nextKey = deriveAppAcceptanceRecordKey(nextRecord, 'stark-dev/develop');
    transport.forceWrite(nextKey, canonicalRecordJson(nextRecord));
    const pointer = projectAppAcceptancePointerTransition(
      {
        currentPointer: fixture.pointer,
        currentPointerObservation: fixture.pointerObservation,
        nextRecordKey: nextKey,
      },
      'stark-dev/develop',
    );
    const request = {
      currentPointer: fixture.pointer,
      kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
      pointerKey,
      pointer,
      expected: fixture.pointerObservation,
    } as const;

    const first = await ledger.movePointer(request);
    expect(first).toMatchObject({ status: 'moved', pointerKey, pointer });
    if (first.status !== 'moved') throw new Error('Expected the first pointer movement to succeed.');
    const putCountAfterMove = transport.puts.length;
    await expect(ledger.movePointer(request)).resolves.toEqual({
      status: 'idempotent-retry',
      pointerKey,
      pointer,
      pointerObservation: first.pointerObservation,
    });
    expect(transport.puts).toHaveLength(putCountAfterMove);
  });

  it('rejects a detached generation, history, or predecessor before a pointer write', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);
    const nextRecord = createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:07.000Z' });
    const nextKey = deriveAppAcceptanceRecordKey(nextRecord, 'stark-dev/develop');
    transport.forceWrite(nextKey, canonicalRecordJson(nextRecord));
    const pointer = projectAppAcceptancePointerTransition(
      {
        currentPointer: fixture.pointer,
        currentPointerObservation: fixture.pointerObservation,
        nextRecordKey: nextKey,
      },
      'stark-dev/develop',
    );
    const initialPutCount = transport.puts.length;

    await expect(
      ledger.movePointer({
        currentPointer: fixture.pointer,
        kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        pointer: { ...pointer, generation: 3 },
        expected: fixture.pointerObservation,
      }),
    ).rejects.toThrow(/pointer|generation|evidence/iu);
    expect(transport.puts).toHaveLength(initialPutCount);
  });

  it('rejects a missing or key-detached head record before a pointer write', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);
    const nextRecord = createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:07.000Z' });
    const nextKey = deriveAppAcceptanceRecordKey(nextRecord, 'stark-dev/develop');
    const pointer = projectAppAcceptancePointerTransition(
      {
        currentPointer: fixture.pointer,
        currentPointerObservation: fixture.pointerObservation,
        nextRecordKey: nextKey,
      },
      'stark-dev/develop',
    );
    const request = {
      currentPointer: fixture.pointer,
      kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
      pointerKey,
      pointer,
      expected: fixture.pointerObservation,
    } as const;
    const initialPutCount = transport.puts.length;

    await expect(ledger.movePointer(request)).rejects.toThrow(/does not exist/u);
    expect(transport.puts).toHaveLength(initialPutCount);

    transport.forceWrite(nextKey, canonicalRecordJson(fixture.currentRecord));
    const putCountAfterDetachedSeed = transport.puts.length;
    await expect(ledger.movePointer(request)).rejects.toThrow(/does not match its derived key/u);
    expect(transport.puts).toHaveLength(putCountAfterDetachedSeed);
  });

  it('rejects proxy and accessor request shells without invoking traps or getters', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);
    let trapCount = 0;
    const handler: ProxyHandler<object> = {
      get() {
        trapCount += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        trapCount += 1;
        return undefined;
      },
      getPrototypeOf() {
        trapCount += 1;
        return null;
      },
      ownKeys() {
        trapCount += 1;
        return [];
      },
    };
    const proxiedPointer = new Proxy(fixture.pointer, handler);
    await expect(
      ledger.movePointer({
        currentPointer: proxiedPointer,
        kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        pointer: fixture.pointer,
        expected: fixture.pointerObservation,
      }),
    ).rejects.toThrow(/proxy/u);
    expect(trapCount).toBe(0);

    let getterCount = 0;
    const accessorRequest = {
      kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
      pointerKey,
      pointer: fixture.pointer,
      expected: fixture.pointerObservation,
    };
    Object.defineProperty(accessorRequest, 'currentPointer', {
      enumerable: true,
      get() {
        getterCount += 1;
        return fixture.pointer;
      },
    });
    await expect(ledger.movePointer(accessorRequest)).rejects.toThrow(/exact current shape/u);
    expect(getterCount).toBe(0);
  });

  it('returns only an admitted target pointer on a stale CAS conflict', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const fixture = seedHistory(transport);
    const nextRecord = createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:07.000Z' });
    const nextKey = deriveAppAcceptanceRecordKey(nextRecord, 'stark-dev/develop');
    transport.forceWrite(nextKey, canonicalRecordJson(nextRecord));
    const pointer = projectAppAcceptancePointerTransition(
      {
        currentPointer: fixture.pointer,
        currentPointerObservation: fixture.pointerObservation,
        nextRecordKey: nextKey,
      },
      'stark-dev/develop',
    );
    const intervening = projectAppAcceptancePointerTransition(
      {
        currentPointer: fixture.pointer,
        currentPointerObservation: fixture.pointerObservation,
        nextRecordKey: fixture.retainedKey,
      },
      'stark-dev/develop',
    );
    const interveningObservation = transport.forceWrite(pointerKey, canonicalRecordJson(intervening));

    await expect(
      ledger.movePointer({
        currentPointer: fixture.pointer,
        kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
        pointerKey,
        pointer,
        expected: fixture.pointerObservation,
      }),
    ).resolves.toEqual({
      status: 'conflict',
      pointerKey,
      expected: fixture.pointerObservation,
      observed: { pointer: intervening, pointerObservation: interveningObservation },
    });
  });

  it('does not expose malformed transport bytes through a parser error cause', async () => {
    const transport = new ConditionalMemoryTransport();
    const ledger = createLedger(transport);
    const sentinel = 'TOP_SECRET_TRANSPORT_BYTES';
    transport.forceWrite(pointerKey, `{"secret":${sentinel}}\n`);

    const caught: unknown = await ledger.resolveCurrentHistory(pointerKey).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error('Expected canonical pointer admission to fail.');
    expect(String(caught)).not.toContain(sentinel);
    expect(Object.getOwnPropertyDescriptor(caught, 'cause')).toBeUndefined();
  });
});
