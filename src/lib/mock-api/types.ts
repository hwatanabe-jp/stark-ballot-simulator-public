import type { VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';

export type ScenarioId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

export interface MockVerificationStep {
  id: VerificationStepId;
  status: VerificationStepStatus;
  inputs?: string[];
  error?: string;
}
