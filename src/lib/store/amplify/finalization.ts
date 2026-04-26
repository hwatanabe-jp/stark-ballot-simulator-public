import type {
  FinalizationResult,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
  FinalizationStoragePayload,
} from '@/types/server';
import {
  parseFinalizationStorageEnvelope,
  parseFinalizationStoragePayload,
  type ParsedFinalizationStorageEnvelope,
} from '@/lib/finalize/finalization-storage';

export type ParsedStoredFinalizationPayload = FinalizationStoragePayload & { contractGeneration: string };
export type ParsedStoredFinalizationEnvelope = ParsedFinalizationStorageEnvelope;

function parseStoredJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

type FinalizationResultStorageInput = FinalizationResultAuthority | FinalizationResult;

function toStoredFinalizationResult(
  result: FinalizationResultStorageInput | null | undefined,
): FinalizationResultAuthority | null | undefined {
  if (result === undefined || result === null) {
    return null;
  }
  if (!result.journal) {
    return null;
  }

  const authority: FinalizationResultAuthority = {
    tally: result.tally,
    s3BundleKey: result.s3BundleKey,
    s3UploadedAt: result.s3UploadedAt,
    receipt: result.receipt,
    receiptRaw: result.receiptRaw,
    receiptPublication: result.receiptPublication,
    imageId: result.imageId,
    tamperDetected: result.tamperDetected,
    scenarios: result.scenarios,
    journal: result.journal,
    publicInputArtifact: result.publicInputArtifact,
    electionManifest: result.electionManifest,
    closeStatement: result.closeStatement,
    bitmapProofSource: result.bitmapProofSource,
    bitmapData: result.bitmapData,
    verificationResult: result.verificationResult,
    verificationExecutionId: result.verificationExecutionId,
    tamperSummary: result.tamperSummary,
  };

  return authority;
}

export function stripFinalizationResult(
  result: FinalizationResultStorageInput | null | undefined,
): FinalizationResultAuthority | null | undefined {
  const authority = toStoredFinalizationResult(result);
  if (authority === undefined || authority === null) {
    return authority;
  }

  const metadataOnly: FinalizationResultAuthority = { ...authority };
  delete metadataOnly.receipt;
  delete metadataOnly.receiptRaw;
  return metadataOnly;
}

export function parseStoredFinalizationPayload(value: unknown): ParsedStoredFinalizationPayload | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsedValue = parseStoredJsonValue(value);
  if (parsedValue === undefined) {
    return undefined;
  }

  const parsed = parseFinalizationStoragePayload(parsedValue);
  if (!parsed) {
    return undefined;
  }

  const contractGeneration =
    typeof parsed.contractGeneration === 'string' && parsed.contractGeneration.length > 0
      ? parsed.contractGeneration
      : undefined;

  if (!contractGeneration) {
    return undefined;
  }

  return {
    contractGeneration,
    finalizationResult: parsed.finalizationResult ?? null,
    finalizationState: parsed.finalizationState ?? null,
    ...(Object.prototype.hasOwnProperty.call(parsed, 'finalizationScenarioContext')
      ? {
          finalizationScenarioContext: parsed.finalizationScenarioContext ?? null,
        }
      : {}),
  };
}

export function parseStoredFinalizationEnvelope(value: unknown): ParsedStoredFinalizationEnvelope | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsedValue = parseStoredJsonValue(value);
  if (parsedValue === undefined) {
    return undefined;
  }

  return parseFinalizationStorageEnvelope(parsedValue);
}

export function serializeStoredFinalizationPayload(
  payload: FinalizationStoragePayload | null | undefined,
): string | null {
  if (!payload) {
    return null;
  }

  const safeResult = stripFinalizationResult(payload.finalizationResult ?? null);
  const normalizedState = payload.finalizationState ?? null;
  const hasScenarioContext = Object.prototype.hasOwnProperty.call(payload, 'finalizationScenarioContext');
  const normalizedContext = payload.finalizationScenarioContext ?? null;

  if (!safeResult && !normalizedState && !normalizedContext) {
    return null;
  }

  if (typeof payload.contractGeneration !== 'string' || payload.contractGeneration.trim().length === 0) {
    throw new Error('Finalization storage payload requires an explicit contractGeneration');
  }

  const serializedPayload: FinalizationStoragePayload = {
    contractGeneration: payload.contractGeneration,
    finalizationResult: safeResult ?? null,
    finalizationState: normalizedState,
    ...(hasScenarioContext ? { finalizationScenarioContext: normalizedContext } : {}),
  };

  return JSON.stringify(serializedPayload);
}

export function serializeFinalizationPayload(
  result: FinalizationResultStorageInput | null | undefined,
  state: FinalizationState | null | undefined,
  contractGeneration: string,
  scenarioContext?: FinalizationScenarioContext | null,
): string | null {
  return serializeStoredFinalizationPayload({
    contractGeneration,
    finalizationResult: stripFinalizationResult(result) ?? null,
    finalizationState: state ?? null,
    ...(scenarioContext !== undefined ? { finalizationScenarioContext: scenarioContext ?? null } : {}),
  });
}
