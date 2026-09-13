import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import { logger } from '@stark-ballot/diagnostics/logger';
import { MockSessionStore } from '../store/mockSessionStore';
import {
  recordFinalizationPersistenceOutcome,
  recordFinalizationStorePersistenceOutcome,
} from './finalizationTransitionObservability';

const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 0,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MockSessionStore finalization transition ownership', () => {
  it('emits exactly one authoritative event for changed, idempotent, and rejected updates', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const store = new MockSessionStore();
    const session = await store.createSession();
    info.mockClear();

    const queuedPayload = {
      finalizationId: asFinalizationId('exec-store-observation'),
      queuedAtMs: 1_700_000_000_000,
      scenarioContext,
      observability: { source: 'finalize', reason: 'FINALIZE_REQUESTED' },
    } as const;
    await store.markFinalizationQueued(session.sessionId, queuedPayload);

    expect(info.mock.calls.filter(([message]) => message === 'finalization_admitted')).toHaveLength(1);
    expect(info).toHaveBeenCalledWith('finalization_admitted', {
      event: 'finalization_admitted',
      finalization_id: 'exec-store-observation',
    });
    expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({ from: 'none', to: 'pending', changed: true }),
    );

    info.mockClear();
    await store.markFinalizationQueued(session.sessionId, queuedPayload);
    expect(info.mock.calls.filter(([message]) => message === 'finalization_admitted')).toHaveLength(0);
    expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({ from: 'pending', to: 'pending', changed: false, reason: 'IDEMPOTENT_RETRY' }),
    );

    info.mockClear();
    warn.mockClear();
    await store.markFinalizationRunning(session.sessionId, {
      finalizationId: asFinalizationId('exec-stale-observation'),
      queuedAtMs: queuedPayload.queuedAtMs,
      startedAtMs: queuedPayload.queuedAtMs + 1,
      observability: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(0);
    expect(warn.mock.calls.filter(([message]) => message === 'finalize_state_update_rejected')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'finalize_state_update_rejected',
      expect.objectContaining({ to: 'running', reason: 'EXECUTION_MISMATCH' }),
    );
  });
});

describe('FileMockSessionStore finalization transition ownership', () => {
  it('emits only after the file-backed state has been saved', async () => {
    const storageDir = path.join(process.cwd(), '.tmp', `finalization-observability-${Date.now()}`);
    const originalStorageDir = process.env['FILE_MOCK_STORE_DIR'];
    process.env['FILE_MOCK_STORE_DIR'] = storageDir;
    try {
      const { FileMockSessionStore } = await import('../store/fileMockSessionStore');
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const store = new FileMockSessionStore();
      const session = await store.createSession();
      info.mockClear();

      await store.markFinalizationQueued(session.sessionId, {
        finalizationId: asFinalizationId('exec-file-observation'),
        queuedAtMs: 1_700_000_000_000,
        scenarioContext,
        observability: { source: 'finalize', reason: 'FINALIZE_REQUESTED' },
      });

      expect(info.mock.calls.filter(([message]) => message === 'finalization_admitted')).toHaveLength(1);
      expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(1);
      expect(info).toHaveBeenCalledWith(
        'finalize_state_transition',
        expect.objectContaining({ from: 'none', to: 'pending', changed: true }),
      );
      await expect(fs.pathExists(path.join(storageDir, 'sessions.json'))).resolves.toBe(true);
    } finally {
      if (originalStorageDir === undefined) {
        delete process.env['FILE_MOCK_STORE_DIR'];
      } else {
        process.env['FILE_MOCK_STORE_DIR'] = originalStorageDir;
      }
      await fs.remove(storageDir);
    }
  });
});

