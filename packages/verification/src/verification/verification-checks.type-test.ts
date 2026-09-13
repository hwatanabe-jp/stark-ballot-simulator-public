import {
  VERIFICATION_CHECK_DEFINITIONS,
  getVerificationAllCheckDefinitionsForStep,
  type VerificationCheck,
} from './verification-checks';

const definitions = getVerificationAllCheckDefinitionsForStep('cast_as_intended');
const definition = definitions[0];
if (definition) {
  // @ts-expect-error Callers cannot disable a required verification check.
  definition.criticality = 'optional';
  // @ts-expect-error A definition's input bindings are immutable authority.
  definition.inputs[0] = 'unrelated';
}
// @ts-expect-error Consumers cannot remove definitions from the shared registry.
VERIFICATION_CHECK_DEFINITIONS.length = 0;
// @ts-expect-error Step projections are readonly views of the definition inventory.
definitions.length = 0;

const successfulCheck = {
  id: 'stark_receipt_verify',
  status: 'success',
  evidence: 'zk',
  inputs: ['proofBundleStatus'],
} satisfies VerificationCheck;

const unavailableCheck = {
  id: 'counted_my_vote_included',
  status: 'not_run',
  evidence: 'zk',
  inputs: ['includedBitmapRoot', 'user.voteReceipt'],
  noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable',
} satisfies VerificationCheck;

void successfulCheck;
void unavailableCheck;

const contradictoryCheck = {
  id: 'stark_receipt_verify',
  status: 'success',
  evidence: 'zk',
  inputs: ['proofBundleStatus'],
  // @ts-expect-error A successful public check cannot carry an unavailable-evidence note.
  noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable',
} satisfies VerificationCheck;

void contradictoryCheck;
