import type { VoteChoice } from '@/shared/constants';

// ボット情報
export interface BotData {
  id: number;
  vote: VoteChoice;
  random: string;
  commitment: string;
  voteId?: string;
  timestamp?: number;
  proof?: {
    leafIndex: number;
    treeSize: number;
    merklePath: string[];
    bulletinRootAtCast: string;
  };
}

// APIレスポンス
export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  code?: string;
  message?: string;
  nextAvailableAt?: number | string;
  remainingExecutions?: number;
  retryAfter?: number;
}
