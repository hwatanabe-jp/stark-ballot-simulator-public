import type { Page, Locator } from '@playwright/test';

export class BasePage {
  readonly page: Page;
  readonly sidebar: Locator;
  readonly sidebarSteps: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = page.locator('aside');
    this.sidebarSteps = page.locator('aside').locator('li');
  }

  async goto(path = ''): Promise<void> {
    await this.page.goto(path);
  }

  async waitForPageLoad(): Promise<void> {
    await this.page.waitForLoadState('networkidle');
  }

  async getSidebarStepStatus(stepName: string): Promise<'completed' | 'active' | 'inactive'> {
    const step = this.sidebarSteps.filter({ hasText: stepName }).first();

    // Check for different states based on CSS classes
    const classes = (await step.getAttribute('class')) || '';

    if (classes.includes('text-blue-600') || classes.includes('font-bold')) {
      return 'active';
    } else if (classes.includes('text-blue-400')) {
      return 'completed';
    } else {
      return 'inactive';
    }
  }

  async waitForSessionId(): Promise<string> {
    // Wait for session ID to be available in localStorage
    await this.page.waitForFunction(() => {
      const sessionId = localStorage.getItem('sessionId');
      return sessionId !== null && sessionId !== '';
    });

    return await this.page.evaluate(() => localStorage.getItem('sessionId') || '');
  }

  async getLocalStorageItem(key: string): Promise<string | null> {
    return await this.page.evaluate((k) => localStorage.getItem(k), key);
  }

  async setLocalStorageItem(key: string, value: string): Promise<void> {
    await this.page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value });
  }

  async clearLocalStorage(): Promise<void> {
    await this.page.evaluate(() => localStorage.clear());
  }

  async takeScreenshot(name: string): Promise<void> {
    await this.page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: true });
  }
}
