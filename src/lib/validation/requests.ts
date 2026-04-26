import { VOTE_CHOICES, BOT_COUNT } from '@/shared/constants';

/**
 * Validate commitment format
 */
export function validateCommitment(commitment: unknown): boolean {
  if (!commitment || typeof commitment !== 'string') {
    return false;
  }

  // Accept hex format or numeric string
  const hexPattern = /^(0x)?[0-9a-fA-F]+$/;
  const numericPattern = /^[0-9]+$/;

  return commitment.length > 0 && (hexPattern.test(commitment) || numericPattern.test(commitment));
}

/**
 * Validate session ID format
 */
export function validateSessionId(sessionId: unknown): boolean {
  if (!sessionId || typeof sessionId !== 'string') {
    return false;
  }

  // Accept hex format (32 chars) or UUID format
  const hexPattern = /^[0-9a-fA-F]{32,}$/;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  return hexPattern.test(sessionId) || uuidPattern.test(sessionId);
}

/**
 * Validate vote choice
 */
export function validateVoteChoice(choice: unknown): boolean {
  return typeof choice === 'string' && VOTE_CHOICES.some((vote) => vote === choice);
}

/**
 * Validate bot ID
 */
export function validateBotId(botId: unknown): boolean {
  const id = typeof botId === 'string' ? parseInt(botId, 10) : botId;

  if (typeof id !== 'number' || isNaN(id)) {
    return false;
  }

  return id >= 1 && id <= BOT_COUNT;
}
