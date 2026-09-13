import type {
  AdmittedEvidence,
  CheckResult,
  VerificationCheckContext,
  VerificationCheckContextCoverage,
  VerificationEvaluationInput,
  VerificationOutcomeInput,
  VerificationReportEvidence,
} from './types';
import type { VerificationReport, VerificationResult } from '@stark-ballot/verification/shared/types';

const successfulCheck = { status: 'success' } satisfies CheckResult;
const failedCheck = {
  status: 'failed',
  error: 'evidence mismatch',
} satisfies CheckResult;
const unavailableCheck = {
  status: 'not_run',
  noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable',
} satisfies CheckResult;

void successfulCheck;
void failedCheck;
void unavailableCheck;

// @ts-expect-error Successful checks cannot carry failure diagnostics.
const successWithError = { status: 'success', error: 'contradiction' } satisfies CheckResult;
const pendingWithNote = {
  status: 'pending',
  // @ts-expect-error Pending checks cannot carry a terminal note.
  noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable',
} satisfies CheckResult;
// @ts-expect-error Failure diagnostics are strings, not open detail bags.
const failureWithDetails = { status: 'failed', details: { reason: 'open' } } satisfies CheckResult;

void successWithError;
void pendingWithNote;
void failureWithDetails;

const inferredSuccessWithError = { status: 'success' as const, error: 'contradiction' };
// @ts-expect-error Failure diagnostics remain forbidden after passing through a variable.
const assignedSuccessWithError: CheckResult = inferredSuccessWithError;
// @ts-expect-error Spreading inferred diagnostics cannot recreate an invalid successful result.
const spreadSuccessWithError: CheckResult = { ...inferredSuccessWithError };
const inferredPendingWithNote = {
  status: 'pending' as const,
  noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable' as const,
};
// @ts-expect-error Pending results cannot retain a terminal note through a variable.
const assignedPendingWithNote: CheckResult = inferredPendingWithNote;
const inferredNotRunWithError = { status: 'not_run' as const, error: 'contradiction' };
// @ts-expect-error Unavailable results cannot retain terminal failure diagnostics.
const assignedNotRunWithError: CheckResult = inferredNotRunWithError;

void assignedSuccessWithError;
void spreadSuccessWithError;
void assignedPendingWithNote;
void assignedNotRunWithError;

const admittedSuccessReport = {
  status: 'success',
  dev_mode_receipt: false,
} satisfies VerificationReportEvidence;
const comparisonOnlyReport = {
  expected_image_id: `0x${'1'.repeat(64)}`,
  receipt_image_id: `0x${'2'.repeat(64)}`,
} satisfies VerificationReportEvidence;
const fixedTallyContext = {
  verifiedTally: [1, 0, 0, 0, 0],
} satisfies VerificationEvaluationInput;

void admittedSuccessReport;
void comparisonOnlyReport;
void fixedTallyContext;

// @ts-expect-error Successful verifier evidence cannot be marked as a development receipt.
const incoherentSuccessReport = { status: 'success', dev_mode_receipt: true } satisfies VerificationReportEvidence;
// @ts-expect-error The admitted tally has exactly one slot for every public choice.
const shortTallyContext = { verifiedTally: [1, 0, 0] } satisfies VerificationEvaluationInput;

void incoherentSuccessReport;
void shortTallyContext;

const unavailableEvidence = { availability: 'unavailable' } satisfies AdmittedEvidence<string>;
const availableEvidence = { availability: 'available', value: 'election-1' } satisfies AdmittedEvidence<string>;
const statusOnlySyntheticOutcome = { status: 'success' } satisfies VerificationOutcomeInput;
const coherentReportedOutcome = {
  status: 'success',
  report: { status: 'success', dev_mode_receipt: false },
  failureCategory: 'none',
} satisfies VerificationOutcomeInput;
const exactIndexContext = {
  voteReceipt: undefined,
  treeSize: undefined,
} satisfies VerificationCheckContext<'recorded_index_in_range'>;
const completeCheckContextMap: VerificationCheckContextCoverage = true;

void unavailableEvidence;
void availableEvidence;
void statusOnlySyntheticOutcome;
void coherentReportedOutcome;
void exactIndexContext;
void completeCheckContextMap;

// @ts-expect-error Unavailable evidence cannot carry a value.
const unavailableWithValue = { availability: 'unavailable', value: 'contradiction' } satisfies AdmittedEvidence<string>;
const inferredUnavailableWithValue = { availability: 'unavailable' as const, value: 'contradiction' };
// @ts-expect-error Unavailable evidence cannot retain a value through structural assignment.
const assignedUnavailableWithValue: AdmittedEvidence<string> = inferredUnavailableWithValue;
// @ts-expect-error Spreading an inferred object cannot attach a value to unavailable evidence.
const spreadUnavailableWithValue: AdmittedEvidence<string> = { ...inferredUnavailableWithValue };
void assignedUnavailableWithValue;
void spreadUnavailableWithValue;
declare function acceptVerifierOutcome(outcome: VerificationOutcomeInput): void;
declare function acceptVerificationEvaluation(input: VerificationEvaluationInput): void;
declare function acceptVerificationResult(result: VerificationResult): void;
declare const failedVerifierReport: Extract<VerificationReport, { status: 'failed' }>;
declare const successfulVerifierReport: Extract<VerificationReport, { status: 'success' }>;

// @ts-expect-error A successful outcome cannot carry a failed report.
acceptVerifierOutcome({ status: 'success', report: { status: 'failed', dev_mode_receipt: false } });
// @ts-expect-error Successful outcomes cannot carry an infrastructure failure category.
acceptVerifierOutcome({ status: 'success', failureCategory: 'verifier_crash' });
// @ts-expect-error Failed outcomes cannot carry the no-failure category.
acceptVerifierOutcome({ status: 'failed', failureCategory: 'none' });
// @ts-expect-error Nonterminal outcomes cannot carry terminal verifier reports.
acceptVerifierOutcome({ status: 'running', report: { status: 'success', dev_mode_receipt: false } });
// @ts-expect-error The retired independent status fields cannot recreate a contradictory context.
acceptVerificationEvaluation({ verificationStatus: 'success' });
// @ts-expect-error Shared successful results cannot carry a failed verifier report.
acceptVerificationResult({ status: 'success', report: failedVerifierReport });
// @ts-expect-error Shared nonterminal results cannot carry a terminal verifier report.
acceptVerificationResult({ status: 'running', report: successfulVerifierReport });
// @ts-expect-error Shared successful results cannot carry an infrastructure failure category.
acceptVerificationResult({ status: 'success', failureCategory: 'timeout' });
// @ts-expect-error Shared failed results cannot carry the no-failure category.
acceptVerificationResult({ status: 'failed', failureCategory: 'none' });
const overbroadIndexContext = {
  voteReceipt: undefined,
  treeSize: undefined,
  // @ts-expect-error The index-range evaluator cannot receive unrelated journal evidence.
  journal: undefined,
} satisfies VerificationCheckContext<'recorded_index_in_range'>;

void unavailableWithValue;
void overbroadIndexContext;
