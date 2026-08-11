import type { AvailableVerificationResource } from '@stark-ballot/api-contract/schemas/verification';
import type { SessionData } from '@stark-ballot/web/session/types';
import {
  evaluateLocalCastChecks,
  overlayLocalCastChecks,
  type LocalCastCheckResults,
} from '@stark-ballot/verification/local-cast-checks';
import type { VerificationCheck } from '@stark-ballot/verification/checks';
import type { VoteReceipt } from '@stark-ballot/verification/shared/types';

export interface BrowserLocalCastEvidence {
  checks: VerificationCheck[];
  results: LocalCastCheckResults;
  voteReceipt?: VoteReceipt;
}

function projectVoteReceipt(resource: AvailableVerificationResource): VoteReceipt | undefined {
  if (resource.voterEvidence.availability !== 'available') {
    return undefined;
  }
  const receipt = resource.voterEvidence.voteReceipt;
  return {
    voteId: receipt.voteId,
    commitment: receipt.commitment,
    bulletinIndex: receipt.bulletinIndex,
    bulletinRootAtCast: receipt.bulletinRootAtCast,
    timestamp: receipt.castAtMs,
    ...(receipt.inputCommitment ? { inputCommitment: receipt.inputCommitment } : {}),
  };
}

export function evaluateBrowserLocalCastEvidence(
  resource: AvailableVerificationResource,
  session: SessionData | null,
): BrowserLocalCastEvidence | null {
  const voteReceipt = projectVoteReceipt(resource);
  const results = evaluateLocalCastChecks({
    ...(session?.electionId ? { electionId: session.electionId } : {}),
    ...(session?.myVote ? { choice: session.myVote } : {}),
    ...(session?.myRand ? { random: session.myRand } : {}),
    ...(voteReceipt ? { voteReceipt } : {}),
  });
  const serverChecks: VerificationCheck[] = resource.verification.checks.map((check) => ({
    id: check.id,
    status: check.status,
    evidence: check.evidence,
    inputs: [...check.inputs],
    ...(check.noteKey ? { noteKey: check.noteKey } : {}),
    ...(check.derivedFrom ? { derivedFrom: check.derivedFrom } : {}),
  }));
  const checks = overlayLocalCastChecks(serverChecks, results);
  if (!checks) {
    return null;
  }
  return {
    checks,
    results,
    ...(voteReceipt ? { voteReceipt } : {}),
  };
}
