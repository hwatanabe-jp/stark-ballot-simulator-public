import type { VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';

export const VERIFICATION_EVIDENCE_VALUES = ['local', 'public', 'zk', 'demo'] as const;
export type VerificationEvidence = (typeof VERIFICATION_EVIDENCE_VALUES)[number];

export const VERIFICATION_CHECK_ROLE_VALUES = [
  'proof_verification',
  'cast_receipt_integrity',
  'recorded_inclusion',
  'recorded_append_only',
  'tally_input_integrity',
  'tally_completeness',
  'user_inclusion',
  'tally_consistency',
  'optional_external_audit',
] as const;
export type VerificationCheckRole = (typeof VERIFICATION_CHECK_ROLE_VALUES)[number];

export const VERIFICATION_CHECK_CRITICALITY_VALUES = ['required', 'optional'] as const;
export type VerificationCheckCriticality = (typeof VERIFICATION_CHECK_CRITICALITY_VALUES)[number];

export const VERIFICATION_CHECK_IDS = [
  'cast_receipt_present',
  'cast_choice_range',
  'cast_random_format',
  'cast_commitment_match',
  'recorded_commitment_in_bulletin',
  'recorded_index_in_range',
  'recorded_root_at_cast_consistent',
  'recorded_inclusion_proof',
  'recorded_consistency_proof',
  'recorded_sth_third_party',
  'counted_input_sanity',
  'counted_unique_indices',
  'counted_unique_commitments',
  'counted_tally_consistent',
  'counted_missing_indices_zero',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'counted_my_vote_included',
  'counted_input_commitment_match',
  'stark_image_id_match',
  'stark_receipt_verify',
] as const;
export type VerificationCheckId = (typeof VERIFICATION_CHECK_IDS)[number];

export interface VerificationCheck {
  id: VerificationCheckId;
  status: VerificationStepStatus;
  evidence: VerificationEvidence;
  inputs: string[];
  noteKey?: string;
  derivedFrom?: VerificationCheckId;
}

export interface VerificationCheckDefinition {
  id: VerificationCheckId;
  category: VerificationStepId;
  evidence: VerificationEvidence;
  inputs: string[];
  role: VerificationCheckRole;
  criticality: VerificationCheckCriticality;
  derivedFrom?: VerificationCheckId;
}

export interface VerificationCheckRequirementContext {
  sthSourcesConfigured?: boolean;
}

export const VERIFICATION_CHECK_DEFINITIONS: VerificationCheckDefinition[] = [
  {
    id: 'cast_receipt_present',
    category: 'cast_as_intended',
    evidence: 'local',
    inputs: ['user.voteId', 'user.commitment'],
    role: 'cast_receipt_integrity',
    criticality: 'required',
  },
  {
    id: 'cast_choice_range',
    category: 'cast_as_intended',
    evidence: 'local',
    inputs: ['user.choice'],
    role: 'cast_receipt_integrity',
    criticality: 'required',
  },
  {
    id: 'cast_random_format',
    category: 'cast_as_intended',
    evidence: 'local',
    inputs: ['user.random'],
    role: 'cast_receipt_integrity',
    criticality: 'required',
  },
  {
    id: 'cast_commitment_match',
    category: 'cast_as_intended',
    evidence: 'local',
    inputs: ['electionId', 'user.choice', 'user.random', 'user.commitment'],
    role: 'cast_receipt_integrity',
    criticality: 'required',
  },
  {
    id: 'recorded_commitment_in_bulletin',
    category: 'recorded_as_cast',
    evidence: 'public',
    inputs: ['user.commitment', 'user.voteReceipt', 'user.merklePath'],
    role: 'recorded_inclusion',
    criticality: 'optional',
    derivedFrom: 'recorded_inclusion_proof',
  },
  {
    id: 'recorded_index_in_range',
    category: 'recorded_as_cast',
    evidence: 'public',
    inputs: ['user.voteReceipt', 'treeSize'],
    role: 'recorded_inclusion',
    criticality: 'required',
  },
  {
    id: 'recorded_root_at_cast_consistent',
    category: 'recorded_as_cast',
    evidence: 'public',
    inputs: ['user.voteReceipt', 'user.merklePath', 'bulletinRoot', 'treeSize'],
    role: 'recorded_append_only',
    criticality: 'optional',
    derivedFrom: 'recorded_consistency_proof',
  },
  {
    id: 'recorded_inclusion_proof',
    category: 'recorded_as_cast',
    evidence: 'public',
    inputs: ['user.commitment', 'user.voteReceipt', 'user.merklePath'],
    role: 'recorded_inclusion',
    criticality: 'required',
  },
  {
    id: 'recorded_consistency_proof',
    category: 'recorded_as_cast',
    evidence: 'public',
    inputs: ['user.voteReceipt', 'user.merklePath', 'bulletinRoot', 'treeSize'],
    role: 'recorded_append_only',
    criticality: 'required',
  },
  {
    id: 'recorded_sth_third_party',
    category: 'recorded_as_cast',
    evidence: 'public',
    inputs: ['sthDigest'],
    role: 'optional_external_audit',
    criticality: 'optional',
  },
  {
    id: 'counted_input_sanity',
    category: 'counted_as_recorded',
    evidence: 'public',
    inputs: ['proofBundleStatus', 'bulletinRoot', 'treeSize'],
    role: 'tally_input_integrity',
    criticality: 'required',
  },
  {
    id: 'counted_unique_indices',
    category: 'counted_as_recorded',
    evidence: 'public',
    inputs: ['proofBundleStatus'],
    role: 'tally_input_integrity',
    criticality: 'required',
  },
  {
    id: 'counted_unique_commitments',
    category: 'counted_as_recorded',
    evidence: 'public',
    inputs: ['proofBundleStatus'],
    role: 'tally_input_integrity',
    criticality: 'required',
  },
  {
    id: 'counted_tally_consistent',
    category: 'counted_as_recorded',
    evidence: 'zk',
    inputs: ['tally.counts', 'tally.totalVotes'],
    role: 'tally_consistency',
    criticality: 'required',
  },
  {
    id: 'counted_missing_indices_zero',
    category: 'counted_as_recorded',
    evidence: 'zk',
    inputs: ['missingSlots', 'invalidPresentedSlots'],
    role: 'tally_completeness',
    criticality: 'required',
  },
  {
    id: 'counted_expected_vs_tree_size',
    category: 'counted_as_recorded',
    evidence: 'zk',
    inputs: ['totalExpected', 'treeSize'],
    role: 'tally_input_integrity',
    criticality: 'required',
  },
  {
    id: 'counted_election_manifest_consistent',
    category: 'counted_as_recorded',
    evidence: 'public',
    inputs: ['electionManifest', 'electionId', 'electionConfigHash', 'proofBundleStatus'],
    role: 'tally_input_integrity',
    criticality: 'required',
  },
  {
    id: 'counted_close_statement_consistent',
    category: 'counted_as_recorded',
    evidence: 'public',
    inputs: ['closeStatement', 'logId', 'timestamp', 'sthDigest', 'bulletinRoot', 'treeSize'],
    role: 'tally_input_integrity',
    criticality: 'required',
  },
  {
    id: 'counted_my_vote_included',
    category: 'counted_as_recorded',
    evidence: 'zk',
    inputs: ['includedBitmapRoot', 'user.voteReceipt'],
    role: 'user_inclusion',
    criticality: 'required',
  },
  {
    id: 'counted_input_commitment_match',
    category: 'counted_as_recorded',
    evidence: 'public',
    inputs: ['proofBundleStatus', 'inputCommitment'],
    role: 'tally_input_integrity',
    criticality: 'required',
  },
  {
    id: 'stark_image_id_match',
    category: 'stark_verification',
    evidence: 'zk',
    inputs: ['imageId'],
    role: 'proof_verification',
    criticality: 'required',
  },
  {
    id: 'stark_receipt_verify',
    category: 'stark_verification',
    evidence: 'zk',
    inputs: ['proofBundleStatus'],
    role: 'proof_verification',
    criticality: 'required',
  },
];

const CHECK_DEFINITIONS_BY_STEP = VERIFICATION_CHECK_DEFINITIONS.reduce<
  Record<VerificationStepId, VerificationCheckDefinition[]>
>(
  (accumulator, definition) => {
    accumulator[definition.category].push(definition);
    return accumulator;
  },
  {
    cast_as_intended: [],
    recorded_as_cast: [],
    counted_as_recorded: [],
    stark_verification: [],
  },
);

export function isVerificationCheckRequired(
  definition: VerificationCheckDefinition,
  context?: VerificationCheckRequirementContext,
): boolean {
  if (definition.criticality === 'required') {
    return true;
  }

  if (definition.role === 'optional_external_audit') {
    return Boolean(context?.sthSourcesConfigured);
  }

  return false;
}

export function getVerificationAllCheckDefinitionsForStep(stepId: VerificationStepId): VerificationCheckDefinition[] {
  return [...CHECK_DEFINITIONS_BY_STEP[stepId]];
}

export function getVerificationRequiredCheckDefinitionsForStep(
  stepId: VerificationStepId,
  context?: VerificationCheckRequirementContext,
): VerificationCheckDefinition[] {
  return getVerificationAllCheckDefinitionsForStep(stepId).filter((definition) =>
    isVerificationCheckRequired(definition, context),
  );
}

export function getVerificationRequiredCheckIdsForStep(
  stepId: VerificationStepId,
  context?: VerificationCheckRequirementContext,
): VerificationCheckId[] {
  return getVerificationRequiredCheckDefinitionsForStep(stepId, context).map((definition) => definition.id);
}

export function getVerificationStepInputs(stepId: VerificationStepId): string[] {
  const seen = new Set<string>();
  const inputs: string[] = [];

  for (const definition of getVerificationAllCheckDefinitionsForStep(stepId)) {
    for (const input of definition.inputs) {
      if (seen.has(input)) {
        continue;
      }
      seen.add(input);
      inputs.push(input);
    }
  }

  return inputs;
}
