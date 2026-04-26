/**
 * Batch processing utilities for performance optimization
 *
 * This class provides efficient batch processing capabilities with:
 * - Automatic batch size optimization
 * - Parallel execution with concurrency control
 * - Memory-efficient streaming support
 * - Performance monitoring and metrics
 */

export interface BatchMetrics {
  totalItems: number;
  batchCount: number;
  averageBatchTime: number;
  totalTime: number;
  itemsPerSecond: number;
}

type MaybePromise<T> = T | Promise<T>;

export class BatchProcessor {
  private readonly maxConcurrency: number;
  private metrics: BatchMetrics | null = null;

  constructor(maxConcurrency?: number) {
    // Use hardware concurrency for optimal performance when available
    const defaultConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;

    this.maxConcurrency = Math.max(1, Math.min(maxConcurrency || defaultConcurrency, 16));
  }

  /**
   * Optimize batch size based on data size
   * Uses adaptive heuristics for optimal throughput
   *
   * @param dataSize - Total number of items to process
   * @returns Optimal batch size for the given data size
   */
  optimizeBatchSize(dataSize: number): number {
    // Adaptive batch sizing based on data size
    // Smaller batches for small datasets, larger for big datasets
    if (dataSize <= 100) return Math.min(10, dataSize);
    if (dataSize <= 1000) return Math.min(50, Math.ceil(dataSize / 20));
    if (dataSize <= 10000) return Math.min(100, Math.ceil(dataSize / 100));
    if (dataSize <= 100000) return Math.min(500, Math.ceil(dataSize / 200));
    return Math.min(1000, Math.ceil(dataSize / 500));
  }

  /**
   * Process items in batches with parallel execution
   * Collects performance metrics during processing
   *
   * @param items - Array of items to process
   * @param processor - Function to process each item
   * @returns Promise that resolves when all items are processed
   */
  async processBatch<T>(items: T[], processor: (item: T) => MaybePromise<void>): Promise<void> {
    const startTime = performance.now();
    const batchSize = this.optimizeBatchSize(items.length);
    const batches: T[][] = [];
    const batchTimes: number[] = [];

    // Split into batches
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }

    // Process batches with limited concurrency
    const activeBatches: Map<Promise<void>, number> = new Map();

    for (const batch of batches) {
      const batchStartTime = performance.now();
      const batchPromise = this.processSingleBatch(batch, processor).then(() => {
        batchTimes.push(performance.now() - batchStartTime);
      });

      activeBatches.set(batchPromise, batchStartTime);

      // Limit concurrent batches
      if (activeBatches.size >= this.maxConcurrency) {
        await Promise.race(Array.from(activeBatches.keys()));
        // Remove completed promises
        for (const [promise] of activeBatches) {
          if ((await Promise.race([promise, Promise.resolve('pending')])) !== 'pending') {
            activeBatches.delete(promise);
            break;
          }
        }
      }
    }

    // Wait for all remaining batches
    await Promise.all(activeBatches.keys());

    // Calculate metrics
    const totalTime = performance.now() - startTime;
    this.metrics = {
      totalItems: items.length,
      batchCount: batches.length,
      averageBatchTime: batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length,
      totalTime,
      itemsPerSecond: (items.length / totalTime) * 1000,
    };
  }

  /**
   * Process a single batch
   */
  private async processSingleBatch<T>(batch: T[], processor: (item: T) => MaybePromise<void>): Promise<void> {
    await Promise.all(batch.map((item) => Promise.resolve(processor(item))));
  }

  /**
   * Process streaming data with memory efficiency
   * Ideal for large datasets that don't fit in memory
   *
   * @param stream - Iterable or async iterable stream of items
   * @param processor - Function to process each item
   */
  async processStream<T>(
    stream: Iterable<T> | AsyncIterable<T>,
    processor: (item: T) => MaybePromise<void>,
  ): Promise<void> {
    const buffer: T[] = [];
    const batchSize = 100; // Fixed batch size for streaming
    const startTime = performance.now();
    let totalItems = 0;

    for await (const item of stream) {
      buffer.push(item);
      totalItems++;

      if (buffer.length >= batchSize) {
        // Process and clear buffer to maintain memory efficiency
        await this.processSingleBatch(buffer.splice(0, batchSize), processor);
      }
    }

    // Process remaining items
    if (buffer.length > 0) {
      await this.processSingleBatch(buffer, processor);
    }

    // Update metrics for streaming
    const totalTime = performance.now() - startTime;
    this.metrics = {
      totalItems,
      batchCount: Math.ceil(totalItems / batchSize),
      averageBatchTime: totalTime / Math.ceil(totalItems / batchSize),
      totalTime,
      itemsPerSecond: (totalItems / totalTime) * 1000,
    };
  }

  /**
   * Get performance metrics from the last operation
   *
   * @returns Metrics object or null if no operations have been performed
   */
  getMetrics(): BatchMetrics | null {
    return this.metrics;
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = null;
  }
}
