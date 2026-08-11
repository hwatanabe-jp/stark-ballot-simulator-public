import type { ImmutableObjectReference } from './index.js';
import type { TerraformBackendAuthority } from './terraform-baseline.js';

export const MAX_REDACTED_TERRAFORM_ADDRESSES: 100;

export type TerraformDriftActionClass = 'create' | 'update' | 'replace' | 'delete' | 'read-only';
export type TerraformDriftResult = 'no-drift' | 'drift-detected' | 'check-failed';
export type TerraformDriftRoot = 'app' | 'bootstrap' | 'foundation';
export type TerraformDriftFailureStage =
  | 'baseline-selection'
  | 'baseline-admission'
  | 'source-checkout'
  | 'identity-admission'
  | 'provider-initialization'
  | 'runner-runtime'
  | 'terraform-plan'
  | 'plan-summary';

export interface TerraformDriftActionCounts {
  readonly create: number;
  readonly update: number;
  readonly replace: number;
  readonly delete: number;
  readonly readOnly: number;
}

export interface TerraformDriftAddress {
  readonly address: string;
  readonly actionClasses: readonly TerraformDriftActionClass[];
}

export interface TerraformDriftSummary {
  readonly actionCounts: TerraformDriftActionCounts;
  readonly addresses: readonly TerraformDriftAddress[];
  readonly omittedAddressCount: number;
}

export interface TerraformDriftIdentity {
  readonly accountId: string;
  readonly region: string;
  readonly root: TerraformDriftRoot;
  readonly stateIdentity: string;
  readonly backend: TerraformBackendAuthority;
  readonly controlSourceSha: string;
  readonly frameworkSourceSha: string;
  readonly context: ImmutableObjectReference;
  readonly inputManifest: ImmutableObjectReference;
  readonly providerEvidence: ImmutableObjectReference;
}

export interface TerraformDriftToolRuntime {
  readonly runnerSourceSha: string;
  readonly terraformVersion: string;
  readonly terraformPlanFormatVersion: string;
}

interface TerraformDriftEvidenceBase {
  readonly evidenceType: 'terraform-drift-report';
  readonly executionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly reportOnly: true;
}

export interface TerraformDriftSuccessfulEvidence extends TerraformDriftEvidenceBase {
  readonly baseline: ImmutableObjectReference;
  readonly observed: TerraformDriftIdentity;
  readonly result: 'no-drift' | 'drift-detected';
  readonly terraformDetailedExitCode: 0 | 2;
  readonly failureStage: null;
  readonly summary: TerraformDriftSummary;
  readonly toolRuntime: TerraformDriftToolRuntime;
}

export interface TerraformDriftFailedEvidence extends TerraformDriftEvidenceBase {
  readonly baseline: ImmutableObjectReference | null;
  readonly observed: TerraformDriftIdentity | null;
  readonly result: 'check-failed';
  readonly terraformDetailedExitCode: number | null;
  readonly failureStage: TerraformDriftFailureStage;
  readonly summary: null;
  readonly toolRuntime: TerraformDriftToolRuntime | null;
}

export type TerraformDriftEvidence = TerraformDriftSuccessfulEvidence | TerraformDriftFailedEvidence;

export interface TerraformDriftEvidenceInput {
  readonly baseline: ImmutableObjectReference | null;
  readonly expectedIdentity: TerraformDriftIdentity | null;
  readonly observed: TerraformDriftIdentity | null;
  readonly executionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly terraformDetailedExitCode: number | null;
  readonly failureStage: TerraformDriftFailureStage | null;
  readonly summary: TerraformDriftSummary | null;
  readonly toolRuntime: TerraformDriftToolRuntime | null;
}

export function classifyTerraformDetailedExitCode(value: unknown): TerraformDriftResult;
export function classifyTerraformActionSequence(value: unknown): TerraformDriftActionClass | null;
export function redactTerraformResourceAddress(value: unknown): string;
export function summarizeTerraformPlan(value: unknown): TerraformDriftSummary;
export function validateTerraformDriftSummary(value: unknown): TerraformDriftSummary;
export function buildTerraformDriftEvidence(value: unknown): TerraformDriftEvidence;
export function validateTerraformDriftEvidence(value: unknown): TerraformDriftEvidence;
