export interface AwsVerificationDeliveryMetadataInput {
  s3BundleKey?: string;
  s3ReportKey?: string;
  s3UploadedAt?: string;
}

export interface AwsFinalizationDeliveryMetadataStore {
  recordAwsProofBundlePublication(
    sessionId: string,
    executionId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void>;

  recordAwsVerificationDeliveryMetadata(
    sessionId: string,
    executionId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void>;
}

export class InMemoryAwsVerificationDeliveryMetadataStore {
  private records = new Map<string, AwsVerificationDeliveryMetadataInput>();

  record(sessionId: string, executionId: string, metadata: AwsVerificationDeliveryMetadataInput): void {
    this.records.set(buildDeliveryMetadataKey(sessionId, executionId), metadata);
  }

  take(sessionId: string, executionId: string): AwsVerificationDeliveryMetadataInput | undefined {
    const key = buildDeliveryMetadataKey(sessionId, executionId);
    const metadata = this.records.get(key);
    this.records.delete(key);
    return metadata;
  }

  get(sessionId: string, executionId: string): AwsVerificationDeliveryMetadataInput | undefined {
    return this.records.get(buildDeliveryMetadataKey(sessionId, executionId));
  }
}

function buildDeliveryMetadataKey(sessionId: string, executionId: string): string {
  return `${sessionId}:${executionId}`;
}