describe('recordFinalizationPersistenceOutcome', () => {
  it('records the actual before/after states only after an authoritative write', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    recordFinalizationPersistenceOutcome({
      sessionId: 'session-transition',
      requestedFinalizationId: 'exec-transition',
      requestedTo: 'running',
      before: { status: 'pending', finalizationId: 'exec-transition' },
      actual: { status: 'running', finalizationId: 'exec-transition' },
      authoritativeWrite: true,
      metadata: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({
        event: 'finalize_state_transition',
        from: 'pending',
        to: 'running',
        source: 'writer_update',
        reason: 'RUNTIME_UPDATE_RECEIVED',
        changed: true,
        finalization_id: 'exec-transition',
      }),
    );
    const payload = info.mock.calls[0]?.[1];
    expect(payload && typeof payload === 'object' ? Reflect.get(payload, 'session_id_hash') : undefined).toMatch(
      /^sid_[0-9a-f]{12}$/,
    );
  });

  it('represents a locally admitted idempotent retry with changed false', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    recordFinalizationPersistenceOutcome({
      sessionId: 'session-idempotent',
      requestedFinalizationId: 'exec-idempotent',
      requestedTo: 'running',
      before: { status: 'running', finalizationId: 'exec-idempotent' },
      actual: { status: 'running', finalizationId: 'exec-idempotent' },
      authoritativeWrite: true,
      metadata: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({ from: 'running', to: 'running', changed: false, reason: 'IDEMPOTENT_RETRY' }),
    );
  });

  it('represents a competing persisted idempotent result without claiming the local write changed it', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    recordFinalizationPersistenceOutcome({
      sessionId: 'session-concurrent-idempotent',
      requestedFinalizationId: 'exec-concurrent-idempotent',
      requestedTo: 'running',
      before: { status: 'pending', finalizationId: 'exec-concurrent-idempotent' },
      actual: { status: 'running', finalizationId: 'exec-concurrent-idempotent' },
      authoritativeWrite: false,
      metadata: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({ from: 'running', to: 'running', changed: false, reason: 'IDEMPOTENT_RETRY' }),
    );
  });

  it('records a stale competing execution as a rejected requested update', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    recordFinalizationPersistenceOutcome({
      sessionId: 'session-stale',
      requestedFinalizationId: 'exec-stale',
      requestedTo: 'succeeded',
      before: { status: 'running', finalizationId: 'exec-stale' },
      actual: { status: 'running', finalizationId: 'exec-current' },
      authoritativeWrite: false,
      metadata: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(warn).toHaveBeenCalledWith(
      'finalize_state_update_rejected',
      expect.objectContaining({ to: 'succeeded', source: 'writer_update', reason: 'EXECUTION_MISMATCH' }),
    );
  });

  it('records sticky terminal refusal without fabricating a transition', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    recordFinalizationPersistenceOutcome({
      sessionId: 'session-terminal',
      requestedFinalizationId: 'exec-terminal',
      requestedTo: 'running',
      before: { status: 'failed', finalizationId: 'exec-terminal' },
      actual: { status: 'failed', finalizationId: 'exec-terminal' },
      authoritativeWrite: true,
      metadata: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'finalize_state_update_rejected',
      expect.objectContaining({ to: 'running', reason: 'TERMINAL_STATE_STICKY' }),
    );
  });

  it('records both the fail-closed transition and the rejected requested state', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    recordFinalizationPersistenceOutcome({
      sessionId: 'session-fail-closed',
      requestedFinalizationId: 'exec-fail-closed',
      requestedTo: 'running',
      before: { status: 'pending', finalizationId: 'exec-fail-closed' },
      actual: { status: 'failed', finalizationId: 'exec-fail-closed' },
      actualReason: 'INVALID_FINALIZATION_ARTIFACT',
      authoritativeWrite: true,
      metadata: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({
        from: 'pending',
        to: 'failed',
        changed: true,
        reason: 'INVALID_FINALIZATION_ARTIFACT',
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      'finalize_state_update_rejected',
      expect.objectContaining({ to: 'running', reason: 'INVALID_FINALIZATION_ARTIFACT' }),
    );
  });

  it('preserves the corrupt-artifact guard reason on the transition and rejection', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const finalizationId = asFinalizationId('exec-corrupt-artifact');
    recordFinalizationStorePersistenceOutcome({
      sessionId: 'session-corrupt-artifact',
      requestedFinalizationId: finalizationId,
      requestedTo: 'running',
      before: { status: 'pending', finalizationId },
      actual: {
        status: 'failed',
        finalizationId,
        queuedAtMs: 1_700_000_000_000,
        failedAtMs: 1_700_000_001_000,
        error: {
          code: 'INVALID_FINALIZATION_ARTIFACT',
          message: 'Finalization artifact is invalid',
        },
      },
      authoritativeWrite: true,
      metadata: { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' },
    });

    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({ reason: 'INVALID_FINALIZATION_ARTIFACT', changed: true }),
    );
    expect(warn).toHaveBeenCalledWith(
      'finalize_state_update_rejected',
      expect.objectContaining({ reason: 'INVALID_FINALIZATION_ARTIFACT' }),
    );
  });

  it('uses none only when the authoritative store had no prior state', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    recordFinalizationPersistenceOutcome({
      sessionId: 'session-initial',
      requestedFinalizationId: 'exec-initial',
      requestedTo: 'pending',
      actual: { status: 'pending', finalizationId: 'exec-initial' },
      authoritativeWrite: true,
      metadata: { source: 'finalize', reason: 'FINALIZE_REQUESTED' },
    });

    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({ from: 'none', to: 'pending', changed: true }),
    );
  });
});
