import { describe, expect, it } from 'vitest';
import { BatchProcessor } from './batch-processor';

describe('BatchProcessor', () => {
  it('optimizes batch size using the documented thresholds', () => {
    const processor = new BatchProcessor();

    expect(processor.optimizeBatchSize(0)).toBe(0);
    expect(processor.optimizeBatchSize(1)).toBe(1);
    expect(processor.optimizeBatchSize(100)).toBe(10);
    expect(processor.optimizeBatchSize(101)).toBe(6);
    expect(processor.optimizeBatchSize(1_000)).toBe(50);
    expect(processor.optimizeBatchSize(10_000)).toBe(100);
    expect(processor.optimizeBatchSize(100_000)).toBe(500);
    expect(processor.optimizeBatchSize(250_000)).toBe(500);
  });

  it('processes every item in batched mode and records metrics', async () => {
    const processor = new BatchProcessor(2);
    const items = Array.from({ length: 120 }, (_, index) => index);
    const processed: number[] = [];

    await processor.processBatch(items, (item) => {
      processed.push(item);
    });

    expect(processed).toEqual(items);

    const metrics = processor.getMetrics();
    expect(metrics).not.toBeNull();
    expect(metrics?.totalItems).toBe(120);
    expect(metrics?.batchCount).toBe(20);
    expect(metrics?.averageBatchTime).toBeGreaterThanOrEqual(0);
    expect(metrics?.totalTime).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(metrics?.itemsPerSecond)).toBe(true);
    expect((metrics?.itemsPerSecond ?? 0) >= 0).toBe(true);
  });

  it('processes streaming data in fixed-size chunks and records metrics', async () => {
    const processor = new BatchProcessor();
    const processed: number[] = [];

    function* streamItems(): Generator<number> {
      for (let index = 0; index < 250; index++) {
        yield index;
      }
    }

    await processor.processStream(streamItems(), (item) => {
      processed.push(item);
    });

    expect(processed).toEqual(Array.from({ length: 250 }, (_, index) => index));

    const metrics = processor.getMetrics();
    expect(metrics).not.toBeNull();
    expect(metrics?.totalItems).toBe(250);
    expect(metrics?.batchCount).toBe(3);
    expect(metrics?.averageBatchTime).toBeGreaterThanOrEqual(0);
    expect(metrics?.totalTime).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(metrics?.itemsPerSecond)).toBe(true);
    expect((metrics?.itemsPerSecond ?? 0) >= 0).toBe(true);
  });

  it('resets collected metrics explicitly', async () => {
    const processor = new BatchProcessor();

    await processor.processBatch([1, 2, 3], () => undefined);

    expect(processor.getMetrics()).not.toBeNull();

    processor.resetMetrics();

    expect(processor.getMetrics()).toBeNull();
  });
});
