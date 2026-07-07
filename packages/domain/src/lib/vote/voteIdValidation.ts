/**
 * Validate if a string is a valid vote ID.
 */
export function isValidVoteId(voteId: string): boolean {
  if (voteId.includes('..') || voteId.includes('/') || voteId.includes('\\')) {
    return false;
  }

  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(voteId);
}
