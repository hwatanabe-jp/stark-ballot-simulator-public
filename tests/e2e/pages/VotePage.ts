import type { Page, Locator } from '@playwright/test';
import { getStringProperty, isRecord } from '@stark-ballot/validation/unknown-value-guards';
import { BasePage } from './BasePage';

type VoteChoice = 'A' | 'B' | 'C' | 'D' | 'E';

export class VotePage extends BasePage {
  readonly voteButton: Locator;
  readonly choiceRadios: Record<VoteChoice, Locator>;

  constructor(page: Page) {
    super(page);
    this.voteButton = page.getByTestId('submit-vote');

    // Initialize choice labels via data-testid for stable clicks
    this.choiceRadios = {
      A: page.getByTestId('vote-option-A'),
      B: page.getByTestId('vote-option-B'),
      C: page.getByTestId('vote-option-C'),
      D: page.getByTestId('vote-option-D'),
      E: page.getByTestId('vote-option-E'),
    };
  }

  private async readSessionRecord(): Promise<Record<string, unknown> | null> {
    const sessionData = await this.page.evaluate<string | null>(() => localStorage.getItem('starkBallotSession'));
    if (!sessionData) {
      return null;
    }
    const payload: unknown = JSON.parse(sessionData);
    return isRecord(payload) ? payload : null;
  }

  async selectChoice(choice: VoteChoice): Promise<void> {
    await this.choiceRadios[choice].click();
    // Verify selection
    await this.page.waitForFunction(
      ({ choice }) => {
        const radio = document.querySelector(`input[type="radio"][value="${choice}"]`);
        return radio instanceof HTMLInputElement && radio.checked;
      },
      { choice },
    );
  }

  async submitVote(): Promise<void> {
    await this.voteButton.click();
    await this.page.waitForURL('**/vote#waiting', { timeout: 5000 });
  }

  async waitForBotVotingComplete(): Promise<void> {
    console.log('    [VotePage] Waiting for bot voting to complete...');
    await this.page.waitForURL('**/aggregate', {
      timeout: 45000,
      waitUntil: 'domcontentloaded',
    });
    console.log('    [VotePage] Successfully navigated to aggregate page');
  }

  async getVoteCommitment(): Promise<string> {
    const sessionRecord = await this.readSessionRecord();
    return getStringProperty(sessionRecord, 'myCommit') ?? '';
  }
}
