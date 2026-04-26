import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class HomePage extends BasePage {
  readonly title: Locator;
  readonly startButton: Locator;
  readonly description: Locator;
  readonly languageIndicator: Locator;

  constructor(page: Page) {
    super(page);
    this.title = page.locator('h1');
    this.startButton = page.locator('button', { hasText: /^(Start|開始)$/ });
    this.description = page.locator('p').first();
    this.languageIndicator = page.locator('text=/🇯🇵|🇬🇧/');
  }

  async clickStart(): Promise<void> {
    await this.startButton.click();
    // Wait for navigation to vote page
    await this.page.waitForURL('**/vote', { waitUntil: 'networkidle' });
  }

  async isStartButtonEnabled(): Promise<boolean> {
    return await this.startButton.isEnabled();
  }

  async getPageTitle(): Promise<string> {
    return (await this.title.textContent()) || '';
  }

  async getLanguage(): Promise<'ja' | 'en'> {
    const titleText = await this.getPageTitle();
    return /[ぁ-んァ-ン一-龥]/.test(titleText) ? 'ja' : 'en';
  }

  async waitForPageReady(): Promise<void> {
    await this.page.waitForSelector('button', { state: 'visible' });
    await this.waitForPageLoad();
  }
}
