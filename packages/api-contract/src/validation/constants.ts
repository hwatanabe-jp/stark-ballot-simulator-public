export const VOTE_CHOICES = ['A', 'B', 'C', 'D', 'E'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];
