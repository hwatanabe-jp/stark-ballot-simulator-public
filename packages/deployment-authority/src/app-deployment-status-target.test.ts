import { expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';

it('publishes production status only from the complete target-bound acceptance history', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const ledger = await import('./app-acceptance-ledger.js');
    const dto = await import('./app-deployment-status.js');
    const publisher = await import('./app-deployment-status-publication.js');
    const fixtures = await import('./testdata/app-acceptance-ledger-fixture.js');
    const target = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    const previousRecord = fixtures.createProductionAppAcceptanceFixture();
    const record = { ...previousRecord, acceptedAt: '2026-08-14T01:05:05.000Z' };
    const previousKey = ledger.deriveAppAcceptanceRecordKey(previousRecord, target.targetKey);
    const key = ledger.deriveAppAcceptanceRecordKey(record, target.targetKey);
    const observation = { etag: '"pointer-etag"', versionId: 'pointer-version' };
    const pointer = ledger.projectInitialAppAcceptancePointer(
      { history: [key, previousKey], predecessor: observation },
      target.targetKey,
    );
    const bind = (recordKey: string, selectedRecord: unknown) =>
      ledger.bindAppAcceptanceSelection(
        {
          pointer,
          pointerObservation: observation,
          recordKey,
          record: selectedRecord,
          recordObservation: observation,
        },
        target.targetKey,
      );
    const current = bind(key, record);
    const retained = bind(previousKey, previousRecord);
    const resolution = {
      resolutionType: 'app-acceptance-history',
      pointerKey: targets.resolveDeploymentLaneAuthority(target, 'app').names.acceptedDeploymentPointerKey,
      pointer,
      pointerObservation: observation,
      selections: [current, retained],
    };
    const status = dto.projectAppDeploymentStatus(current, target.targetKey);
    const body = dto.canonicalAppDeploymentStatusJson(status, target.targetKey);
    expect(dto.admitAppDeploymentStatus(status, target.targetKey)).toEqual(status);
    expect(dto.parseCanonicalAppDeploymentStatus(body, target.targetKey)).toEqual(status);
    expect(body).not.toContain(target.accountId);
    expect(body).not.toContain(target.targetKey);
    expect(status.acceptedAt).toBe(record.acceptedAt);
    expect(status.staleAfter).toBe('2026-09-13T01:05:05.000Z');
    // Display DTOs carry no target identity. The source repository may be shared;
    // the acceptance history and the exact bucket adapter own account isolation.
    expect(dto.parseCanonicalAppDeploymentStatus(body, 'stark-dev/develop')).toEqual(status);
    expect(() => dto.projectAppDeploymentStatus(current, 'stark-dev/develop')).toThrow();
    for (const wrongTarget of [undefined, 'unreviewed/main']) {
      expect(() => dto.admitAppDeploymentStatus(status, wrongTarget)).toThrow();
      expect(() => dto.projectAppDeploymentStatus(current, wrongTarget)).toThrow();
      expect(() => dto.parseCanonicalAppDeploymentStatus(body, wrongTarget)).toThrow();
      expect(() => dto.canonicalAppDeploymentStatusJson(status, wrongTarget)).toThrow();
    }
    const previousBody = dto.canonicalAppDeploymentStatusJson(
      dto.projectAppDeploymentStatus(retained, target.targetKey),
      target.targetKey,
    );
    expect(
      publisher.classifyAppDeploymentStatusPublication({ resolution, statusRead: undefined }, target.targetKey),
    ).toMatchObject({ disposition: 'create', body });
    expect(
      publisher.classifyAppDeploymentStatusPublication(
        { resolution, statusRead: { body, ...observation } },
        target.targetKey,
      ),
    ).toMatchObject({ disposition: 'current', body });
    expect(
      publisher.classifyAppDeploymentStatusPublication(
        { resolution, statusRead: { body: previousBody, ...observation } },
        target.targetKey,
      ),
    ).toMatchObject({ disposition: 'update', body, condition: { type: 'if-match', ...observation } });
    const foreign = fixtures.createBoundSelectionFixture('current');
    for (const badResolution of [
      { ...resolution, pointerKey: resolution.pointerKey.replace('stark-prod/main', 'stark-dev/develop') },
      { ...resolution, selections: [current] },
      { ...resolution, selections: [current, foreign] },
      { ...resolution, pointer: foreign.pointer },
    ]) {
      expect(() =>
        publisher.classifyAppDeploymentStatusPublication(
          { resolution: badResolution, statusRead: undefined },
          target.targetKey,
        ),
      ).toThrow();
    }
    const resolveHistory = vi.fn(() => resolution);
    let stored: { body: string; etag: string; versionId: string } | undefined;
    const reads = vi.fn(() => stored);
    const writes = vi.fn((value: unknown) => {
      const request = value as { body: string; condition: { type: string; etag?: string } };
      if (request.condition.type === 'if-none-match' && stored !== undefined) return { status: 'precondition-failed' };
      if (request.condition.type === 'if-match' && request.condition.etag !== stored?.etag)
        return { status: 'precondition-failed' };
      stored = {
        body: request.body,
        etag: `"status-${writes.mock.calls.length}"`,
        versionId: `status-${writes.mock.calls.length}`,
      };
      return { status: 'written', etag: stored.etag, versionId: stored.versionId };
    });
    const dependencies = { resolveHistory, statusStore: { readStatus: reads, writeStatus: writes } };
    for (const wrongTarget of [undefined, 'unreviewed/main', 'stark-dev/develop']) {
      expect(() =>
        publisher.classifyAppDeploymentStatusPublication({ resolution, statusRead: undefined }, wrongTarget),
      ).toThrow();
      await expect(publisher.publishCurrentAppDeploymentStatus(dependencies, wrongTarget)).rejects.toThrow();
    }
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(await publisher.publishCurrentAppDeploymentStatus(dependencies, target.targetKey)).toMatchObject({
      disposition: 'created',
      status,
    });
    expect(reads).not.toHaveBeenCalled();
    expect(writes.mock.calls[0]?.[0]).toEqual({ body, condition: { type: 'if-none-match' } });
    expect(await publisher.publishCurrentAppDeploymentStatus(dependencies, target.targetKey)).toMatchObject({
      disposition: 'already-current',
      status,
    });
    stored = { body: previousBody, ...observation };
    expect(await publisher.publishCurrentAppDeploymentStatus(dependencies, target.targetKey)).toMatchObject({
      disposition: 'updated',
      status,
    });
    expect(writes.mock.calls.at(-1)?.[0]).toEqual({ body, condition: { type: 'if-match', ...observation } });
    const deniedRead = vi.fn(() => {
      throw new Error('AccessDenied');
    });
    await expect(
      publisher.publishCurrentAppDeploymentStatus(
        { ...dependencies, statusStore: { readStatus: deniedRead, writeStatus: writes } },
        target.targetKey,
      ),
    ).rejects.toThrow('AccessDenied');
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
