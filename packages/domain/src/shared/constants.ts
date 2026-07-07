// 投票の選択肢
export const VOTE_CHOICES = ['A', 'B', 'C', 'D', 'E'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

// ボット数
export const BOT_COUNT = 63;

// Merkle Tree設定
export const MERKLE_TREE_DEPTH = 6; // 2^6 = 64 leaves (64票に十分)
