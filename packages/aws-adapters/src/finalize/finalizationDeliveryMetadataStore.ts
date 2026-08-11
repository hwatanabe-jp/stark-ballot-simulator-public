export interface AwsVerificationDeliveryMetadataInput {
  s3BundleKey?: string;
  s3ReportKey?: string;
  s3UploadedAtMs?: number;
  verificationWorkQueuedAtMs?: number;
}

export interface AwsFinalizationDeliveryMetadataStore {
  getAwsVerificationDeliveryMetadata(
    sessionId: string,
    finalizationId: string,
  ): Promise<AwsVerificationDeliveryMetadataInput | undefined>;

  recordAwsProofBundlePublication(
    sessionId: string,
    finalizationId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void>;

  recordAwsVerificationDeliveryMetadata(
    sessionId: string,
    finalizationId: string,
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

  record(sessionId: string, finalizationId: string, metadata: AwsVerificationDeliveryMetadataInput): void {
    this.records.set(buildDeliveryMetadataKey(sessionId, finalizationId), metadata);
  }

  take(sessionId: string, finalizationId: string): AwsVerificationDeliveryMetadataInput | undefined {
    const key = buildDeliveryMetadataKey(sessionId, finalizationId);
    const metadata = this.records.get(key);
    this.records.delete(key);
    return metadata;
  }

  get(sessionId: string, finalizationId: string): AwsVerificationDeliveryMetadataInput | undefined {
    return this.records.get(buildDeliveryMetadataKey(sessionId, finalizationId));
  }

  deleteSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
  }
}

function buildDeliveryMetadataKey(sessionId: string, finalizationId: string): string {
  return `${sessionId}:${finalizationId}`;
}
