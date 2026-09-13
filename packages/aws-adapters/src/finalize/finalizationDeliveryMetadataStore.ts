import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export interface AwsVerificationDeliveryMetadataInput {
  s3BundleKey?: string;
  s3ReportKey?: string;
  s3UploadedAtMs?: number;
  verificationWorkQueuedAtMs?: number;
}

export interface AwsFinalizationDeliveryMetadataStore {
  getAwsVerificationDeliveryMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<AwsVerificationDeliveryMetadataInput | undefined>;

  recordAwsProofBundlePublication(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void>;

  recordAwsVerificationDeliveryMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void>;
}

export class InMemoryAwsVerificationDeliveryMetadataStore {
  private records = new Map<string, AwsVerificationDeliveryMetadataInput>();

  clone(): InMemoryAwsVerificationDeliveryMetadataStore {
    const cloned = new InMemoryAwsVerificationDeliveryMetadataStore();
    for (const [key, metadata] of this.records) {
      cloned.records.set(key, { ...metadata });
    }
    return cloned;
  }

  record(sessionId: SessionId, finalizationId: FinalizationId, metadata: AwsVerificationDeliveryMetadataInput): void {
    this.records.set(buildDeliveryMetadataKey(sessionId, finalizationId), metadata);
  }

  get(sessionId: SessionId, finalizationId: FinalizationId): AwsVerificationDeliveryMetadataInput | undefined {
    return this.records.get(buildDeliveryMetadataKey(sessionId, finalizationId));
  }

  deleteSession(sessionId: SessionId): void {
    const prefix = `${sessionId}:`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
  }
}

function buildDeliveryMetadataKey(sessionId: SessionId, finalizationId: FinalizationId): string {
  return `${sessionId}:${finalizationId}`;
}
