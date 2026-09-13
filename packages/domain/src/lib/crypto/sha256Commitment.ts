/**
 * Convert vote choice letter to number
 * @param choice - Vote choice ('A'-'E')
 * @returns Number (0-4)
 */
export function choiceToNumber(choice: string): number {
  if (choice.length !== 1 || choice < 'A' || choice > 'E') {
    throw new Error('Invalid choice: must be A-E');
  }
  return choice.charCodeAt(0) - 'A'.charCodeAt(0);
}
