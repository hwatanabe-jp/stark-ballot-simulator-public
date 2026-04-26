import type { Receipt, VoteData, TamperDetectionResult } from './types';
import { verifyCTMerkleInclusion } from './merkle';
import type { VoteChoice } from '@/shared/constants';
import { VOTE_CHOICES } from '@/shared/constants';

/**
 * zkVM ジャーナルが持つ統計値とクライアント側の vote data を付き合わせ、
 * 教育用 tamper シナリオ (S1-S5) を推定する。claimed tally と verified tally の差分、
 * さらに missing/invalid 指標を組み合わせて複数パターンを判断する。
 */

export interface TamperDetectionContext {
  expectedTotalVotes?: number;
  scenarios?: string[];
}

/**
 * Detect tampering in vote results by analyzing receipt and user vote data
 */
export async function detectTampering(
  receipt: Receipt,
  userVote: VoteData,
  context?: TamperDetectionContext,
): Promise<TamperDetectionResult> {
  // Check user vote inclusion
  const isUserVoteIncluded = await checkUserVoteInclusion(userVote, receipt.bulletinRoot);

  const invalidPresentedSlots = receipt.invalidPresentedSlots ?? 0;
  const missingSlots = receipt.missingSlots ?? 0;
  const validVotes = receipt.validVotes ?? 0;
  const indexAnomaly = detectIndexAnomaly(receipt);

  // Detect all tamper scenarios
  const scenarios = {
    ignoreUserVote: detectIgnoreUserVote(isUserVoteIncluded, receipt),
    recountUserAsOther: detectRecountUserAsOther(isUserVoteIncluded, receipt, userVote),
    ignoreBotVotes: detectIgnoreBotVotes(receipt, {
      expectedTotalVotes: context?.expectedTotalVotes,
      userVoteIgnored: !isUserVoteIncluded,
      scenarios: context?.scenarios,
    }),
    recountBotVotes: detectRecountBotVotes(receipt, userVote),
    randomErrors: detectRandomErrors(receipt),
  };

  // Build result
  return buildTamperDetectionResult(scenarios, receipt, {
    indexAnomaly,
    invalidPresentedSlots,
    missingSlots,
    validVotes,
  });
}

async function checkUserVoteInclusion(userVote: VoteData, bulletinRoot: string): Promise<boolean> {
  if (typeof userVote.treeSize !== 'number' || userVote.treeSize <= 0) {
    return false;
  }

  try {
    const ctIncluded = await Promise.resolve(
      verifyCTMerkleInclusion(userVote.commitment, userVote.path, userVote.leafIndex, bulletinRoot, userVote.treeSize),
    );

    return ctIncluded;
  } catch (error) {
    console.warn('[TamperDetection] CT inclusion verification failed:', error);
    return false;
  }
}

function detectIgnoreUserVote(isUserVoteIncluded: boolean, receipt: Receipt): boolean {
  return !isUserVoteIncluded && receipt.tamperedCount > 0;
}

/**
 * ユーザー票が別候補に再集計されたと推定できるかを判定する。
 * claimed tally と verified tally の差分だけを根拠に判定し、
 * proof/journal 側の exclusion 指標は再集計シナリオの根拠に使わない。
 */
function detectRecountUserAsOther(
  isUserVoteIncluded: boolean,
  receipt: Receipt,
  userVote: VoteData,
): { detected: boolean; recountedTo?: VoteChoice } {
  if (!isUserVoteIncluded || receipt.totalVotes === 0) {
    return { detected: false };
  }

  const verifiedTally = getVerifiedTally(receipt);
  if (!verifiedTally) {
    return { detected: false };
  }

  const userIndex = VOTE_CHOICES.indexOf(userVote.choice);
  if (userIndex < 0) {
    return { detected: false };
  }

  const verifiedCount = getVerifiedTallyCount(verifiedTally, userIndex);
  const claimedCount = getTallyCount(receipt, userVote.choice);
  if (claimedCount >= verifiedCount) {
    return { detected: false };
  }

  return {
    detected: true,
    recountedTo: inferRecountTargetFromDiff(receipt, verifiedTally, userVote.choice),
  };
}

function detectIgnoreBotVotes(
  receipt: Receipt,
  options: { expectedTotalVotes?: number; userVoteIgnored: boolean; scenarios?: string[] },
): { detected: boolean; ignoredCount?: number } {
  const missingSlots = receipt.missingSlots;
  if (typeof missingSlots === 'number') {
    const adjustedMissingSlots = Math.max(0, missingSlots - (options.userVoteIgnored ? 1 : 0));
    if (adjustedMissingSlots > 0) {
      return { detected: true, ignoredCount: adjustedMissingSlots };
    }

    return { detected: false };
  }

  const expectedTotalVotes =
    options.expectedTotalVotes !== undefined
      ? options.expectedTotalVotes
      : receipt.totalVotes + Math.max(receipt.tamperedCount, 0);

  // `receipt.totalVotes` is a claimed tally total projection. Only use it as a
  // fallback when the proof-bound slot omission signal is unavailable.
  const missingVotes = Math.max(0, expectedTotalVotes - receipt.totalVotes);
  const adjustedMissing = Math.max(0, missingVotes - (options.userVoteIgnored ? 1 : 0));

  if (adjustedMissing > 0) {
    return { detected: true, ignoredCount: adjustedMissing };
  }

  if (options.scenarios?.includes('S3')) {
    return { detected: true, ignoredCount: receipt.tamperedCount > 0 ? receipt.tamperedCount : undefined };
  }

  return { detected: false };
}

/**
 * claimed/verified 差分からボット票再集計 (S4) を検出する。
 */
