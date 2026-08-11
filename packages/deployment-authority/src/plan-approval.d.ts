export interface SavedPlanApprovalPolicy {
  readonly actionName: string;
  readonly approvalSubject: string;
  readonly exactlyOneError: string;
  readonly stageName: string;
  readonly summaryLabel: string;
}

export interface SavedPlanApprovalPublicationInput {
  readonly actionExecutions: unknown;
  readonly pipelineExecutionId: unknown;
  readonly sourceSha: unknown;
  readonly accountId: unknown;
  readonly deploymentEnvironment: unknown;
  readonly reviewedPlanChecksum: unknown;
  readonly expectedSummaryExtensions?: Readonly<Record<string, string>>;
  readonly policy: SavedPlanApprovalPolicy;
}

export interface SavedPlanApprovalPublication extends Readonly<Record<string, unknown>> {
  readonly pipelineExecutionId: string;
  readonly stageName: string;
  readonly actionName: string;
  readonly actionExecutionId: string;
  readonly sourceSha: string;
  readonly accountId: string;
  readonly deploymentEnvironment: string;
  readonly reviewedPlanChecksum: string;
  readonly approver: string;
  readonly approvalTimestamp: string;
}

export function parseSavedPlanChecksum(value: unknown): string;
export function parseSavedPlanChecksumSidecar(value: unknown): string;
export function validateSavedPlanApprovalPublication(
  input: SavedPlanApprovalPublicationInput,
): SavedPlanApprovalPublication;
