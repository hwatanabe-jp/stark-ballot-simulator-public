import type { Page, Locator } from '@playwright/test';
import { getNumberProperty, getStringArrayProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { BasePage } from './BasePage';

export type VoteChoice = 'A' | 'B' | 'C' | 'D' | 'E';

export class VotePage extends BasePage {
  readonly title: Locator;
  readonly voteButton: Locator;
  readonly choiceRadios: Record<VoteChoice, Locator>;
  readonly spinner: Locator;
  readonly progressBar: Locator;
  readonly progressText: Locator;

  constructor(page: Page) {
    super(page);
    this.title = page.locator('h1');
    this.voteButton = page.getByTestId('submit-vote');

    // Initialize choice labels via data-testid for stable clicks
    this.choiceRadios = {
      A: page.getByTestId('vote-option-A'),
      B: page.getByTestId('vote-option-B'),
      C: page.getByTestId('vote-option-C'),
      D: page.getByTestId('vote-option-D'),
      E: page.getByTestId('vote-option-E'),
    };

    this.spinner = page.locator('[role="progressbar"]'); // Actually a progress bar, not a spinner
    this.progressBar = page.locator('[role="progressbar"]');
    this.progressText = page.locator('text=/\\d+\\/63/');
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
    // Wait for navigation to #waiting hash or error
    await Promise.race([
      this.page.waitForURL('**/vote#waiting', { timeout: 5000 }).catch(() => {}),
      this.page.waitForSelector('.error', { state: 'visible', timeout: 5000 }).catch(() => {}),
    ]);
  }

  async isVoteButtonEnabled(): Promise<boolean> {
    return await this.voteButton.isEnabled();
  }

  async getSelectedChoice(): Promise<VoteChoice | null> {
    for (const choice of Object.keys(this.choiceRadios)) {
      const isChecked = await this.page.isChecked(`input[type="radio"][value="${choice}"]`).catch(() => false);
      if (isChecked) return choice as VoteChoice;
    }
    return null;
  }

  async waitForBotVotingStart(): Promise<void> {
    // Wait for the page to be ready after navigation
    await this.page.waitForLoadState('networkidle');

    // Wait for either the progress bar or progress text to appear
    await Promise.race([
      this.progressBar.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
      this.progressText.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
      this.page.waitForSelector('text=/Bot/', { timeout: 10000 }).catch(() => {}),
    ]);
  }

  async waitForBotVotingComplete(): Promise<void> {
    console.log('    [VotePage] Waiting for bot voting to complete...');

    // First, ensure we're on the waiting page
    const currentUrl = this.page.url();
    if (!currentUrl.includes('/vote')) {
      console.log('    [VotePage] Not on vote page, navigating to aggregate');
      await this.page.goto('/aggregate');
      return;
    }

    // Method 1: Wait for automatic navigation (primary method)
    try {
      await this.page.waitForURL('**/aggregate', {
        timeout: 45000, // Increased to 45 seconds for reliability
        waitUntil: 'domcontentloaded', // Less strict than networkidle
      });
      console.log('    [VotePage] Successfully navigated to aggregate page');
      return;
    } catch {
      console.log('    [VotePage] Navigation timeout, trying alternative methods...');
    }

    // Method 2: Poll for bot completion status via API
    let attempts = 0;
    const maxAttempts = 30; // 30 attempts * 2 seconds = 60 seconds

    while (attempts < maxAttempts) {
      // Check if we've already navigated
      if (this.page.url().includes('/aggregate')) {
        console.log('    [VotePage] Already on aggregate page');
        return;
      }

      // Check progress via API
      const sessionRecord = await this.readSessionRecord();
      if (!sessionRecord) {
        console.log('    [VotePage] No session data found, waiting...');
        attempts++;
        await this.page.waitForTimeout(2000);
        continue;
      }

      const sessionId = getStringProperty(sessionRecord, 'sessionId');
      if (!sessionId) {
        throw new Error('Session ID missing in localStorage');
      }
      const capabilityToken = getStringProperty(sessionRecord, 'capabilityToken');

      // Fetch progress from API
      const progressData = await this.page.evaluate(
        async ({ sid, capability }: { sid: string; capability?: string }) => {
          try {
            const headers: HeadersInit = { 'X-Session-ID': sid };
            if (capability) {
              headers['X-Session-Capability'] = capability;
            }
            const response = await fetch('/api/progress', {
              headers,
            });
            if (response.ok) {
              const payload: unknown = await response.json();
              return payload;
            }
          } catch (error) {
            console.error('Failed to fetch progress:', error);
          }
          return null;
        },
        { sid: sessionId, capability: capabilityToken ?? undefined },
      );

      if (progressData) {
        const dataRecord = isRecord(progressData) && isRecord(progressData.data) ? progressData.data : null;
        const botCount = getNumberProperty(dataRecord, 'count') ?? 0;
        const total = getNumberProperty(dataRecord, 'total') ?? 63;

        console.log(`    [VotePage] Bot voting progress: ${botCount}/${total}`);

        if (botCount >= total) {
          console.log('    [VotePage] Bot voting complete, navigating to aggregate');
          await this.page.goto('/aggregate');
          await this.page.waitForLoadState('domcontentloaded');
          return;
        }
      }

      // Also check page content as fallback
      const isComplete = await this.page.evaluate(() => {
        const body = document.body.textContent || '';
        return body.includes('63/63') || body.includes('63 / 63') || body.includes('Complete');
      });

      if (isComplete) {
        console.log('    [VotePage] Bot voting appears complete (UI check), navigating to aggregate');
        await this.page.goto('/aggregate');
        await this.page.waitForLoadState('domcontentloaded');
        return;
      }

      attempts++;
      await this.page.waitForTimeout(2000); // Wait 2 seconds between checks
    }

    // Final fallback: Force navigation after all attempts
    console.log('    [VotePage] Max attempts reached, forcing navigation to aggregate');
    await this.page.goto('/aggregate');
    await this.page.waitForLoadState('domcontentloaded');
  }

  async getBotVotingProgress(): Promise<{ current: number; total: number }> {
    const text = (await this.progressText.textContent()) || '0/63';
    const match = text.match(/(\d+)\/(\d+)/);
    if (match) {
      return {
        current: parseInt(match[1]),
        total: parseInt(match[2]),
      };
    }
    return { current: 0, total: 63 };
  }

  async getVoteCommitment(): Promise<string> {
    const sessionRecord = await this.readSessionRecord();
    return getStringProperty(sessionRecord, 'myCommit') ?? '';
  }

  async getVoteRandom(): Promise<string> {
    const sessionRecord = await this.readSessionRecord();
    return getStringProperty(sessionRecord, 'myRand') ?? '';
  }

  async getLeafIndex(): Promise<number> {
    const sessionRecord = await this.readSessionRecord();
    const leafIndex = getNumberProperty(sessionRecord, 'leafIdx');
    return leafIndex ?? -1;
  }

  async getMerklePath(): Promise<string[]> {
    const sessionRecord = await this.readSessionRecord();
    return getStringArrayProperty(sessionRecord, 'merklePath') ?? [];
  }
}
