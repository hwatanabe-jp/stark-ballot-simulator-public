import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import { buildFinalizationQueueInfo } from './finalizationQueueInfo';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const originalEnv = { ...process.env };
const FINALIZATION_ID = asFinalizationId('exec');

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
};

describe('buildFinalizationQueueInfo', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('returns null when queueUrl is missing', async () => {
    const state: FinalizationState = {
      status: 'pending',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: 1_730_000_000_000,
    };

    const queueInfo = await buildFinalizationQueueInfo({ state });

    expect(queueInfo).toBeNull();
  });

  it('returns the static queue estimate for pending state without reading SQS attributes', async () => {
    const state: FinalizationState = {
      status: 'pending',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: 1_730_000_000_000,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toEqual({
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    });
    expect(Object.keys(queueInfo ?? {}).sort()).toEqual(['concurrencyLimit', 'estimatedDurationMs']);
  });

  it('returns the same static queue estimate for running state without positional claims', async () => {
    const queuedAtMs = 1_730_000_000_000;
    const state: FinalizationState = {
      status: 'running',
      finalizationId: FINALIZATION_ID,
      queuedAtMs,
      startedAtMs: queuedAtMs + 1500,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toEqual({
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    });
    expect(queueInfo).not.toHaveProperty('position');
    expect(queueInfo).not.toHaveProperty('depth');
    expect(queueInfo).not.toHaveProperty('estimatedStartAt');
    expect(queueInfo).not.toHaveProperty('estimatedCompletionAt');
  });

  it('uses PROVER_MAX_CONCURRENT_PROVERS when a retired concurrency variable is also present', async () => {
    process.env['PROVER_MAX_CONCURRENT_PROVERS'] = '5';
    process.env['PROVER_LAMBDA_CONCURRENCY'] = '9';

    const state: FinalizationState = {
      status: 'pending',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: 1_730_000_000_000,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toEqual({
      concurrencyLimit: 5,
      estimatedDurationMs: 360000,
    });
  });

  it('ignores the retired PROVER_LAMBDA_CONCURRENCY variable', async () => {
    process.env['PROVER_LAMBDA_CONCURRENCY'] = '4';

    const state: FinalizationState = {
      status: 'pending',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: 1_730_000_000_000,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toEqual({
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    });
  });
});
