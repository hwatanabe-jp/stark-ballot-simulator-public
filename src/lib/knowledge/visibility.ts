import type { KnowledgeData } from './types';

export const PUBLIC_KNOWLEDGE_KEYS: ReadonlyArray<keyof KnowledgeData> = [
  'tally.counts',
  'tally.totalVotes',
  'tally.tamperedCount',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'validVotes',
  'excludedSlots',
  'totalExpected',
  'bulletinRoot',
  'treeSize',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'inputCommitment',
  'imageId',
  'receiptPublication',
];

export const RESULT_KNOWLEDGE_KEYS: ReadonlyArray<keyof KnowledgeData> = ['proofBundleStatus'];

export const VERIFY_MY_KNOWLEDGE_KEYS: ReadonlyArray<keyof KnowledgeData> = [
  'electionId',
  'user.choice',
  'user.random',
  'user.commitment',
  'user.voteId',
  'user.voteReceipt',
  'user.merklePath',
  ...PUBLIC_KNOWLEDGE_KEYS,
  ...RESULT_KNOWLEDGE_KEYS,
];

export const VERIFY_BOT_KNOWLEDGE_KEYS: ReadonlyArray<keyof KnowledgeData> = [
  'bot.id',
  'bot.choice',
  'bot.random',
  'bot.commitment',
  'bot.voteId',
  'bot.bulletinIndex',
  'bot.bulletinRootAtCast',
  'bot.voteTimestamp',
  'bot.merklePath',
  'bot.verification.steps',
  ...PUBLIC_KNOWLEDGE_KEYS,
];

export const HIDDEN_KNOWLEDGE_KEYS: ReadonlyArray<keyof KnowledgeData> = [
  'sessionId',
  'user.voteTimestamp',
  'scenarioId',
  'verification.steps',
  'verification.reportSummary',
];

// Keys that should only be surfaced after verification starts
export const VERIFICATION_GATED_KEYS: ReadonlyArray<keyof KnowledgeData> = ['user.voteReceipt', 'user.merklePath'];
