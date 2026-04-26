import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class ResultPage extends BasePage {
  readonly title: Locator;
  readonly startVerificationButton: Locator;
  readonly totalVotes: Locator;
  readonly tallyValues: Record<'A' | 'B' | 'C' | 'D' | 'E', Locator>;

  constructor(page: Page) {
    super(page);
    this.title = page.locator('h1');
    this.startVerificationButton = page.getByTestId('start-verification');
    this.totalVotes = page.getByTestId('total-votes');
    this.tallyValues = {
      A: page.getByTestId('tally-value-A'),
      B: page.getByTestId('tally-value-B'),
      C: page.getByTestId('tally-value-C'),
      D: page.getByTestId('tally-value-D'),
      E: page.getByTestId('tally-value-E'),
    };
  }

  async waitForPageReady(): Promise<void> {
    await this.startVerificationButton.waitFor({ state: 'visible', timeout: 10000 });
    await this.tallyValues.A.waitFor({ state: 'visible', timeout: 10000 });
  }

  async getTallyCounts(): Promise<number[]> {
    const values: number[] = [];
    for (const option of ['A', 'B', 'C', 'D', 'E'] as const) {
      const text = (await this.tallyValues[option].textContent()) || '0';
      const numericText = text.replace(/\D+/g, '');
      values.push(Number.parseInt(numericText || '0', 10));
    }
    return values;
  }

  async getTotalVotes(): Promise<number> {
    const text = (await this.totalVotes.textContent()) || '0';
    const numericText = text.replace(/\D+/g, '');
    return Number.parseInt(numericText || '0', 10);
  }

  async startVerification(): Promise<void> {
    await this.startVerificationButton.click();
    await this.page.waitForURL('**/verify', { waitUntil: 'domcontentloaded' });
  }
}
