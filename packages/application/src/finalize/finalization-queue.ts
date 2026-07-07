import type { FinalizationWorkItem } from '@stark-ballot/application/finalize/finalization-work-item';
import { logger } from '@stark-ballot/diagnostics/logger';

export type FinalizationPublishFn = (message: FinalizationWorkItem) => Promise<void>;

export interface FinalizationQueue {
  publish: (message: FinalizationWorkItem, maxAttempts: number) => Promise<void>;
}

/**
 * Create a finalization queue wrapper with retry support.
 */
export function createFinalizationQueue(publishImpl: FinalizationPublishFn): FinalizationQueue {
  return {
    publish: (message, maxAttempts) => publishFinalizeMessageWithRetry(publishImpl, message, maxAttempts),
  };
}

/**
 * Publish a finalization message with bounded retries.
 */
export async function publishFinalizeMessageWithRetry(
  publish: FinalizationPublishFn,
  message: FinalizationWorkItem,
  maxAttempts: number,
): Promise<void> {
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await publish(message);
      return;
    } catch (error) {
      lastError = error;
      logger.warn(`[API] Failed to publish finalize job (attempt ${attempt}/${attempts})`, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to publish finalize job');
}
