import { afterAll, describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';

const { configuration } = productionConfigurationFixture();
vi.resetModules();
vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
const { canonicalRecordJson, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } =
  await import('./index.js');
const {
  admitAppCurrentAcceptancePointer,
  projectAppAcceptanceGenesisPointer,
  projectAppAcceptancePointerTransition,
  deriveAppAcceptanceRecordKey,
  APP_ACCEPTANCE_KIND,
  APP_CURRENT_ACCEPTANCE_POINTER_KIND,
} = await import('./app-acceptance-ledger.js');
const { createAppAcceptanceLedger } = await import('./app-acceptance-publication.js');
const { createProductionAppAcceptanceFixture } = await import('./testdata/app-acceptance-ledger-fixture.js');
afterAll(() => {
  vi.doUnmock('../deployment-targets.json');
  vi.resetModules();
});
const target = resolveAllowedDeploymentTarget('stark-prod/main');
const pointerKey = resolveDeploymentLaneAuthority(target, 'app').names.acceptedDeploymentPointerKey;
type Stored = { body: string; etag: string; versionId: string };

function fixture() {
  const objects = new Map<string, Stored>();
  const operations: string[] = [];
  let sequence = 0;
  const getObject = vi.fn((input: Readonly<Record<string, unknown>>) => {
    if (typeof input['key'] !== 'string') throw new Error('Invalid test key');
    operations.push(`get:${input['key']}`);
    return objects.get(input['key']);
  });
  const putObject = vi.fn((input: Readonly<Record<string, unknown>>) => {
    const { key, body, condition } = input;
    if (
      typeof key !== 'string' ||
      typeof body !== 'string' ||
      condition === null ||
      typeof condition !== 'object' ||
      !('type' in condition)
    )
      throw new Error('Invalid test write');
    operations.push(`put:${key}`);
    const current = objects.get(key);
    if (
      condition.type === 'if-none-match'
        ? current !== undefined
        : !('etag' in condition) || condition.etag !== current?.etag
    ) {
      return { status: 'precondition-failed' as const };
    }
    sequence += 1;
    const written = { body, etag: `"etag-${sequence}"`, versionId: `version-${sequence}` };
    objects.set(key, written);
    return { status: 'written' as const, etag: written.etag, versionId: written.versionId };
  });
  const ledger = createAppAcceptanceLedger({ getObject, putObject }, target.targetKey);
  const record = createProductionAppAcceptanceFixture();
  const pointer = projectAppAcceptanceGenesisPointer(record, target.targetKey);
  const request = {
    kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
    pointerKey,
    pointer,
    currentPointer: null,
    expected: null,
  };
  return { ledger, record, pointer, request, operations, objects, getObject, putObject };
}

describe('First production App acceptance', () => {
  it('has one initial history entry and no fabricated predecessor', () => {
    const input = fixture();
    expect(input.pointer).toMatchObject({
      generation: 1,
      previous: null,
      history: [deriveAppAcceptanceRecordKey(input.record, target.targetKey)],
    });
    expect(admitAppCurrentAcceptancePointer(input.pointer, target.targetKey)).toEqual(input.pointer);
    expect(() => projectAppAcceptanceGenesisPointer(input.record, 'stark-dev/develop')).toThrow('production target');
    expect(() => admitAppCurrentAcceptancePointer({ ...input.pointer, generation: 2 }, target.targetKey)).toThrow(
      'single first',
    );
    expect(() =>
      projectAppAcceptanceGenesisPointer({ ...input.record, planDisposition: 'empty' }, target.targetKey),
    ).toThrow('changed normal');
  });
  it('creates the exact pointer before any pointer read and admits an exact retry', async () => {
    const input = fixture();
    await input.ledger.publishRecord(APP_ACCEPTANCE_KIND, input.record);
    input.operations.length = 0;
    await expect(input.ledger.movePointer(input.request)).resolves.toMatchObject({
      status: 'moved',
      pointer: input.pointer,
    });
    expect(input.operations).toEqual([`get:${input.pointer.headKey}`, `put:${pointerKey}`]);
    expect(input.putObject.mock.calls.at(-1)?.[0]['condition']).toEqual({ type: 'if-none-match' });
    await expect(input.ledger.movePointer(input.request)).resolves.toMatchObject({ status: 'idempotent-retry' });
    await expect(input.ledger.resolveCurrentHistory(pointerKey)).resolves.toMatchObject({
      pointer: input.pointer,
      records: [{ record: input.record }],
    });
  });
  it('uses ordinary CAS and bounded history after the first acceptance', async () => {
    const input = fixture();
    await input.ledger.publishRecord(APP_ACCEPTANCE_KIND, input.record);
    await input.ledger.movePointer(input.request);
    const current = await input.ledger.resolveCurrentHistory(pointerKey);
    const next = { ...input.record, acceptedAt: '2026-08-14T01:05:05.000Z' };
    await input.ledger.publishRecord(APP_ACCEPTANCE_KIND, next);
    const nextPointer = projectAppAcceptancePointerTransition(
      {
        currentPointer: current.pointer,
        currentPointerObservation: current.pointerObservation,
        nextRecordKey: deriveAppAcceptanceRecordKey(next, target.targetKey),
      },
      target.targetKey,
    );
    await expect(
      input.ledger.movePointer({
        ...input.request,
        currentPointer: current.pointer,
        expected: current.pointerObservation,
        pointer: nextPointer,
      }),
    ).resolves.toMatchObject({ status: 'moved' });
    expect(nextPointer).toMatchObject({
      generation: 2,
      previous: current.pointerObservation,
      history: [nextPointer.headKey, input.pointer.headKey],
    });
    expect(input.putObject.mock.calls.at(-1)?.[0]['condition']).toMatchObject({ type: 'if-match' });
  });
  it('reports a competing initial acceptance without replacing it', async () => {
    const input = fixture();
    await input.ledger.publishRecord(APP_ACCEPTANCE_KIND, input.record);
    const other = projectAppAcceptanceGenesisPointer(
      { ...input.record, acceptedAt: '2026-08-14T01:05:05.000Z' },
      target.targetKey,
    );
    const body = canonicalRecordJson(other);
    input.objects.set(pointerKey, { body, etag: '"other"', versionId: 'other-version' });
    await expect(input.ledger.movePointer(input.request)).resolves.toMatchObject({
      status: 'conflict',
      expected: null,
      observed: { pointer: other },
    });
    expect(input.objects.get(pointerKey)?.body).toBe(body);
    expect(input.putObject.mock.calls.at(-1)?.[0]['condition']).toEqual({ type: 'if-none-match' });
  });
  it('does not classify write denial as pointer absence', async () => {
    const input = fixture();
    await input.ledger.publishRecord(APP_ACCEPTANCE_KIND, input.record);
    input.operations.length = 0;
    input.putObject.mockImplementation(() => {
      throw new Error('AccessDenied');
    });
    await expect(input.ledger.movePointer(input.request)).rejects.toThrow('AccessDenied');
    expect(input.operations).toEqual([`get:${input.pointer.headKey}`]);
  });
  it('requires both explicit null coordinates and a published complete acceptance', async () => {
    const input = fixture();
    await expect(
      input.ledger.movePointer({ ...input.request, expected: { etag: '"old"', versionId: 'old-version' } }),
    ).rejects.toThrow('explicit null');
    expect(input.operations).toEqual([]);
    await expect(input.ledger.movePointer(input.request)).rejects.toThrow('does not exist');
    expect(input.putObject).not.toHaveBeenCalled();
  });
});
