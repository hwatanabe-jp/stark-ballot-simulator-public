import { expect, type Page, type Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class HomePage extends BasePage {
  readonly startButton: Locator;

  constructor(page: Page) {
    super(page);
    this.startButton = page.locator('button', { hasText: /^(Start|開始)$/ });
  }

  async clickStart(): Promise<void> {
    await this.startButton.click();
    // Wait for navigation to vote page
    await this.page.waitForURL('**/vote', { waitUntil: 'domcontentloaded' });
    await expect(this.page.getByTestId('vote-option-A')).toBeVisible();
  }

  async waitForPageReady(): Promise<void> {
    await expect(this.startButton).toBeVisible();
    await expect(this.startButton).toBeEnabled();
  }
}
