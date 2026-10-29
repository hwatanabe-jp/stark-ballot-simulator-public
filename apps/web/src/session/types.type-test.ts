import type { ApiSessionIdentity } from '../api/client';
import type { ClientFinalizationSnapshot } from '@stark-ballot/web/finalize/client-finalization-result';
import type { ServerIssuedSessionIdentity, SessionData } from './types';

function assertSessionEvidence(
  identity: ServerIssuedSessionIdentity,
  finalizeResult: ClientFinalizationSnapshot,
): void {
  const apiIdentity: ApiSessionIdentity = identity;
  const swapped: ApiSessionIdentity = {
    // @ts-expect-error A capability cannot be used in the session path.
    sessionId: identity.capabilityToken,
    // @ts-expect-error A session ID cannot be sent as a capability.
    capabilityToken: identity.sessionId,
  };
  void [apiIdentity, swapped];
  const base = { ...identity, phase: 'voting' as const, lastActivity: 0, expiresAt: 1 };
  const opening = { myVote: 'A' as const, myCommit: 'commitment', myRand: 'random' };
  const receipt = { voteId: 'vote-id', bulletinIndex: 0, bulletinRootAtCast: 'root' };

  // The two evidence groups are independently absent or complete.
  const empty: SessionData = base;
  const privateOnly: SessionData = { ...base, ...opening };
  const receiptOnly: SessionData = { ...base, ...receipt };
  const cast: SessionData = { ...base, ...opening, ...receipt };
  const finalizing: SessionData = { ...cast, phase: 'finalizing' };
  const verifying: SessionData = { ...cast, phase: 'verifying', finalizeResult };

  // @ts-expect-error A private opening requires the vote choice.
  const missingChoice: SessionData = { ...base, myCommit: 'commitment', myRand: 'random' };
  // @ts-expect-error A private opening requires the commitment.
  const missingCommitment: SessionData = { ...base, myVote: 'A', myRand: 'random' };
  // @ts-expect-error A private opening requires the random value.
  const missingRandom: SessionData = { ...base, myVote: 'A', myCommit: 'commitment' };
  // @ts-expect-error A cast receipt requires its vote identifier.
  const missingVoteId: SessionData = { ...base, bulletinIndex: 0, bulletinRootAtCast: 'root' };
  // @ts-expect-error A cast receipt requires its bulletin index.
  const missingIndex: SessionData = { ...base, voteId: 'vote-id', bulletinRootAtCast: 'root' };
  // @ts-expect-error A cast receipt requires its bulletin root.
  const missingRoot: SessionData = { ...base, voteId: 'vote-id', bulletinIndex: 0 };
  // @ts-expect-error A complete opening still requires a canonical vote choice.
  const unknownChoice: SessionData = { ...base, ...opening, myVote: 'Z' };
  // @ts-expect-error The verifying phase still requires a finalization snapshot.
  const missingFinalization: SessionData = { ...cast, phase: 'verifying' };
  // @ts-expect-error An active phase must not carry a finalization snapshot.
  const prematureFinalization: SessionData = { ...base, finalizeResult };

  void [
    empty,
    privateOnly,
    receiptOnly,
    cast,
    finalizing,
    verifying,
    missingChoice,
    missingCommitment,
    missingRandom,
    missingVoteId,
    missingIndex,
    missingRoot,
    unknownChoice,
    missingFinalization,
    prematureFinalization,
  ];
}

void assertSessionEvidence;
