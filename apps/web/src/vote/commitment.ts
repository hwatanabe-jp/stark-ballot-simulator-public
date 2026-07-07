import type { VoteChoice } from '@stark-ballot/verification/shared/constants';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function choiceToNumber(choice: VoteChoice): number {
  return choice.charCodeAt(0) - 'A'.charCodeAt(0);
}

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

  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const randomValue =
    '0x' +
    Array.from(randomBytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

  return Promise.resolve({
    commitment: computeCommitment(electionId, choiceToNumber(vote), randomValue),
    randomValue,
  });
}
