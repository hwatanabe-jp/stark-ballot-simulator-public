export const VOTE_CHOICES = ['A', 'B', 'C', 'D', 'E'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

export const BOT_COUNT = 63;
export const MERKLE_TREE_DEPTH = 6;
