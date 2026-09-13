import { BOT_COUNT, VOTE_CHOICES, type VoteChoice } from '@stark-ballot/verification/shared/constants';
import { resolveFinalizationTamperDetected, resolveScenarioTamperCount } from './finalization-tamper';

interface PublicTamperSummaryProjection {
  readonly ignoredVotes: number;
  readonly recountedVotes: number;
  readonly userRecountedTo: VoteChoice | null;
  readonly affectedBotIds?: readonly number[] | undefined;
}

interface PublicBotVotesSummaryProjection {
  readonly total?: number | undefined;
  readonly affectedBotIds?: readonly number[] | undefined;
  readonly source: string;
}

function hasExactNumberSequence(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasCanonicalAffectedBotIds(ids: readonly number[]): boolean {
  return ids.every((id) => Number.isSafeInteger(id) && id >= 1 && id <= BOT_COUNT) && new Set(ids).size === ids.length;
}

function hasCanonicalScenarioTamperSummary(input: {
  readonly scenarioId: string;
  readonly excludedSlots: number;
  readonly tamperSummary?: PublicTamperSummaryProjection | undefined;
}): boolean {
  const summary = input.tamperSummary;
  if (summary === undefined) {
    return input.scenarioId === 'S0';
  }
  const affectedBotIds = summary.affectedBotIds ?? [];
  if (!hasCanonicalAffectedBotIds(affectedBotIds)) {
    return false;
  }

  switch (input.scenarioId) {
    case 'S0':
      return (
        summary.ignoredVotes === 0 &&
        summary.recountedVotes === 0 &&
        summary.userRecountedTo === null &&
        affectedBotIds.length === 0
      );
    case 'S1':
      return (
        summary.ignoredVotes === 1 &&
        summary.ignoredVotes === input.excludedSlots &&
        summary.recountedVotes === 0 &&
        summary.userRecountedTo === null &&
        affectedBotIds.length === 0
      );
    case 'S2':
      return (
        summary.ignoredVotes === 0 &&
        summary.recountedVotes === 1 &&
        summary.userRecountedTo !== null &&
        affectedBotIds.length === 0
      );
    case 'S3':
      return (
        summary.ignoredVotes === 1 &&
        summary.ignoredVotes === input.excludedSlots &&
        summary.recountedVotes === 0 &&
        summary.userRecountedTo === null &&
        affectedBotIds.length === 1
      );
    case 'S4':
      return (
        summary.ignoredVotes === 0 &&
        summary.recountedVotes === 1 &&
        summary.userRecountedTo === null &&
        affectedBotIds.length === 1
      );
    case 'S5':
      return (
        summary.ignoredVotes > 0 &&
        summary.ignoredVotes === input.excludedSlots &&
        summary.recountedVotes === 0 &&
        summary.userRecountedTo === null &&
        affectedBotIds.length === 0
      );
    default:
      return false;
  }
}

function hasCoherentScenarioTallyProjection(input: {
  readonly scenarioId: string;
  readonly verifiedTally: readonly [number, number, number, number, number];
  readonly counts: Readonly<Record<VoteChoice, number>>;
  readonly tamperSummary?: PublicTamperSummaryProjection | undefined;
}): boolean {
  const verifiedCounts: Readonly<Record<VoteChoice, number>> = {
    A: input.verifiedTally[0],
    B: input.verifiedTally[1],
    C: input.verifiedTally[2],
    D: input.verifiedTally[3],
    E: input.verifiedTally[4],
  };
  const deltas = VOTE_CHOICES.map((choice) => input.counts[choice] - verifiedCounts[choice]);
  switch (input.scenarioId) {
    case 'S0':
    case 'S1':
    case 'S3':
      return deltas.every((delta) => delta === 0);
    case 'S2':
    case 'S4': {
      const removedChoices = VOTE_CHOICES.filter((_choice, index) => deltas[index] === -1);
      const addedChoices = VOTE_CHOICES.filter((_choice, index) => deltas[index] === 1);
      if (
        removedChoices.length !== 1 ||
        addedChoices.length !== 1 ||
        deltas.some((delta) => delta !== -1 && delta !== 0 && delta !== 1)
      ) {
        return false;
      }
      return input.scenarioId === 'S4' || input.tamperSummary?.userRecountedTo === addedChoices[0];
    }
    case 'S5':
      return deltas.every((delta) => delta === 0);
    default:
      return false;
  }
}

/** Admits the scenario/tally facts shared by finalization and verification projections. */
export function hasCoherentPublicScenarioTamperCoreProjection(input: {
  readonly scenarioId: string;
  readonly tamperDetected: boolean;
  readonly tamperedCount: number;
  readonly proof: {
    readonly excludedSlots: number;
    readonly rejectedRecords: number;
    readonly verifiedTally: readonly [number, number, number, number, number];
  };
  readonly counts: Readonly<Record<VoteChoice, number>>;
  readonly tamperSummary?: PublicTamperSummaryProjection | undefined;
}): boolean {
  if (
    !hasCanonicalScenarioTamperSummary({
      scenarioId: input.scenarioId,
      excludedSlots: input.proof.excludedSlots,
      tamperSummary: input.tamperSummary,
    }) ||
    !hasCoherentScenarioTallyProjection({
      scenarioId: input.scenarioId,
      verifiedTally: input.proof.verifiedTally,
      counts: input.counts,
      tamperSummary: input.tamperSummary,
    })
  ) {
    return false;
  }

  const scenarioTamperCount = resolveScenarioTamperCount(input.tamperSummary);
  if (
    input.tamperedCount !== Math.max(input.proof.excludedSlots, scenarioTamperCount) ||
    input.tamperDetected !==
      resolveFinalizationTamperDetected({
        excludedSlots: input.proof.excludedSlots,
        rejectedRecords: input.proof.rejectedRecords,
        scenarioTamperCount,
      })
  ) {
    return false;
  }

  return true;
}

/** Admits the verification resource's scenario facts and bot-vote projection. */
export function hasCoherentPublicTamperScenarioProjection(
  input: Parameters<typeof hasCoherentPublicScenarioTamperCoreProjection>[0] & {
    readonly botVotesSummary?: PublicBotVotesSummaryProjection | undefined;
  },
): boolean {
  if (!hasCoherentPublicScenarioTamperCoreProjection(input)) {
    return false;
  }

  const affectedBotIds = input.tamperSummary?.affectedBotIds ?? [];
  const requiresBotSummary = input.scenarioId === 'S3' || input.scenarioId === 'S4';
  if (!requiresBotSummary) {
    return input.botVotesSummary === undefined;
  }
  const botVotesSummary = input.botVotesSummary;
  return (
    botVotesSummary !== undefined &&
    botVotesSummary.total === BOT_COUNT &&
    botVotesSummary.source === 'scenario_simulation' &&
    hasExactNumberSequence(botVotesSummary.affectedBotIds ?? [], affectedBotIds)
  );
}
