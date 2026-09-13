import type { VerificationStepId, VerificationStepStatus } from './step-types';

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

export const VERIFICATION_CHECK_NOTE_KEY_VALUES = [
  'pages.verify.stepsCard.notes.myVoteIncluded.notPresented',
  'pages.verify.stepsCard.notes.myVoteIncluded.presentedButInvalid',
  'pages.verify.stepsCard.notes.myVoteIncluded.excluded',
  'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt',
  'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable',
] as const;
export type VerificationCheckNoteKey = (typeof VERIFICATION_CHECK_NOTE_KEY_VALUES)[number];

interface VerificationCheckBase {
  id: VerificationCheckId;
  evidence: VerificationEvidence;
  inputs: string[];
  derivedFrom?: VerificationCheckId;
}

export type VerificationCheck = VerificationCheckBase &
  (
    | { status: VerificationStepStatus; noteKey?: never }
    | {
        status: Extract<VerificationStepStatus, 'failed' | 'not_run'>;
        noteKey: VerificationCheckNoteKey;
      }
  );

export interface VerificationCheckDefinition {
  readonly id: VerificationCheckId;
  readonly category: VerificationStepId;
  readonly evidence: VerificationEvidence;
  readonly inputs: readonly string[];
  readonly role: VerificationCheckRole;
  readonly criticality: VerificationCheckCriticality;
  readonly derivedFrom?: VerificationCheckId;
}

export interface VerificationCheckRequirementContext {
  sthSourcesConfigured?: boolean;
}

interface VerificationCheckDefinitionSource {
  id: string;
  category: VerificationStepId;
  evidence: VerificationEvidence;
  inputs: readonly string[];
  role: VerificationCheckRole;
  criticality: VerificationCheckCriticality;
  derivedFrom?: string;
}

const VERIFICATION_CHECK_DEFINITION_SOURCE = [
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
] as const satisfies readonly VerificationCheckDefinitionSource[];

export type VerificationCheckId = (typeof VERIFICATION_CHECK_DEFINITION_SOURCE)[number]['id'];

export const VERIFICATION_CHECK_IDS: readonly VerificationCheckId[] = Object.freeze(
  VERIFICATION_CHECK_DEFINITION_SOURCE.map((definition) => definition.id),
);

export const VERIFICATION_CHECK_DEFINITIONS: readonly VerificationCheckDefinition[] = Object.freeze(
  VERIFICATION_CHECK_DEFINITION_SOURCE.map((definition) =>
    Object.freeze({
      ...definition,
      inputs: Object.freeze([...definition.inputs]),
    }),
  ),
);

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

export function getVerificationAllCheckDefinitionsForStep(
  stepId: VerificationStepId,
): readonly VerificationCheckDefinition[] {
  return [...CHECK_DEFINITIONS_BY_STEP[stepId]];
}

export function getVerificationRequiredCheckDefinitionsForStep(
  stepId: VerificationStepId,
  context?: VerificationCheckRequirementContext,
): readonly VerificationCheckDefinition[] {
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
