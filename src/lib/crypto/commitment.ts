import type { VoteChoice } from '@/lib/session/types';
import { computeCommitment } from '@/lib/zkvm/types';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateCommitment(
  vote: VoteChoice,
  electionId: string,
): Promise<{
  commitment: string;
  randomValue: string;
}> {
  if (!UUID_V4_REGEX.test(electionId)) {
    return Promise.reject(new Error('Invalid electionId'));
  }

  // Generate random value
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const randomValue =
    '0x' +
    Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  // Convert vote to numeric value (A=0, B=1, C=2, D=3, E=4)
  const voteValue = vote.charCodeAt(0) - 'A'.charCodeAt(0);

  const commitment = computeCommitment(electionId, voteValue, randomValue);

  return Promise.resolve({
    commitment,
    randomValue,
  });
}
