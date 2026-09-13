import { describe, expect, it, vi } from 'vitest';
import { canonicalRecordJson, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { resolveCurrentTerraformAcceptance } from './terraform-acceptance-selection.js';

const authority = vi.hoisted(() => ({
  admitPointer: vi.fn((_kind: unknown, value: unknown) => value),
  admitRecord: vi.fn((_kind: unknown, value: unknown) => value),
  admitRecordKey: vi.fn((_kind: unknown, value: unknown) => value),
  deriveRecordKey: vi.fn((_kind: unknown, value: Record<string, unknown>) => value['derivedKey']),
}));

vi.mock('./terraform-acceptance.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    admitTerraformAcceptancePointer: authority.admitPointer,
    admitTerraformAcceptanceRecord: authority.admitRecord,
    admitTerraformAcceptanceRecordKey: authority.admitRecordKey,
    deriveTerraformAcceptanceRecordKey: authority.deriveRecordKey,
  };
});

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const executionId = '11111111-2222-4333-8444-555555555555';
const attemptId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function selection(root: 'bootstrap' | 'foundation') {
  const lane = resolveDeploymentLaneAuthority(target, root);
  const recordKey = `${lane.names.terraformBaselinePrefix}/${lane.stateIdentity}/acceptances/${'c'.repeat(64)}.json`;
  const pointerKey = `${lane.names.terraformBaselinePrefix}/${lane.stateIdentity}/current.json`;
  return {
    pointer: { acceptanceAttemptId: attemptId, pipelineExecutionId: executionId, recordKey },
    pointerKey,
    pointerObservation: { etag: '"pointer-etag"', versionId: 'pointer-version' },
    record: { acceptanceAttemptId: attemptId, derivedKey: recordKey, pipelineExecutionId: executionId },
    recordKey,
    recordObservation: { etag: '"record-etag"', versionId: 'record-version' },
  };
}

describe('current Terraform acceptance selection', () => {
  it.each(['bootstrap', 'foundation'] as const)('reads one %s pointer and its exact selected record', async (root) => {
    const expected = selection(root);
    const getObject = vi.fn(({ key }: { key: string }) => {
      if (key === expected.pointerKey) {
        return {
          body: canonicalRecordJson(expected.pointer),
          etag: expected.pointerObservation.etag,
          versionId: expected.pointerObservation.versionId,
        };
      }
      if (key === expected.recordKey) {
        return {
          body: canonicalRecordJson(expected.record),
          etag: expected.recordObservation.etag,
          versionId: expected.recordObservation.versionId,
        };
      }
      throw new Error(`Unexpected key ${key}`);
    });

    await expect(
      resolveCurrentTerraformAcceptance({ expectedTargetKey: target.targetKey, root, transport: { getObject } }),
    ).resolves.toEqual(expected);
    expect(getObject).toHaveBeenCalledTimes(2);
    expect(getObject.mock.calls.map(([request]) => request.key)).toEqual([expected.pointerKey, expected.recordKey]);
  });

  it('fails closed on a missing or noncanonical pointer', async () => {
    await expect(
      resolveCurrentTerraformAcceptance({
        expectedTargetKey: target.targetKey,
        root: 'bootstrap',
        transport: { getObject: () => undefined },
      }),
    ).rejects.toThrow(/does not exist/iu);

    const expected = selection('bootstrap');
    await expect(
      resolveCurrentTerraformAcceptance({
        expectedTargetKey: target.targetKey,
        root: 'bootstrap',
        transport: {
          getObject: () => ({
            body: ` ${canonicalRecordJson(expected.pointer)}`,
            etag: expected.pointerObservation.etag,
            versionId: expected.pointerObservation.versionId,
          }),
        },
      }),
    ).rejects.toThrow(/canonical/iu);
  });

  it('rejects a pointer detached from the selected record', async () => {
    const expected = selection('bootstrap');
    const getObject = vi
      .fn()
      .mockReturnValueOnce({
        body: canonicalRecordJson(expected.pointer),
        etag: expected.pointerObservation.etag,
        versionId: expected.pointerObservation.versionId,
      })
      .mockReturnValueOnce({
        body: canonicalRecordJson({ ...expected.record, pipelineExecutionId: 'ffffffff-1111-4222-8333-444444444444' }),
        etag: expected.recordObservation.etag,
        versionId: expected.recordObservation.versionId,
      });

    await expect(
      resolveCurrentTerraformAcceptance({
        expectedTargetKey: target.targetKey,
        root: 'bootstrap',
        transport: { getObject },
      }),
    ).rejects.toThrow(/detached/iu);
  });
});
