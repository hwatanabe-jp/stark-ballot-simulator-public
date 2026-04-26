import type { ProverWorkMessage } from '../../../src/lib/finalize/types.js';
import { serializeZkvmAggregatorInput } from '../../../src/lib/zkvm/executor.js';

export type InputUploadPayload = {
  key: string;
  body: string;
  contentType: string;
  metadata: Record<string, string>;
};

export function normalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function buildInputUploadPayload(message: ProverWorkMessage, prefix: string): InputUploadPayload {
  const normalizedPrefix = normalizeS3Prefix(prefix);
  const key = `${normalizedPrefix}${message.sessionId}/${message.executionId}/input.json`;
  const serialized = serializeZkvmAggregatorInput(message.zkvmInput);
  const body = JSON.stringify({
    ...serialized,
    contractGeneration: message.contractGeneration,
    election_config: {
      totalExpected: message.electionConfig.totalExpected,
      choices: [...message.electionConfig.choices],
      version: message.electionConfig.version,
      botCount: message.electionConfig.botCount,
      merkleTreeDepth: message.electionConfig.merkleTreeDepth,
    },
  });

  return {
    key,
    body,
    contentType: 'application/json',
    metadata: {
      sessionId: message.sessionId,
      executionId: message.executionId,
      queuedAt: new Date(message.queuedAt).toISOString(),
    },
  };
}