function detectRecountBotVotes(receipt: Receipt, userVote: VoteData): boolean {
  if (receipt.botTamperInfo) {
    return true;
  }

  const verifiedTally = getVerifiedTally(receipt);
  if (!verifiedTally) {
    return false;
  }

  let positiveDiff = 0;
  for (const [index, choice] of VOTE_CHOICES.entries()) {
    const claimed = getTallyCount(receipt, choice);
    const verified = getVerifiedTallyCount(verifiedTally, index);
    if (claimed > verified) {
      positiveDiff += claimed - verified;
    }
  }

  if (positiveDiff <= 0) {
    return false;
  }

  const userIndex = VOTE_CHOICES.indexOf(userVote.choice);
  if (userIndex < 0) {
    return true;
  }

  const userShortfall = Math.max(
    0,
    getVerifiedTallyCount(verifiedTally, userIndex) - getTallyCount(receipt, userVote.choice),
  );
  return positiveDiff > userShortfall;
}

function detectIndexAnomaly(receipt: Receipt): boolean {
  if ((receipt.rejectedRecords ?? 0) > 0) {
    return true;
  }

  if ((receipt.invalidPresentedSlots ?? 0) > 0) {
    return true;
  }

  if ((receipt.missingSlots ?? 0) > 0) {
    return true;
  }

  if ((receipt.excludedSlots ?? receipt.tamperedCount) > 0) {
    return true;
  }

  return false;
}

function getTallyCount(receipt: Receipt, choice: VoteChoice): number {
  const value = receipt.tally[choice];
  return Number.isFinite(value) ? value : 0;
}

/**
 * claimed tally と verified tally の差分から再集計先候補を推定する。
 * 正の差分が最大の候補を返し、差分が存在しない場合は undefined。
 */
function inferRecountTargetFromDiff(
  receipt: Receipt,
  verifiedTally: number[],
  userChoice: VoteChoice,
): VoteChoice | undefined {
  let bestChoice: VoteChoice | undefined;
  let bestDiff = 0;

  for (const [index, choice] of VOTE_CHOICES.entries()) {
    if (choice === userChoice) {
      continue;
    }
    const claimed = getTallyCount(receipt, choice);
    const verified = getVerifiedTallyCount(verifiedTally, index);
    const diff = claimed - verified;
    if (diff > bestDiff) {
      bestDiff = diff;
      bestChoice = choice;
    }
  }

  if (bestChoice && bestDiff > 0) {
    return bestChoice;
  }

  return undefined;
}

function detectRandomErrors(receipt: Receipt): boolean {
  return !!receipt.randomError;
}

function buildTamperDetectionResult(
  scenarios: {
    ignoreUserVote: boolean;
    recountUserAsOther: { detected: boolean; recountedTo?: VoteChoice };
    ignoreBotVotes: { detected: boolean; ignoredCount?: number };
    recountBotVotes: boolean;
    randomErrors: boolean;
  },
  receipt: Receipt,
  metadata: {
    indexAnomaly: boolean;
    invalidPresentedSlots: number;
    missingSlots: number;
    validVotes: number;
  },
): TamperDetectionResult {
  const detectedScenarios: string[] = [];
  const details: TamperDetectionResult['details'] = {
    ignoreUserVote: false,
    recountUserAsOther: false,
    ignoreBotVotes: false,
    recountBotVotes: false,
    randomErrors: false,
    indexAnomaly: false,
  };

  if (scenarios.ignoreUserVote) {
    detectedScenarios.push('ignoreUserVote');
    details.ignoreUserVote = true;
  }

  if (scenarios.recountUserAsOther.detected) {
    detectedScenarios.push('recountUserAsOther');
    details.recountUserAsOther = true;
    details.recountedTo = scenarios.recountUserAsOther.recountedTo;
  }

  if (scenarios.ignoreBotVotes.detected) {
    detectedScenarios.push('ignoreBotVotes');
    details.ignoreBotVotes = true;
    details.ignoredBotCount = scenarios.ignoreBotVotes.ignoredCount;
  }

  if (scenarios.recountBotVotes) {
    detectedScenarios.push('recountBotVotes');
    details.recountBotVotes = true;
    details.recountedBotInfo = receipt.botTamperInfo;
  }

  if (scenarios.randomErrors) {
    detectedScenarios.push('randomErrors');
    details.randomErrors = true;
  }

  if (metadata.invalidPresentedSlots > 0) {
    details.invalidPresentedSlotsCount = metadata.invalidPresentedSlots;
  }

  if (metadata.missingSlots > 0) {
    details.missingSlotsCount = metadata.missingSlots;
  }

  if (metadata.validVotes > 0) {
    details.validVotesCount = metadata.validVotes;
  }

  if (metadata.indexAnomaly) {
    details.indexAnomaly = true;
  }

  if (detectedScenarios.length === 0 && metadata.indexAnomaly) {
    detectedScenarios.push('indexAnomaly');
  }

  return {
    isTampered: detectedScenarios.length > 0,
    detectedScenarios,
    details,
  };
}

/**
 * receipt から verified tally を取得。配列長の不足や不在時は undefined を返す。
 */
function getVerifiedTally(receipt: Receipt): number[] | undefined {
  if (!Array.isArray(receipt.verifiedTally)) {
    return undefined;
  }
  if (receipt.verifiedTally.length < VOTE_CHOICES.length) {
    return undefined;
  }
  return receipt.verifiedTally;
}

function getVerifiedTallyCount(verifiedTally: number[], index: number): number {
  const value = verifiedTally[index];
  return Number.isFinite(value) ? value : 0;
}
